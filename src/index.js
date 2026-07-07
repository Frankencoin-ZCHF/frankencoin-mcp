#!/usr/bin/env node
/**
 * Frankencoin MCP Server — 13 read-only data tools.
 *
 *   node src/index.js            # stdio mode (Claude Desktop / Cursor / CLI)
 *   node src/index.js --http     # HTTP mode (public deployment)
 *   PORT=8080 node src/index.js --http
 *
 * Boots with ZERO required env vars. Missing COINGECKO_API_KEY / DUNE_API_KEY only
 * degrade two tools — the server never hard-fails on their absence.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "./config.js";
import { createMcpServer } from "./server/mcp.js";
import { createHttpServer } from "./server/http.js";
import { stopSweeper } from "./server/sessions.js";
import { sanitizeForLog } from "./lib/errors.js";

// Never write an error to an in-flight response; log to stderr and (for uncaught) exit.
process.on("unhandledRejection", (reason) => {
  console.error(`[unhandledRejection] ${sanitizeForLog(reason?.code || reason?.name || String(reason), 80)}`);
});
process.on("uncaughtException", (err) => {
  console.error(`[uncaughtException] ${sanitizeForLog(err?.code || err?.name || String(err), 80)}`);
  process.exit(1);
});

const useHttp = process.argv.includes("--http");

if (!useHttp) {
  // ── stdio mode ──
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
  console.error("Frankencoin MCP server running on stdio");
} else {
  // ── HTTP mode ──
  const httpServer = createHttpServer();
  httpServer.listen(config.port, () => {
    console.error(`Frankencoin MCP server listening on port ${config.port}`);
    console.error(`  MCP (streamable): http://localhost:${config.port}/mcp`);
    console.error(`  REST API        : http://localhost:${config.port}/api/<tool>`);
    console.error(`  SSE (legacy)    : http://localhost:${config.port}/sse`);
    console.error(`  Health          : http://localhost:${config.port}/health`);
    console.error(`  CoinGecko key   : ${config.coingeckoKey ? "configured" : "absent (market/macro degrade)"}`);
    console.error(`  Dune key        : ${config.duneKey ? "configured" : "absent (dune stats degrade)"}`);
  });

  const shutdown = (signal) => {
    console.error(`\n[shutdown] ${signal} received — shutting down…`);
    stopSweeper();
    httpServer.close(() => {
      console.error("[shutdown] HTTP server closed");
      process.exit(0);
    });
    setTimeout(() => {
      console.error("[shutdown] force exit after 10s");
      process.exit(1);
    }, 10_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
