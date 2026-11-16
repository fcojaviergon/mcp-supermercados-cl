import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  CART_BFF_BASE,
  buildCartPatchBody,
  parseCart,
} from "../adapters/cencosudCart.js";
import {
  browserFetchNote,
  jumboFetchSnippet,
  jumboMutateSnippet,
} from "../adapters/cencosudBrowser.js";
import {
  JumboSessionError,
  getConfiguredSessionExecutor,
  jumboAddToCart,
  jumboGetCart,
} from "../adapters/jumboSessionExec.js";

/** Respuesta JSON de una tool. */
function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

/** Error del puente → qué pasó + qué hacer, para que el modelo lo transmita. */
function bridgeFailure(err: unknown) {
  if (err instanceof JumboSessionError) {
    return { kind: err.kind, message: err.message, action: err.action };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    kind: "bridge_error",
    message: `El puente Playwright falló: ${message}`,
    action:
      "Revisa que Chrome pueda abrirse y que el perfil no esté en uso por otra ventana del puente " +
      "(o por `npm run test:session`). Mientras tanto usa el browserSnippet a mano.",
  };
}

/**
 * Tools de carro (fase 3). El servidor MCP nunca ve el token de Jumbo (vive
 * en el navegador del usuario). Dos modos:
 *  - Puente Playwright configurado (`SUPERMERCADOS_SESSION_PROFILE`): la tool
 *    ejecuta el snippet de producción en el perfil dedicado donde el usuario
 *    inició sesión y devuelve el carro real que respondió Jumbo.
 *  - Sin puente (o si falla): arma el request exacto que el cliente debe
 *    ejecutar en su navegador logueado, y normaliza el resultado si se lo
 *    devuelven.
 */
export function registerCartTools(server: McpServer): void {
  server.registerTool(
    "add_to_cart",
    {
      title: "Agregar al carro",
      description:
        "Agrega/actualiza productos en el carro de Jumbo del usuario (la cantidad indicada REEMPLAZA la que " +
        "tenía esa línea). Si el puente Playwright de sesión está configurado, lo ejecuta directo y devuelve el " +
        'carro real que respondió Jumbo (`executed: true`, `via: "playwright"`); `branchId` es opcional y se ' +
        "descubre de la sesión. Si no, devuelve un `browserSnippet` (PATCH /cart/items) para ejecutar en una " +
        "pestaña YA LOGUEADA de www.jumbo.cl; si entregas su JSON en `rawCartResult`, lo normalizo (total, " +
        "ahorro y ahorro Prime). Acción reversible (se puede quitar del carro); no es una compra.",
      inputSchema: {
        store: z.enum(["jumbo"]).default("jumbo").describe("Cadena. Fase 3: jumbo."),
        branchId: z
          .string()
          .optional()
          .describe(
            'Sucursal de la sesión, ej. "jumboclj512". Con el puente Playwright se descubre sola; sin él es requerida (usa discover_branch).'
          ),
        items: z
          .array(
            z.object({
              skuId: z
                .string()
                .describe(
                  "ID del ítem del carro: usa el campo `id` de search_products, no el campo `sku` (que es la referencia comercial)."
                ),
              quantity: z.number().int().positive(),
              measurementUnitUn: z.string().optional(),
              unitMultiplierUn: z.number().optional(),
              itemQuantityLimit: z.number().int().optional(),
              soldBy: z.string().optional(),
            })
          )
          .min(1)
          .max(50)
          .describe("Líneas a agregar/actualizar."),
        rawCartResult: z
          .unknown()
          .optional()
          .describe(
            "JSON de la respuesta del PATCH/GET /cart, si el navegador ya ejecutó el request. Se normaliza y devuelve."
          ),
      },
    },
    async ({ store, branchId, items, rawCartResult }) => {
      if (rawCartResult !== undefined) {
        return json({
          executed: true,
          via: "manual",
          cart: parseCart(rawCartResult, store),
        });
      }

      const exec = getConfiguredSessionExecutor();
      let bridgeError: ReturnType<typeof bridgeFailure> | undefined;
      if (exec) {
        try {
          const done = await jumboAddToCart(exec, items, branchId);
          const cart = parseCart(done.raw, store);
          return json({
            executed: true,
            via: "playwright",
            note: "Jumbo aceptó el cambio: este es el carro que devolvió la tienda. No es una compra.",
            branchId: done.branchId,
            ...(done.notAdded.length || cart.unavailable?.length
              ? {
                  attention:
                    "Hay productos que no se pueden comprar en esta sucursal (cart.unavailable: quedaron " +
                    "en el carro sin stock y no suman al total) o que Jumbo no agregó (notAdded). " +
                    "Avísale al usuario y ofrece alternativas con search_products usando el branchId.",
                  ...(done.notAdded.length ? { notAdded: done.notAdded } : {}),
                }
              : {}),
            cart,
          });
        } catch (err) {
          bridgeError = bridgeFailure(err);
        }
      }

      if (!branchId) {
        return json({
          executed: false,
          ...(bridgeError ? { bridgeError } : {}),
          action:
            "Falta branchId: obtenlo con discover_branch y reintenta. Para que el carro se ejecute solo, " +
            "configura el puente (SUPERMERCADOS_SESSION_PROFILE) e inicia sesión con `npm run session:login`.",
        });
      }
      const body = buildCartPatchBody(items, branchId);
      return json({
        executed: false,
        ...(bridgeError ? { bridgeError } : {}),
        request: {
          method: "PATCH",
          url: `${CART_BFF_BASE}/cart/items`,
          body,
          note:
            browserFetchNote("el carro tras agregar los ítems") +
            " Devuelve el JSON del carro en rawCartResult para normalizarlo.",
          browserSnippet: jumboMutateSnippet("/cart/items", "PATCH", body, "cart"),
        },
      });
    }
  );

  server.registerTool(
    "get_cart",
    {
      title: "Estado del carro",
      description:
        "Normaliza el carro de Jumbo del usuario a { items, subTotal, total, savings, primeSavings }. " +
        "Con el puente Playwright de sesión configurado, lo lee directo de Jumbo (sin snippet). " +
        "Sin puente, el servidor no ve credenciales. FLUJO RÁPIDO (una sola llamada): ejecuta el `browserSnippet` que " +
        "devuelve esta tool en una pestaña YA LOGUEADA de www.jumbo.cl y pásame el JSON en `rawCart`. " +
        "NO extraigas el estado de React ni el DOM del carro a mano: es lento, frágil e innecesario " +
        "(este fetch trae todo el carro directo). Si no pasas `rawCart`, devuelvo el snippet listo para ejecutar.",
      inputSchema: {
        store: z.enum(["jumbo"]).default("jumbo").describe("Cadena. Fase 3: jumbo."),
        branchId: z.string().optional().describe('Sucursal, ej. "jumboclj512".'),
        rawCart: z
          .unknown()
          .optional()
          .describe(
            "JSON crudo de GET /cart que obtuvo el navegador ejecutando el browserSnippet."
          ),
      },
    },
    async ({ store, branchId, rawCart }) => {
      if (rawCart !== undefined) return json(parseCart(rawCart, store));

      const exec = getConfiguredSessionExecutor();
      let bridgeError: ReturnType<typeof bridgeFailure> | undefined;
      if (exec) {
        try {
          const done = await jumboGetCart(exec, branchId);
          return json({
            via: "playwright",
            branchId: done.branchId,
            ...parseCart(done.raw, store),
          });
        } catch (err) {
          bridgeError = bridgeFailure(err);
        }
      }

      const path = `/cart?store=${branchId ?? "{branchId}"}&simulationTotals=true`;
      return json({
        needsRawCart: true,
        ...(bridgeError ? { bridgeError } : {}),
        note: browserFetchNote("el carro del usuario"),
        browserSnippet: jumboFetchSnippet(path, "cart"),
        request: { method: "GET", url: `${CART_BFF_BASE}${path}` },
      });
    }
  );
}
