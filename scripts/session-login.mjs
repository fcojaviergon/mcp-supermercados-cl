/**
 * Login inicial del perfil de sesión (`npm run session:login`).
 *
 * Abre una ventana de Chrome con un perfil DEDICADO —no el tuyo— para que
 * inicies sesión en jumbo.cl una sola vez. La sesión queda persistida ahí y la
 * reusan el puente de sesión del MCP (carro automático, con
 * SUPERMERCADOS_SESSION_PROFILE) y `npm run test:session`.
 *
 * Por qué un perfil aparte y no el tuyo: `launchPersistentContext` toma el lock
 * exclusivo del perfil, así que usar el de tu Chrome diario obliga a cerrarlo
 * en cada corrida, y sobre un perfil grande (varios GB) el lanzamiento ni
 * siquiera completa. Con un perfil dedicado el smoke arranca en segundos y tu
 * navegador no se entera. Ver issue #12.
 *
 * Este script NUNCA ve tus credenciales: las escribes tú en la ventana de
 * Chrome. Aquí solo se espera a que el token aparezca en el localStorage del
 * sitio, y se comprueba su existencia, nunca su valor.
 */
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_PROFILE = join(homedir(), ".supermercados-smoke-profile");
const sessionEnv = process.env.SUPERMERCADOS_SESSION_PROFILE?.trim();
const PROFILE =
  (sessionEnv && sessionEnv !== "default" ? sessionEnv : undefined) ||
  process.env.SUPERMERCADOS_SMOKE_PROFILE?.trim() ||
  DEFAULT_PROFILE;
// "chromium" = el Chromium de Playwright (`playwright install chromium`), para
// máquinas sin Google Chrome. Tiene que coincidir con el del server MCP.
const channelEnv = process.env.SUPERMERCADOS_PLAYWRIGHT_CHANNEL?.trim() || "chrome";
const CHANNEL = channelEnv === "chromium" ? undefined : channelEnv;
const TIMEOUT_MS = 10 * 60_000;

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  // Playwright global (npm install -g playwright): igual que el server,
  // se resuelve por ruta explícita porque import() ESM ignora NODE_PATH.
  const explicit = process.env.SUPERMERCADOS_PLAYWRIGHT_PATH?.trim();
  if (explicit) {
    try {
      ({ chromium } = createRequire(import.meta.url)(explicit));
    } catch {
      // cae al mensaje guía.
    }
  }
}
if (!chromium) {
  console.error(
    "Falta Playwright. Instálalo con:\n\n" +
      "  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-save playwright\n\n" +
      "(se salta la descarga de navegadores porque usamos el Chrome que ya tienes).\n" +
      'Si lo instalaste global, define SUPERMERCADOS_PLAYWRIGHT_PATH="$(npm root -g)/playwright".'
  );
  process.exit(1);
}

console.log(`Perfil de sesión: ${PROFILE}`);
const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  ...(CHANNEL ? { channel: CHANNEL } : {}),
  timeout: 60_000,
});

const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto("https://www.jumbo.cl/login", { waitUntil: "domcontentloaded" });

console.log("\n┌──────────────────────────────────────────────────────────────┐");
console.log("│  1. Inicia sesión en la ventana de Chrome que se abrió.       │");
console.log("│  2. Elige tu comuna o tienda (el smoke necesita la sucursal). │");
console.log("│  3. Esta ventana se cierra sola al detectar la sesión.        │");
console.log("└──────────────────────────────────────────────────────────────┘\n");
console.log("Esperando... (Ctrl+C para cancelar)");

const deadline = Date.now() + TIMEOUT_MS;
let ok = false;
while (Date.now() < deadline) {
  try {
    const state = await page.evaluate(`(() => {
      const dm = localStorage.getItem("delivery-method-state");
      const branch = (String(dm || "").match(/[a-z]{2,}cl[a-z]?\\d{2,}/i) || [])[0] || null;
      return { token: !!localStorage.getItem("sessionDataToken"), branch };
    })()`);
    if (state.token && state.branch) {
      console.log(`\n✅ Sesión detectada. Sucursal: ${state.branch}`);
      console.log(
        "   El MCP ya puede operar tu carro (con SUPERMERCADOS_SESSION_PROFILE configurado)."
      );
      ok = true;
      break;
    }
    if (state.token && !state.branch) {
      process.stdout.write("\r   Sesión OK, falta elegir comuna/tienda...      ");
    }
  } catch {
    // Navegación en curso (el evaluate corre contra un documento que se está
    // reemplazando): reintentar en el próximo ciclo.
  }
  await new Promise((r) => setTimeout(r, 2000));
}

if (!ok) console.error("\n⏱️  Se agotó la espera sin detectar la sesión.");
await ctx.close();
process.exit(ok ? 0 : 1);
