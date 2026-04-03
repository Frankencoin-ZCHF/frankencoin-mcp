#!/usr/bin/env node
/**
 * Frankencoin MCP Server — 13 consolidated tools
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
import {
  SubscriptionStore,
  startPoller,
  stopPoller,
  handleWebhookRequest,
  getPollerStatus,
  getPendingRetryCount,
} from "./webhooks/index.js";

const { version: SERVER_VERSION } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
);

// ─── Tool dispatch ────────────────────────────────────────────────────────────
// Single dispatch function used by both MCP and REST layers.

// Webhook store — instantiated once, shared across all interfaces
let webhookStore = null;

async function dispatchTool(toolName, args) {
  switch (toolName) {
    case "get_protocol_snapshot":
      return api.getProtocolSnapshot();
    case "get_market_data":
      return api.getMarketData();
    case "get_savings":
      return api.getSavings();
    case "get_governance":
      return api.getGovernance({
        type: args.type ?? "all",
        status: args.status ?? "all",
        limit: Math.min(args.limit ?? 20, 100),
      });
    case "get_positions":
      return api.getPositions({
        detail: args.detail ?? false,
        limit: args.limit != null ? Math.min(args.limit, 100) : undefined,
        activeOnly: args.active_only,
        collateral: args.collateral ?? null,
      });
    case "get_challenges":
      return api.getChallenges({
        limit: Math.min(args.limit ?? 20, 100),
        activeOnly: args.active_only ?? false,
      });
    case "get_collaterals":
      return api.getCollaterals();
    case "get_analytics":
      return api.getAnalytics({
        type: args.type ?? "time_series",
        days: Math.min(args.days ?? 90, 365),
        limit: Math.min(args.limit ?? 20, 100),
      });
    case "get_knowledge":
      return api.getKnowledge({ topic: args.topic ?? "overview" });
    case "get_news":
      return api.getNews();
    case "get_merch":
      return api.getMerch();
    case "get_dune_stats":
      return api.getDuneStats();
    case "query_ponder":
      if (!args.query) throw new Error("query parameter required");
      return api.runPonderQuery(args.query);

    // ── Webhook tools ──────────────────────────────────────────────────────
    case "subscribe_events": {
      if (!webhookStore) throw new Error("Webhooks only available in HTTP mode");
      const events = typeof args.events === "string"
        ? args.events.split(",").map((s) => s.trim()).filter(Boolean)
        : args.events;
      const filters = {};
      if (args.min_amount != null) filters.min_amount = args.min_amount;
      if (args.chain_id != null) filters.chain_id = args.chain_id;
      if (args.address != null) filters.address = args.address;
      const result = webhookStore.create({
        url: args.url,
        secret: args.secret,
        events,
        filters,
      });
      if (!result.ok) throw new Error(result.error);
      return result;
    }
    case "unsubscribe_events": {
      if (!webhookStore) throw new Error("Webhooks only available in HTTP mode");
      const result = webhookStore.delete(args.subscription_id);
      if (!result.ok) throw new Error(result.error);
      return result;
    }
    case "list_subscriptions": {
      if (!webhookStore) throw new Error("Webhooks only available in HTTP mode");
      return webhookStore.list(args.url || undefined);
    }
    case "get_webhook_status": {
      if (!webhookStore) throw new Error("Webhooks only available in HTTP mode");
      const pollerStatus = getPollerStatus();
      const deliveryStats = webhookStore.getDeliveryStats();
      const eventCounts = webhookStore.getEventCounts();
      return {
        poller: {
          running: pollerStatus.running,
          initialized: pollerStatus.initialized,
          last_poll_at: pollerStatus.lastPollAt
            ? new Date(pollerStatus.lastPollAt).toISOString()
            : null,
          poll_interval_ms: 60_000,
          consecutive_errors: pollerStatus.consecutiveErrors,
        },
        subscriptions: {
          total: webhookStore.subs.size,
          by_event: eventCounts,
        },
        delivery: {
          total_delivered: deliveryStats.totalDelivered,
          total_failed: deliveryStats.totalFailed,
          pending_retries: getPendingRetryCount(),
        },
      };
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

// ─── MCP helpers ──────────────────────────────────────────────────────────────

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function err(e) {
  return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
}

/**
 * Convert a JSON Schema properties map to a Zod raw shape.
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
        return ok(await dispatchTool(tool.name, args));
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
  const sessions = new Map();
  const sseSessions = new Map();
  let initLockPromise = null;

  // ── Rate limiter (in-memory, per-IP) ───────────────────────────────────────
  const WINDOW_MS     = parseInt(process.env.RATE_LIMIT_WINDOW_MS   || "60000",  10); // 1 min
  const MAX_GENERAL   = parseInt(process.env.RATE_LIMIT_MAX         || "120",    10); // 120 req/min general
  const MAX_WEBHOOK   = parseInt(process.env.RATE_LIMIT_WEBHOOK_MAX || "10",     10); // 10 sub mutations/min
  const MAX_BODY_BYTES = 64 * 1024; // 64 KB max request body

  const rateBuckets = new Map(); // ip → { count, resetAt }

  // Prune stale buckets every 5 minutes
  setInterval(() => {
    const now = Date.now();
    for (const [ip, bucket] of rateBuckets) {
      if (bucket.resetAt < now) rateBuckets.delete(ip);
    }
  }, 5 * 60_000).unref();

  function getClientIp(req) {
    // Railway / reverse proxy: trust X-Forwarded-For
    const forwarded = req.headers["x-forwarded-for"];
    if (forwarded) return forwarded.split(",")[0].trim();
    return req.socket.remoteAddress || "unknown";
  }

  function checkRateLimit(ip, limit) {
    const now = Date.now();
    let bucket = rateBuckets.get(ip);
    if (!bucket || bucket.resetAt < now) {
      bucket = { count: 0, resetAt: now + WINDOW_MS };
      rateBuckets.set(ip, bucket);
    }
    bucket.count++;
    return { allowed: bucket.count <= limit, count: bucket.count, resetAt: bucket.resetAt };
  }

  const httpServer = http.createServer(async (req, res) => {
    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, mcp-session-id");
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");

    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    let url;
    try {
      url = new URL(req.url, `http://localhost:${PORT}`);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid request URL" }));
      return;
    }
    const ip = getClientIp(req);

    // ── Rate limiting ──────────────────────────────────────────────────────
    // Webhook mutations (POST /webhooks/subscribe, DELETE) get a tighter limit
    const isWebhookMutation = url.pathname.startsWith("/webhooks/") &&
      (req.method === "POST" || req.method === "DELETE") &&
      !url.pathname.endsWith("/test"); // test endpoint uses general limit

    const limit = isWebhookMutation ? MAX_WEBHOOK : MAX_GENERAL;
    const rl = checkRateLimit(ip + (isWebhookMutation ? ":wh" : ""), limit);

    res.setHeader("X-RateLimit-Limit", limit);
    res.setHeader("X-RateLimit-Remaining", Math.max(0, limit - rl.count));
    res.setHeader("X-RateLimit-Reset", Math.ceil(rl.resetAt / 1000));

    if (!rl.allowed) {
      res.setHeader("Retry-After", Math.ceil((rl.resetAt - Date.now()) / 1000));
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Rate limit exceeded. Please slow down." }));
      return;
    }

    // ── Health / root ──────────────────────────────────────────────────────
    if (url.pathname === "/" || url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        server: "frankencoin-mcp",
        version: SERVER_VERSION,
        description: "Frankencoin (ZCHF) protocol data server — 17 tools (13 data + 4 webhook)",
        interfaces: {
          mcp:  "POST /mcp  — MCP protocol (AI agents, Claude Desktop, Cursor)",
          rest: "GET  /api/<tool>  — plain JSON REST, no handshake (curl, fetch, scripts)",
          sse:  "GET  /sse  — legacy SSE transport (older clients)",
          webhooks: "/webhooks/*  — event subscription and webhook delivery",
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
          "GET /api/get_savings",
          "GET /api/get_governance?type=minters&status=active",
          "GET /api/get_positions?detail=true&limit=10",
          "GET /api/get_challenges?active_only=true",
          "GET /api/get_analytics?type=time_series&days=30",
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
          url: `GET /api/${t.name}`,
        })),
      }, null, 2));
      return;
    }

    // ── Webhooks (/webhooks/*) ──────────────────────────────────────────────
    if (url.pathname.startsWith("/webhooks/")) {
      return handleWebhookRequest(req, res, url, webhookStore, SERVER_VERSION);
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
            let size = 0;
            req.on("data", (d) => {
              size += d.length;
              if (size > MAX_BODY_BYTES) {
                req.destroy();
                reject(new Error("Request body too large"));
                return;
              }
              buf += d;
            });
            req.on("end", () => resolve(buf));
            req.on("error", reject);
          });
          if (body.trim()) params = JSON.parse(body);
        } catch (e) {
          const tooLarge = e.message?.includes("too large");
          res.writeHead(tooLarge ? 413 : 400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, tool: toolName, error: tooLarge ? "Request body too large (max 64 KB)" : "Invalid JSON body" }));
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
        const result = await dispatchTool(toolName, params);
        console.error(`[/api/${toolName}] ok`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, tool: toolName, result }, null, 2));
      } catch (e) {
        console.error(`[/api/${toolName}] error: ${e.message}`);
        const status = e.message.includes("required") ? 400 : 500;
        res.writeHead(status, { "Content-Type": "application/json" });
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
                error: { code: -32000, message: "Server initializing — please retry initialize" },
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
      if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
      const sseId = crypto.randomUUID();
      const transport = new SSEServerTransport(`/messages?sessionId=${sseId}`, res);
      const mcpServer = createServer();
      sseSessions.set(sseId, { server: mcpServer, transport });
      transport.onclose = () => sseSessions.delete(sseId);
      await mcpServer.connect(transport);
      return;
    }

    if (url.pathname === "/messages") {
      if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
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

  // Instantiate webhook store before server starts
  webhookStore = new SubscriptionStore();

  httpServer.listen(PORT, () => {
    console.error(`Frankencoin MCP server listening on port ${PORT}`);
    console.error(`  MCP (streamable): http://localhost:${PORT}/mcp`);
    console.error(`  REST API        : http://localhost:${PORT}/api/<tool>`);
    console.error(`  SSE (legacy)    : http://localhost:${PORT}/sse`);
    console.error(`  Webhooks        : http://localhost:${PORT}/webhooks/`);
    console.error(`  Health          : http://localhost:${PORT}/health`);

    // Start the event poller (HTTP mode only)
    startPoller(webhookStore, SERVER_VERSION);
  });

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  async function gracefulShutdown(signal) {
    console.error(`\n[shutdown] ${signal} received — shutting down...`);
    stopPoller();
    httpServer.close(() => {
      console.error("[shutdown] HTTP server closed");
      if (webhookStore) webhookStore.destroy();
      process.exit(0);
    });
    // Force exit after 10s if in-flight requests hang
    setTimeout(() => {
      console.error("[shutdown] Force exit after 10s timeout");
      process.exit(1);
    }, 10_000).unref();
  }

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
}
