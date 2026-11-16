import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  JumboSessionError,
  bffRejection,
  ensureJumboSession,
  getConfiguredSessionExecutor,
  jumboAddToCart,
  jumboGetCart,
  missingSkus,
  setSessionExecutorForTests,
  type SessionExecutor,
} from "../../src/adapters/jumboSessionExec.js";
import { parseCart } from "../../src/adapters/cencosudCart.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const cartFixtureFile = JSON.parse(
  readFileSync(join(fixturesDir, "cart-2026-07-07.json"), "utf-8")
);
const cartFixture = cartFixtureFile.cart;

/**
 * Navegador falso: responde según qué snippet le llega, igual que lo haría el
 * perfil real. Registra los snippets para poder afirmar qué se ejecutó.
 */
function fakeExec(opts: {
  loggedIn?: boolean;
  branch?: string | null;
  bff?: unknown;
}): SessionExecutor & { snippets: string[] } {
  const snippets: string[] = [];
  return {
    snippets,
    async evaluate<T>(_pageUrl: string, snippet: string): Promise<T> {
      snippets.push(snippet);
      // Primero el BFF: los snippets del carro también leen sessionDataToken
      // (para el header Authorization), así que no sirve clasificar por eso.
      if (snippet.includes("ecomm.cencosud.com")) return (opts.bff ?? cartFixture) as T;
      if (snippet.includes('localStorage.getItem("sessionDataToken")')) {
        return (opts.loggedIn ?? true) as T;
      }
      if (snippet.includes("delivery-method-state")) {
        const b = opts.branch === undefined ? "jumboclj775" : opts.branch;
        return (
          b
            ? { found: true, branchId: b, candidates: [b] }
            : { found: false, hint: "Elige tu comuna." }
        ) as T;
      }
      throw new Error(`snippet inesperado: ${snippet.slice(0, 80)}`);
    },
  };
}

afterEach(() => {
  setSessionExecutorForTests(undefined);
  delete process.env.SUPERMERCADOS_SESSION_PROFILE;
});

describe("bffRejection", () => {
  it("detecta el rechazo del BFF ({ message } sin datos)", () => {
    expect(bffRejection({ message: "Invalid authentication credentials" })).toBe(
      "Invalid authentication credentials"
    );
  });

  it("no confunde un carro válido con un rechazo", () => {
    expect(bffRejection(cartFixture)).toBeUndefined();
    expect(bffRejection({ items: [], message: "ok" })).toBeUndefined();
    expect(bffRejection(null)).toBeUndefined();
  });
});

describe("ensureJumboSession", () => {
  it("sin token en el perfil, pide iniciar sesión con session:login", async () => {
    const exec = fakeExec({ loggedIn: false });
    const err = await ensureJumboSession(exec).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JumboSessionError);
    expect((err as JumboSessionError).kind).toBe("not_logged_in");
    expect((err as JumboSessionError).action).toContain("npm run session:login");
  });

  it("descubre la sucursal de la sesión si no viene", async () => {
    const exec = fakeExec({ branch: "jumboclj512" });
    expect(await ensureJumboSession(exec)).toEqual({ branchId: "jumboclj512" });
  });

  it("respeta la sucursal explícita sin descubrir", async () => {
    const exec = fakeExec({});
    expect(await ensureJumboSession(exec, "jumboclj001")).toEqual({
      branchId: "jumboclj001",
    });
    expect(exec.snippets.some((s) => s.includes("delivery-method-state"))).toBe(false);
  });

  it("sin sucursal elegida, devuelve error accionable", async () => {
    const exec = fakeExec({ branch: null });
    const err = await ensureJumboSession(exec).catch((e: unknown) => e);
    expect((err as JumboSessionError).kind).toBe("no_branch");
  });
});

describe("jumboAddToCart", () => {
  it("ejecuta el PATCH de producción con la sucursal descubierta", async () => {
    const exec = fakeExec({ branch: "jumboclj775" });
    const done = await jumboAddToCart(exec, [{ skuId: "6697", quantity: 2 }]);
    expect(done.branchId).toBe("jumboclj775");

    // Después del PATCH lee el carro completo (la respuesta del PATCH no trae
    // el detalle de los ítems).
    expect(exec.snippets.some((s) => s.includes("/cart?store=jumboclj775"))).toBe(true);
    expect(done.notAdded).toEqual(["6697"]); // la fixture no tiene ese sku

    const patch = exec.snippets.find((s) => s.includes("/cart/items"))!;
    expect(patch).toContain('"PATCH"');
    expect(patch).toContain('"skuId":"6697"');
    expect(patch).toContain('"quantity":2');
    expect(patch).toContain('"store":"jumboclj775"');
    // apiKey del servicio cart, no la de lists (bug de la 1.4.4).
    expect(patch).toContain("be-reg-groceries-jumbo-cart-");

    // Lo devuelto es el carro crudo que el parser de producción entiende.
    const cart = parseCart(done.raw, "jumbo");
    expect(cart.items.length).toBeGreaterThan(0);
  });

  it("si el BFF rechaza por credenciales, pide renovar la sesión", async () => {
    const exec = fakeExec({ bff: { message: "Invalid authentication credentials" } });
    const err = await jumboAddToCart(exec, [{ skuId: "1", quantity: 1 }]).catch(
      (e: unknown) => e
    );
    expect((err as JumboSessionError).kind).toBe("bff_rejected");
    expect((err as JumboSessionError).action).toContain("session:login");
  });
});

describe("missingSkus", () => {
  it("lista los skuId pedidos que Jumbo no dejó en el carro", () => {
    const raw = { items: [{ skuId: "1" }, { productId: "3" }] };
    expect(missingSkus([{ skuId: "1" }, { skuId: "2" }, { skuId: "3" }], raw)).toEqual([
      "2",
    ]);
  });
});

describe("jumboGetCart", () => {
  it("lee el carro con la sucursal en la query", async () => {
    const exec = fakeExec({ branch: "jumboclj775" });
    await jumboGetCart(exec);
    const get = exec.snippets.find((s) => s.includes("/cart?"))!;
    expect(get).toContain("store=jumboclj775&simulationTotals=true");
  });
});

describe("getConfiguredSessionExecutor", () => {
  it("sin SUPERMERCADOS_SESSION_PROFILE no hay puente (flujo manual)", () => {
    expect(getConfiguredSessionExecutor()).toBeUndefined();
  });

  it("con el perfil configurado, crea el puente sin lanzar el navegador", () => {
    process.env.SUPERMERCADOS_SESSION_PROFILE = "/tmp/perfil-de-prueba";
    const exec = getConfiguredSessionExecutor();
    expect(exec).toBeDefined();
    expect(typeof exec!.evaluate).toBe("function");
  });
});
