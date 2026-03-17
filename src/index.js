#!/usr/bin/env node
/**
 * Frankencoin MCP Server
 *
 * Exposes Frankencoin (ZCHF) protocol data via three interfaces:
 *   - MCP stdio (default): for local Claude Desktop / Cursor / CLI usage
 *   - MCP HTTP  (--http):  POST /mcp  — MCP protocol, for AI agents
 *   - REST API  (--http):  GET  /api/<tool>[?param=value]  — plain JSON, no handshake
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
import { readFileSync } from "fs";
import { z } from "zod";
import { TOOLS } from "./tools.js";
import * as api from "./api.js";

const { version: SERVER_VERSION } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
);

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function err(e) {
  return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
}

/**
 * Convert JSON Schema properties to Zod shape.
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
  const server = new McpServer({ name: "frankencoin", version: SERVER_VERSION });

  for (const tool of TOOLS) {
    const zodShape = jsonPropsToZodShape(
      tool.inputSchema.properties || {},
      tool.inputSchema.required || [],
    );
    server.tool(tool.name, tool.description, zodShape, async (args) => {
      try {
        switch (tool.name) {
          case "get_protocol_snapshot":
            return ok(await api.getProtocolSnapshot());
          case "get_market_data":
            return ok(await api.getMarketData());
          case "get_savings":
            return ok(await api.getSavings());
          case "get_governance":
            return ok(await api.getGovernance({
              type: args.type ?? "all",
              status: args.status ?? "all",
              limit: Math.min(args.limit ?? 20, 100),
            }));
          case "get_positions":
            return ok(await api.getPositionsUnified({
              detail: args.detail ?? false,
              limit: args.limit,
              activeOnly: args.active_only,
              collateral: args.collateral ?? null,
            }));
          case "get_challenges":
            return ok(await api.getChallenges({
              limit: Math.min(args.limit ?? 20, 100),
              activeOnly: args.active_only ?? false,
            }));
          case "get_collaterals":
            return ok(await api.getCollaterals());
          case "get_analytics":
            return ok(await api.getAnalytics({
              days: Math.min(args.days ?? 30, 365),
              type: args.type ?? "summary",
            }));
          case "get_knowledge":
            return ok(await api.getKnowledge({ topic: args.topic ?? "overview" }));
          case "get_news":
            return ok(await api.getNews());
          case "get_merch":
            return ok(await api.getMerch());
          case "get_dune_stats":
            return ok(await api.getDuneStats());
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
  // ── stdio mode ──
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Frankencoin MCP server running on stdio");

} else {
  // ── HTTP mode ──
  const sessions = new Map();
  const sseSessions = new Map();
  let initLockPromise = null;

  const httpServer = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, mcp-session-id");
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");

    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url, `http://localhost:${PORT}`);

    // ── Health / root ──
    if (url.pathname === "/" || url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        server: "frankencoin-mcp",
        version: SERVER_VERSION,
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
          "GET /api/get_protocol_snapshot",
          "GET /api/get_market_data",
          "GET /api/get_positions?detail=true&limit=10",
          "GET /api/get_challenges?active_only=true",
          "GET /api/get_analytics?days=30&type=summary",
          "GET /api/get_knowledge?topic=faq",
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
        })),
      }, null, 2));
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      const toolName = url.pathname.slice(5);
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
        for (const [k, v] of url.searchParams.entries()) {
          const propDef = toolDef.inputSchema.properties?.[k];
          if (propDef?.type === "number") params[k] = Number(v);
          else if (propDef?.type === "boolean") params[k] = v === "true" || v === "1";
          else params[k] = v;
        }
      }

      try {
        let result;
        switch (toolName) {
          case "get_protocol_snapshot":
            result = await api.getProtocolSnapshot(); break;
          case "get_market_data":
            result = await api.getMarketData(); break;
          case "get_savings":
            result = await api.getSavings(); break;
          case "get_governance":
            result = await api.getGovernance({
              type: params.type ?? "all",
              status: params.status ?? "all",
              limit: Math.min(params.limit ?? 20, 100),
            }); break;
          case "get_positions":
            result = await api.getPositionsUnified({
              detail: params.detail ?? false,
              limit: params.limit,
              activeOnly: params.active_only,
              collateral: params.collateral ?? null,
            }); break;
          case "get_challenges":
            result = await api.getChallenges({
              limit: Math.min(params.limit ?? 20, 100),
              activeOnly: params.active_only ?? false,
            }); break;
          case "get_collaterals":
            result = await api.getCollaterals(); break;
          case "get_analytics":
            result = await api.getAnalytics({
              days: Math.min(params.days ?? 30, 365),
              type: params.type ?? "summary",
            }); break;
          case "get_knowledge":
            result = await api.getKnowledge({ topic: params.topic ?? "overview" }); break;
          case "get_news":
            result = await api.getNews(); break;
          case "get_merch":
            result = await api.getMerch(); break;
          case "get_dune_stats":
            result = await api.getDuneStats(); break;
          case "query_ponder":
            if (!params.query) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: false, tool: toolName, error: "query param required" }));
              return;
            }
            result = await api.runPonderQuery(params.query); break;
          default:
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: `No handler for tool: ${toolName}` }));
            return;
        }
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

          if (sessionId && sessions.has(sessionId)) {
            const { transport } = sessions.get(sessionId);
            await transport.handleRequest(req, res);
            return;
          }

          if (sessionId && !sessions.has(sessionId)) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32001, message: "Session not found — please re-initialize" },
              id: null,
            }));
            return;
          }

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
