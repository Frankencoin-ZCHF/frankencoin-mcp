#!/usr/bin/env node
/**
 * Frankencoin MCP Server
 *
 * Exposes Frankencoin (ZCHF) protocol data as MCP tools.
 * Supports two transports:
 *   - stdio (default): for local Claude Desktop / Cursor / CLI usage
 *   - HTTP (--http): for public deployment at mcp.frankencoin.com
 *
 * Usage:
 *   node src/index.js              # stdio mode
 *   node src/index.js --http       # HTTP mode (default port 3000)
 *   PORT=8080 node src/index.js --http
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import http from "http";
import { TOOLS } from "./tools.js";
import * as api from "./api.js";

// ─── Tool registration ────────────────────────────────────────────────────────
// Each session gets its own McpServer instance (required by SDK — one server per transport).
// Tool logic is shared via the api module.

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function err(e) {
  return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
}

function createServer() {
  const server = new McpServer({ name: "frankencoin", version: "1.0.0" });

  for (const tool of TOOLS) {
    server.tool(tool.name, tool.description, tool.inputSchema.properties || {}, async (args) => {
      try {
        switch (tool.name) {
          case "get_protocol_summary":    return ok(await api.getProtocolSummary());
          case "get_protocol_info":       return ok(await api.getProtocolInfo());
          case "get_fps_info":            return ok(await api.getFpsInfo());
          case "get_prices":              return ok(await api.getPrices());
          case "get_savings_rates":       return ok(await api.getSavingsRates());
          case "get_savings_stats":       return ok(await api.getSavingsStats());
          case "get_collaterals":         return ok(await api.getCollaterals());
          case "get_challenges":
            return ok(await api.getChallenges({
              limit: Math.min(args.limit ?? 20, 100),
              activeOnly: args.active_only ?? false,
            }));
          case "get_positions":
            return ok(await api.getPositions({ limit: args.limit ?? 50 }));
          case "get_positions_detail":
            return ok(await api.getPositionsDetail({
              limit: Math.min(args.limit ?? 20, 100),
              activeOnly: args.active_only ?? true,
              collateral: args.collateral ?? null,
            }));
          case "get_analytics":
            return ok(await api.getAnalytics({ days: Math.min(args.days ?? 30, 365) }));
          case "get_equity_trades":
            return ok(await api.getEquityTrades({ limit: Math.min(args.limit ?? 20, 100) }));
          case "get_minters":
            return ok(await api.getMinters({ limit: args.limit ?? 20 }));
          case "get_market_context":   return ok(await api.getMarketContext());
          case "get_dune_stats":       return ok(await api.getDuneStats());
          case "query_ponder":
            if (!args.query) return err(new Error("query parameter required"));
            return ok(await api.runPonderQuery(args.query));
          default:
            return err(new Error(`Unknown tool: ${tool.name}`));
        }
      } catch (e) {
        return err(e);
      }
    });
  }

  return server;
}

// ─── Transport ────────────────────────────────────────────────────────────────

const useHttp = process.argv.includes("--http");
const PORT = parseInt(process.env.PORT || "3000", 10);

if (!useHttp) {
  // ── stdio mode — Claude Desktop / Cursor / CLI ──
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Frankencoin MCP server running on stdio");

} else {
  // ── HTTP mode — public deployment ──
  // Each session gets its own (server, transport) pair.
  // Map: sessionId → { server, transport }
  const sessions = new Map();

  // SSE sessions (legacy): keyed by a synthetic ID we manage
  const sseSessions = new Map();

  const httpServer = http.createServer(async (req, res) => {
    // CORS — fully open, read-only public API
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, mcp-session-id");
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");

    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url, `http://localhost:${PORT}`);

    // ── Health / root ──────────────────────────────────────────────────────
    if (url.pathname === "/" || url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        server: "frankencoin-mcp",
        version: "1.0.0",
        description: "MCP server for the Frankencoin (ZCHF) protocol",
        transports: {
          streamableHttp: `POST /mcp  (recommended — MCP spec 2024-11-05)`,
          sse: `GET /sse  (legacy — Claude Desktop pre-Nov 2024)`,
        },
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
        activeSessions: sessions.size,
        docs: "https://github.com/Frankencoin-ZCHF/frankencoin-mcp",
      }, null, 2));
      return;
    }

    // ── Streamable HTTP  (/mcp) ────────────────────────────────────────────
    if (url.pathname === "/mcp") {
      try {
        if (req.method === "POST") {
          const sessionId = req.headers["mcp-session-id"];

          // Existing session
          if (sessionId && sessions.has(sessionId)) {
            const { transport } = sessions.get(sessionId);
            await transport.handleRequest(req, res);
            return;
          }

          // New session — create server + transport pair
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            onsessioninitialized: (id) => {
              sessions.set(id, { server: mcpServer, transport });
            },
          });
          transport.onclose = () => {
            if (transport.sessionId) sessions.delete(transport.sessionId);
          };
          const mcpServer = createServer();
          await mcpServer.connect(transport);
          await transport.handleRequest(req, res);
          return;
        }

        if (req.method === "GET") {
          const sessionId = req.headers["mcp-session-id"];
          if (!sessionId || !sessions.has(sessionId)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing or invalid mcp-session-id" }));
            return;
          }
          const { transport } = sessions.get(sessionId);
          await transport.handleRequest(req, res);
          return;
        }

        if (req.method === "DELETE") {
          const sessionId = req.headers["mcp-session-id"];
          if (sessionId && sessions.has(sessionId)) {
            const { transport } = sessions.get(sessionId);
            await transport.handleRequest(req, res);
            sessions.delete(sessionId);
          } else {
            res.writeHead(200); res.end();
          }
          return;
        }

        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Method not allowed" }));

      } catch (e) {
        console.error("[/mcp error]", e.message);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      }
      return;
    }

    // ── SSE  (/sse + /messages) ────────────────────────────────────────────
    // Legacy transport for older clients. Each GET /sse creates a session.
    if (url.pathname === "/sse") {
      if (req.method !== "GET") {
        res.writeHead(405); res.end(); return;
      }
      const sseId = crypto.randomUUID();
      const transport = new SSEServerTransport(`/messages?sessionId=${sseId}`, res);
      const mcpServer = createServer();
      sseSessions.set(sseId, { server: mcpServer, transport });
      transport.onclose = () => sseSessions.delete(sseId);
      await mcpServer.connect(transport);
      // res stays open (SSE stream)
      return;
    }

    if (url.pathname === "/messages") {
      if (req.method !== "POST") {
        res.writeHead(405); res.end(); return;
      }
      const sseId = url.searchParams.get("sessionId");
      if (!sseId || !sseSessions.has(sseId)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unknown sessionId — connect via GET /sse first" }));
        return;
      }
      const { transport } = sseSessions.get(sseId);
      await transport.handlePostMessage(req, res);
      return;
    }

    // ── 404 ───────────────────────────────────────────────────────────────
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found", endpoints: ["/mcp", "/sse", "/health"] }));
  });

  httpServer.listen(PORT, () => {
    console.error(`Frankencoin MCP server listening on port ${PORT}`);
    console.error(`  Streamable HTTP : http://localhost:${PORT}/mcp`);
    console.error(`  SSE (legacy)    : http://localhost:${PORT}/sse`);
    console.error(`  Health          : http://localhost:${PORT}/health`);
  });
}
