#!/usr/bin/env node
/**
 * Frankencoin MCP Server
 *
 * Exposes Frankencoin (ZCHF) protocol data via three interfaces:
 *   - MCP stdio (default): for local Claude Desktop / Cursor / CLI usage
 *   - MCP HTTP  (--http):  POST /mcp  — MCP protocol, for AI agents
 *   - REST API  (--http):  GET  /api/<tool>[?param=value]  — plain JSON, no handshake
 *
 * The REST /api layer is the lightweight "agentic shortcut" — any agent or
 * script can call it with a single HTTP GET, no MCP session required.
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
import { z } from "zod";
import { TOOLS } from "./tools.js";
import * as api from "./api/index.js";

// ─── Tool dispatch ───────────────────────────────────────────────────────────
// Single mapping from tool name → handler function.
// Used by both MCP and REST interfaces — no duplication.

function callTool(name, params) {
  switch (name) {
    case "get_protocol_summary":    return api.getProtocolSummary();
    case "get_protocol_info":       return api.getProtocolInfo();
    case "get_fps_info":            return api.getFpsInfo();
    case "get_prices":              return api.getPrices();
    case "get_savings_rates":       return api.getSavingsRates();
    case "get_savings_stats":       return api.getSavingsStats();
    case "get_collaterals":         return api.getCollaterals();
    case "get_challenges":
      return api.getChallenges({
        limit: Math.min(params.limit ?? 20, 100),
        activeOnly: params.active_only ?? false,
      });
    case "get_positions":
      return api.getPositions({ limit: params.limit ?? 50 });
    case "get_positions_detail":
      return api.getPositionsDetail({
        limit: Math.min(params.limit ?? 20, 100),
        activeOnly: params.active_only ?? true,
        collateral: params.collateral ?? null,
      });
    case "get_analytics":
      return api.getAnalytics({ days: Math.min(params.days ?? 30, 365) });
    case "get_equity_trades":
      return api.getEquityTrades({ limit: Math.min(params.limit ?? 20, 100) });
    case "get_minters":
      return api.getMinters({ limit: params.limit ?? 20 });
    case "get_historical":
      return api.getHistorical({ days: Math.min(params.days ?? 90, 365) });
    case "get_market_context":      return api.getMarketContext();
    case "get_chf_stablecoins":     return api.getChfStablecoins();
    case "get_dune_stats":          return api.getDuneStats();
    case "get_merch":               return api.getMerch();
    case "get_token_addresses":     return api.getTokenAddresses();
    case "get_links":               return api.getLinks();
    case "get_docs":
      return api.getDocs({ section: params.section ?? "overview" });
    case "get_media_and_use_cases": return api.getMediaAndUseCases();
    case "query_ponder":
      if (!params.query) throw new Error("query parameter required");
      return api.runPonderQuery(params.query);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── Tool registration ────────────────────────────────────────────────────────
// Each session gets its own McpServer instance (required by SDK — one server per transport).

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function err(e) {
  return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
}

/**
 * Convert a JSON Schema properties map to a Zod raw shape.
 * The SDK's server.tool() accepts a Zod raw shape (object whose values are
 * Zod schemas). Passing a plain JSON Schema object causes args to be silently
 * dropped — this helper ensures every property becomes a properly typed Zod
 * schema so the SDK can validate and forward arguments correctly.
 */
function jsonPropsToZodShape(properties = {}, required = []) {
  const shape = {};
  for (const [key, prop] of Object.entries(properties)) {
    let schema;
    switch (prop.type) {
      case "number":  schema = z.number(); break;
      case "boolean": schema = z.boolean(); break;
      case "string":
      default:        schema = z.string(); break;
    }
    if (prop.description) schema = schema.describe(prop.description);
    shape[key] = required.includes(key) ? schema : schema.optional();
  }
  return shape;
}

function createServer() {
  const server = new McpServer({ name: "frankencoin", version: "1.0.0" });

  for (const tool of TOOLS) {
    const zodShape = jsonPropsToZodShape(
      tool.inputSchema.properties || {},
      tool.inputSchema.required || [],
    );
    server.tool(tool.name, tool.description, zodShape, async (args) => {
      try {
        return ok(await callTool(tool.name, args));
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

  // Init lock: prevents a burst of concurrent sessionless requests from each
  // spawning their own (server, transport) pair before any one of them has
  // finished the MCP initialize handshake.
  let initLockPromise = null;

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
        description: "Frankencoin (ZCHF) protocol data server",
        interfaces: {
          mcp:  "POST /mcp  — MCP protocol (AI agents, Claude Desktop, Cursor)",
          rest: "GET  /api/<tool>  — plain JSON REST, no handshake (curl, fetch, scripts)",
          sse:  "GET  /sse  — legacy SSE transport (older clients)",
        },
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
        activeSessions: sessions.size,
        docs: "https://github.com/Frankencoin-ZCHF/frankencoin-mcp",
      }, null, 2));
      return;
    }

    // ── REST API  (/api/<tool>) ────────────────────────────────────────────
    if (url.pathname === "/api" || url.pathname === "/api/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        description: "Frankencoin REST API — call any tool with a single GET, no MCP session required.",
        usage: "GET https://mcp.frankencoin.com/api/<tool>[?param=value&...]",
        examples: [
          "GET /api/get_protocol_summary",
          "GET /api/get_prices",
          "GET /api/get_positions_detail?limit=10&active_only=true",
          "GET /api/get_challenges?active_only=true",
          "GET /api/get_historical?days=30",
          "GET /api/get_docs?section=savings",
          "POST /api/query_ponder  body: {\"query\": \"{ analyticDailyLogs(limit:3) { items { totalSupply date } } }\"}",
        ],
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          params: Object.entries(t.inputSchema.properties || {}).map(([k, v]) => ({
            name: k,
            type: v.type,
            required: (t.inputSchema.required || []).includes(k),
            description: v.description,
          })),
          url: `GET /api/${t.name}`,
        })),
      }, null, 2));
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      const toolName = url.pathname.slice(5); // strip /api/
      const toolDef = TOOLS.find((t) => t.name === toolName);

      if (!toolDef) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: false,
          error: `Unknown tool: ${toolName}`,
          available: TOOLS.map((t) => t.name),
        }));
        return;
      }

      // Parse params: query string for GET, JSON body for POST
      let params = {};
      if (req.method === "POST" || req.method === "PUT") {
        try {
          const body = await new Promise((resolve, reject) => {
            let buf = "";
            req.on("data", (d) => { buf += d; });
            req.on("end", () => resolve(buf));
            req.on("error", reject);
          });
          if (body.trim()) params = JSON.parse(body);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, tool: toolName, error: "Invalid JSON body" }));
          return;
        }
      } else {
        // GET: coerce query string values to the right types per tool schema
        for (const [k, v] of url.searchParams.entries()) {
          const propDef = toolDef.inputSchema.properties?.[k];
          if (propDef?.type === "number") params[k] = Number(v);
          else if (propDef?.type === "boolean") params[k] = v === "true" || v === "1";
          else params[k] = v;
        }
      }

      try {
        const result = await callTool(toolName, params);
        console.error(`[/api/${toolName}] ok`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, tool: toolName, result }, null, 2));
      } catch (e) {
        console.error(`[/api/${toolName}] error: ${e.message}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, tool: toolName, error: e.message }));
      }
      return;
    }

    // ── Streamable HTTP  (/mcp) ────────────────────────────────────────────
    if (url.pathname === "/mcp") {
      try {
        if (req.method === "POST") {
          const sessionId = req.headers["mcp-session-id"];

          // Existing known session
          if (sessionId && sessions.has(sessionId)) {
            const { transport } = sessions.get(sessionId);
            await transport.handleRequest(req, res);
            return;
          }

          // Stale session ID (server restarted, session expired) — reject cleanly
          if (sessionId && !sessions.has(sessionId)) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32001, message: "Session not found — please re-initialize" },
              id: null,
            }));
            return;
          }

          // New session — guard with init lock
          if (initLockPromise) {
            await initLockPromise.catch(() => {});
            if (sessions.size > 0) {
              res.writeHead(503, {
                "Content-Type": "application/json",
                "Retry-After": "1",
              });
              res.end(JSON.stringify({
                jsonrpc: "2.0",
                error: {
                  code: -32000,
                  message: "Server initializing — please retry initialize",
                },
                id: null,
              }));
              return;
            }
          }

          let resolveLock, rejectLock;
          initLockPromise = new Promise((res, rej) => { resolveLock = res; rejectLock = rej; });

          try {
            const transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => crypto.randomUUID(),
              onsessioninitialized: (id) => {
                sessions.set(id, { server: mcpServer, transport });
                console.error(`[session] new: ${id} (total: ${sessions.size})`);
              },
            });
            transport.onclose = () => {
              if (transport.sessionId) {
                sessions.delete(transport.sessionId);
                console.error(`[session] closed: ${transport.sessionId} (total: ${sessions.size})`);
              }
            };
            const mcpServer = createServer();
            await mcpServer.connect(transport);
            await transport.handleRequest(req, res);
            resolveLock();
          } catch (initErr) {
            rejectLock(initErr);
            throw initErr;
          } finally {
            initLockPromise = null;
          }
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
    res.end(JSON.stringify({ error: "Not found", endpoints: ["/mcp", "/api", "/sse", "/health"] }));
  });

  httpServer.listen(PORT, () => {
    console.error(`Frankencoin MCP server listening on port ${PORT}`);
    console.error(`  MCP (streamable): http://localhost:${PORT}/mcp`);
    console.error(`  REST API        : http://localhost:${PORT}/api/<tool>`);
    console.error(`  SSE (legacy)    : http://localhost:${PORT}/sse`);
    console.error(`  Health          : http://localhost:${PORT}/health`);
  });
}
