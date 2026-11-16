import { homedir } from "node:os";
import { join } from "node:path";
import { buildCartPatchBody } from "./cencosudCart.js";
import {
  jumboDiscoverBranchSnippet,
  jumboFetchSnippet,
  jumboMutateSnippet,
} from "./cencosudBrowser.js";
import { sharedPlaywrightBridge } from "./playwrightBridge.js";

/**
 * Ejecución automática de las tools de sesión de Jumbo (carro, sucursal) con
 * Playwright, para que el usuario no tenga que pegar el `browserSnippet` en la
 * consola.
 *
 * El modelo de seguridad no cambia: el servidor sigue sin ver credenciales. El
 * token vive en el `localStorage` de un perfil de Chrome DEDICADO donde el
 * usuario inició sesión a mano (`npm run session:login`); aquí solo se ejecutan
 * en ese navegador los mismos snippets de producción que el flujo manual le
 * pediría pegar. Del token se comprueba la existencia, nunca el valor.
 *
 * Perfil dedicado y no el Chrome diario: `launchPersistentContext` toma el lock
 * exclusivo del perfil (habría que cerrar Chrome) y con un perfil grande el
 * lanzamiento ni siquiera completa (verificado en el smoke de sesión, #12).
 */
export interface SessionExecutor {
  /** Corre `snippet` en una página del sitio (mismo origen) y devuelve su valor. */
  evaluate<T>(pageUrl: string, snippet: string): Promise<T>;
}

/** Perfil por defecto: el mismo que usa `npm run session:login` y el smoke. */
export function defaultSessionProfile(): string {
  return join(homedir(), ".supermercados-smoke-profile");
}

/** Error de sesión con el siguiente paso concreto para el usuario. */
export class JumboSessionError extends Error {
  constructor(
    readonly kind: "not_logged_in" | "no_branch" | "bff_rejected",
    message: string,
    readonly action: string
  ) {
    super(message);
    this.name = "JumboSessionError";
  }
}

/**
 * El snippet hace `r.json()` sin mirar el status, así que un rechazo del BFF
 * llega como `{ message: "..." }`. Devuelve ese mensaje, o undefined si la
 * respuesta tiene forma de datos.
 *  - 401 "Invalid authentication credentials" → sesión vencida o apiKey rotada.
 *  - 403 "You cannot consume this service"    → apiKey de otro servicio.
 */
export function bffRejection(raw: unknown): string | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const r = raw as { message?: unknown; items?: unknown; lists?: unknown };
  if (typeof r.message !== "string") return undefined;
  // Un carro/lista válido podría traer un `message` informativo: solo es
  // rechazo si NO trae los datos.
  if (r.items !== undefined || r.lists !== undefined) return undefined;
  return r.message;
}

function assertAccepted(raw: unknown, what: string): void {
  const rejected = bffRejection(raw);
  if (rejected === undefined) return;
  const expired = /credential|unauthori|token|expired/i.test(rejected);
  throw new JumboSessionError(
    "bff_rejected",
    `Jumbo rechazó ${what}: "${rejected}".`,
    expired
      ? "La sesión del perfil dedicado venció. Vuelve a iniciar sesión con `npm run session:login` y reintenta."
      : "Si se repite, Jumbo pudo rotar las apiKey del BFF: corre `npm run test:session` para diagnosticarlo."
  );
}

/**
 * Comprueba que el perfil tenga sesión y resuelve la sucursal: la explícita si
 * viene, si no la que eligió el usuario en el sitio.
 */
export async function ensureJumboSession(
  exec: SessionExecutor,
  branchId?: string
): Promise<{ branchId: string }> {
  const loggedIn = await exec.evaluate<boolean>(
    "/",
    `!!localStorage.getItem("sessionDataToken")`
  );
  if (!loggedIn) {
    throw new JumboSessionError(
      "not_logged_in",
      "El perfil de Chrome del puente no tiene sesión iniciada en jumbo.cl.",
      "Corre `npm run session:login` en la carpeta del MCP, inicia sesión en la ventana que se abre " +
        "y elige tu comuna o tienda. Después reintenta."
    );
  }
  if (branchId) return { branchId };
  const found = await discoverJumboBranch(exec);
  if (!found.found || !found.branchId) {
    throw new JumboSessionError(
      "no_branch",
      "La sesión no tiene una sucursal elegida.",
      found.hint ??
        "Elige tu comuna o tienda en jumbo.cl dentro de la ventana del puente (o con `npm run session:login`)."
    );
  }
  return { branchId: found.branchId };
}

export interface DiscoveredBranch {
  found: boolean;
  branchId?: string;
  candidates?: string[];
  hint?: string;
}

/** Ejecuta el snippet de `discover_branch` en el navegador del puente. */
export function discoverJumboBranch(exec: SessionExecutor): Promise<DiscoveredBranch> {
  return exec.evaluate<DiscoveredBranch>("/", jumboDiscoverBranchSnippet());
}

export type CartLineInput = Parameters<typeof buildCartPatchBody>[0][number];

/**
 * PATCH /cart/items con el snippet de producción y luego GET /cart.
 *
 * El GET no es redundante (verificado contra el sitio, 2026-11-16): la
 * respuesta del PATCH trae el conteo (`itemsQuantity`) pero NO el detalle de
 * los ítems, así que parsearla daba un carro vacío con total 0. Además Jumbo
 * descarta EN SILENCIO las líneas sin stock en la sucursal (7 de 33 en la
 * primera prueba real), y solo el carro completo permite decir cuáles.
 */
export async function jumboAddToCart(
  exec: SessionExecutor,
  items: CartLineInput[],
  branchId?: string
): Promise<{ branchId: string; raw: unknown; notAdded: string[] }> {
  const session = await ensureJumboSession(exec, branchId);
  const body = buildCartPatchBody(items, session.branchId);
  const patched = await exec.evaluate<unknown>(
    "/",
    jumboMutateSnippet("/cart/items", "PATCH", body, "cart")
  );
  assertAccepted(patched, "el cambio en el carro");
  const { raw } = await jumboGetCart(exec, session.branchId);
  return { branchId: session.branchId, raw, notAdded: missingSkus(items, raw) };
}

/** skuIds pedidos que no aparecen en el carro devuelto por Jumbo. */
export function missingSkus(
  items: Array<{ skuId: string }>,
  rawCart: unknown
): string[] {
  const inCart = new Set(
    (
      (rawCart as { items?: Array<{ skuId?: unknown; productId?: unknown }> })?.items ??
      []
    )
      .flatMap((it) => [it.skuId, it.productId])
      .filter((v) => v !== undefined && v !== null)
      .map(String)
  );
  return items.map((i) => i.skuId).filter((id) => !inCart.has(id));
}

/** GET /cart con el snippet de producción; devuelve el carro crudo. */
export async function jumboGetCart(
  exec: SessionExecutor,
  branchId?: string
): Promise<{ branchId: string; raw: unknown }> {
  const session = await ensureJumboSession(exec, branchId);
  const path = `/cart?store=${session.branchId}&simulationTotals=true`;
  const raw = await exec.evaluate<unknown>("/", jumboFetchSnippet(path, "cart"));
  assertAccepted(raw, "la lectura del carro");
  return { branchId: session.branchId, raw };
}

// --- Puente de sesión configurado por entorno (singleton perezoso) ---

// undefined = aún no resuelto; null = resuelto a "no configurado".
let cached: SessionExecutor | null | undefined;

/**
 * Ejecutor de sesión configurado por entorno, o undefined (flujo manual con
 * `browserSnippet`, como siempre).
 *
 * Activación (sección `env` de la config del cliente MCP):
 *   SUPERMERCADOS_SESSION_PROFILE=/ruta/al/perfil   (requerida; "default" usa
 *                                                     ~/.supermercados-smoke-profile)
 *   SUPERMERCADOS_PLAYWRIGHT_CHANNEL=chrome|msedge|chromium (opcional, default
 *     chrome; "chromium" usa el navegador que baja `playwright install chromium`)
 *   SUPERMERCADOS_SESSION_HEADLESS=1                 (opcional)
 */
export function getConfiguredSessionExecutor(): SessionExecutor | undefined {
  if (cached !== undefined) return cached ?? undefined;
  const env = process.env.SUPERMERCADOS_SESSION_PROFILE?.trim();
  if (!env) {
    cached = null;
    return undefined;
  }
  const userDataDir = env === "default" ? defaultSessionProfile() : env;
  // "chromium" = el Chromium que descarga Playwright (sin Chrome instalado).
  const channelEnv = process.env.SUPERMERCADOS_PLAYWRIGHT_CHANNEL?.trim();
  const channel =
    channelEnv === "chromium"
      ? undefined
      : channelEnv === "msedge"
        ? "msedge"
        : "chrome";
  const headless = /^(1|true|yes)$/i.test(
    process.env.SUPERMERCADOS_SESSION_HEADLESS?.trim() ?? ""
  );
  cached = sharedPlaywrightBridge({
    userDataDir,
    ...(channel ? { channel } : {}),
    headless,
  });
  return cached;
}

/**
 * Solo para tests: fija el ejecutor, `null` = "sin puente", `undefined` =
 * olvidar lo resuelto y volver a leer el entorno.
 */
export function setSessionExecutorForTests(
  exec: SessionExecutor | null | undefined
): void {
  cached = exec;
}
