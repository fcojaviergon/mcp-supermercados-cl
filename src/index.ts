#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { closeAllPlaywrightBridges } from "./adapters/playwrightBridge.js";
import { createServer } from "./server.js";

/**
 * Apagado ordenado: cierra los navegadores del puente Playwright antes de salir.
 * Sin esto, cuando el cliente MCP cierra la conexión el proceso quedaba vivo con
 * Chromium abierto (y el perfil bloqueado para la próxima sesión).
 */
let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const timer = setTimeout(() => process.exit(0), 5000);
  timer.unref();
  await closeAllPlaywrightBridges().catch(() => {});
  process.exit(0);
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // El cliente cierra stdin al terminar la sesión: es la señal de apagado en stdio.
  process.stdin.on("end", () => void shutdown());
  process.stdin.on("close", () => void shutdown());
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => void shutdown());
  }
  // stdout es del protocolo MCP; los logs van a stderr.
  console.error(
    "mcp-supermercados-cl listo (stdio). Cadenas: Jumbo, Santa Isabel, Unimarc, Tottus y Lider."
  );
}

main().catch((err) => {
  console.error("Error fatal al iniciar el servidor MCP:", err);
  process.exit(1);
});
