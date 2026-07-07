/**
 * node:http router. Owns CORS, security headers, URL guard, rate limiting, body
 * reading + validation, in-flight caps, all routes, and the single error mapper.
 * No secret, stack, upstream URL, or raw upstream text ever reaches a response
 * (SECURITY §5).
 */

import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

import { config } from "../config.js";
import { TOOLS, TOOL_MAP } from "../tools/registry.js";
import { dispatchTool } from "../tools/dispatch.js";
import { restSuccess, restError, pretty } from "../lib/envelope.js";
import { mapError, sanitizeForLog, NotFoundError } from "../lib/errors.js";
import { createMcpServer } from "./mcp.js";
import { renderLlmsTxt } from "./llmsTxt.js";
import { deriveClientIp, checkRateLimit } from "./rateLimit.js";
import {
  mcpSessions, sseSessions, mcpAtCap, sseAtCap, touch,
  getInitLock, setInitLock, clearInitLock, activeSessionCount, startSweeper,
} from "./sessions.js";

const TOOL_NAMES = TOOLS.map((t) => t.name);

// Global + per-IP in-flight tool-dispatch caps (SECURITY §3.4).
let globalInflight = 0;
const ipInflight = new Map();

function sendJson(res, status, obj, { pretty: doPretty = true } = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(doPretty ? pretty(obj) : JSON.stringify(obj));
}

function setBaseHeaders(res) {
  // CORS (public, read-only, secret-free API). No Allow-Credentials with "*".
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, mcp-session-id");
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
  res.setHeader("Access-Control-Max-Age", "600");
  // Security headers.
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("Content-Security-Policy", "default-src 'none'");
  res.setHeader("Cache-Control", "no-store");
}

function mediaType(req) {
  return String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
}

function readCappedBody(req) {
  // Buffer up to the cap; if exceeded, DRAIN (discard) the rest so the client can
  // finish sending and receive a clean 413 (destroying the socket mid-upload would
  // surface as ECONNRESET on the client). Memory stays bounded; requestTimeout caps time.
  return new Promise((resolve, reject) => {
    let size = 0;
    let over = false;
    const chunks = [];
    req.on("data", (d) => {
      size += d.length;
      if (size > config.maxBodyBytes) {
        if (!over) { over = true; chunks.length = 0; }
        return; // discard further chunks
      }
      chunks.push(d);
    });
    req.on("end", () => {
      if (over) {
        const e = new Error("body too large");
        e.tooLarge = true;
        reject(e);
      } else {
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });
    req.on("error", reject);
  });
}

/** Deep-scan for prototype-pollution keys among OWN properties (SECURITY §4.3). */
function hasProtoKey(v, depth = 0) {
  if (!v || typeof v !== "object" || depth > 6) return false;
  for (const k of Object.getOwnPropertyNames(v)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") return true;
    if (hasProtoKey(v[k], depth + 1)) return true;
  }
  return false;
}

// ── Route handlers ─────────────────────────────────────────────────────────

function handleHealth(res) {
  sendJson(res, 200, {
    status: "ok",
    server: "frankencoin-mcp",
    version: config.version,
    description: `Frankencoin (ZCHF) protocol data server — ${TOOLS.length} read-only tools`,
    toolCount: TOOLS.length,
    interfaces: {
      mcp: "POST /mcp — MCP Streamable HTTP",
      rest: "GET /api/<tool> — plain JSON REST",
      sse: "GET /sse — legacy SSE transport",
      llms: "GET /llms.txt — agent-facing guide",
    },
    activeSessions: activeSessionCount(),
    docs: "https://github.com/Frankencoin-ZCHF/frankencoin-mcp",
  });
}

function handleLlmsTxt(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }
  if (res.headersSent) return;
  // Public, cacheable, drifts-with-the-registry guide. Override the base no-store.
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(renderLlmsTxt(TOOLS, config.publicUrl));
}

function handleApiIndex(res) {
  sendJson(res, 200, {
    description: "Frankencoin REST API — call any tool with a single GET, no MCP session required.",
    usage: "GET https://mcp.frankencoin.com/api/<tool>[?param=value&...]",
    llms: "GET /llms.txt — compact agent-facing guide to this server",
    examples: [
      "GET /api/get_protocol_snapshot",
      "GET /api/get_market_data",
      "GET /api/get_governance?type=minters&status=active",
      "GET /api/get_positions?detail=true&limit=10",
      "GET /api/get_knowledge?topic=faq",
      'POST /api/query_ponder  body: {"query":"{ analyticDailyLogs(limit:3){ items { date totalSupply } } }"}',
    ],
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      params: t.params,
      url: `GET /api/${t.name}`,
    })),
  });
}

async function runDispatch(ip, tool, params) {
  // In-flight caps.
  if (globalInflight >= config.globalInflightMax) {
    const e = new Error("busy"); e._status = 503; e._msg = "server busy, retry shortly"; throw e;
  }
  const cur = ipInflight.get(ip) || 0;
  if (cur >= config.perIpInflightMax) {
    const e = new Error("busy"); e._status = 429; e._msg = "rate limit exceeded"; throw e;
  }
  globalInflight++;
  ipInflight.set(ip, cur + 1);
  try {
    return await dispatchTool(tool, params);
  } finally {
    globalInflight--;
    const n = (ipInflight.get(ip) || 1) - 1;
    if (n <= 0) ipInflight.delete(ip); else ipInflight.set(ip, n);
  }
}

async function handleRest(req, res, url, ip) {
  const tool = url.pathname.slice(5);
  const def = TOOL_MAP.get(tool);

  if (!def) {
    // Do not reflect the raw tool name into the message; keep it in a structured field.
    sendJson(res, 404, { ok: false, error: "Unknown tool", available: TOOL_NAMES });
    return;
  }

  const method = req.method;
  if (method !== "GET" && method !== "POST" && method !== "PUT") {
    res.setHeader("Allow", "GET, POST, PUT, OPTIONS");
    sendJson(res, 405, { ok: false, tool, error: "method not allowed" });
    return;
  }

  // Build params.
  let params = {};
  if (method === "POST" || method === "PUT") {
    const ct = mediaType(req);
    const hasBody = Number(req.headers["content-length"]) > 0 || !!req.headers["transfer-encoding"];
    if (hasBody && ct && ct !== "application/json") {
      sendJson(res, 415, { ok: false, tool, error: "unsupported media type" });
      return;
    }
    let body;
    try {
      body = await readCappedBody(req);
    } catch (e) {
      if (e.tooLarge) sendJson(res, 413, { ok: false, tool, error: "Request body too large (max 64 KB)" });
      else sendJson(res, 400, { ok: false, tool, error: "Invalid JSON body" });
      return;
    }
    if (body.trim()) {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        sendJson(res, 400, { ok: false, tool, error: "Invalid JSON body" });
        return;
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || hasProtoKey(parsed)) {
        sendJson(res, 400, { ok: false, tool, error: "Invalid JSON body" });
        return;
      }
      params = parsed;
    }
  } else {
    // GET: first value wins; skip prototype-pollution keys entirely.
    for (const [k, v] of url.searchParams.entries()) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
      if (!(k in params)) params[k] = v;
    }
  }

  try {
    const result = await runDispatch(ip, tool, params);
    console.error(`[/api/${sanitizeForLog(tool, 40)}] ok`);
    sendJson(res, 200, restSuccess(tool, result));
  } catch (e) {
    if (e._status) {
      sendJson(res, e._status, { ok: false, tool, error: e._msg });
      return;
    }
    const { status, code } = mapError(e);
    console.error(`[/api/${sanitizeForLog(tool, 40)}] error ${code} (${status})`);
    sendJson(res, status, restError(tool, e));
  }
}

// ── MCP Streamable HTTP ──────────────────────────────────────────────────────

async function handleMcp(req, res) {
  const method = req.method;
  if (method !== "POST" && method !== "GET" && method !== "DELETE") {
    res.setHeader("Allow", "POST, GET, DELETE, OPTIONS");
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  // Body cap for POST (declared length); slowloris bounded by server timeouts.
  if (method === "POST" && Number(req.headers["content-length"]) > config.maxBodyBytes) {
    sendJson(res, 413, { ok: false, error: "Request body too large (max 64 KB)" });
    return;
  }

  try {
    if (method === "POST") {
      const sessionId = req.headers["mcp-session-id"];

      if (sessionId && mcpSessions.has(sessionId)) {
        touch(mcpSessions, sessionId);
        await mcpSessions.get(sessionId).transport.handleRequest(req, res);
        return;
      }
      if (sessionId && !mcpSessions.has(sessionId)) {
        sendJson(res, 404, {
          jsonrpc: "2.0",
          error: { code: -32001, message: "Session not found — please re-initialize" },
          id: null,
        });
        return;
      }

      // New init — serialize concurrent first-time initializes.
      const lock = getInitLock();
      if (lock) {
        await lock.catch(() => {});
        if (mcpSessions.size > 0) {
          res.setHeader("Retry-After", "1");
          sendJson(res, 503, {
            jsonrpc: "2.0",
            error: { code: -32000, message: "Server initializing — please retry initialize" },
            id: null,
          });
          return;
        }
      }
      if (mcpAtCap()) {
        res.setHeader("Retry-After", "2");
        sendJson(res, 503, { error: "Server at session capacity, retry shortly" });
        return;
      }

      let resolveLock, rejectLock;
      setInitLock(new Promise((r, j) => { resolveLock = r; rejectLock = j; }));
      try {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (id) => {
            mcpSessions.set(id, { transport, createdAt: Date.now(), lastSeenAt: Date.now() });
            console.error(`[session] new: ${id} (total: ${mcpSessions.size})`);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId && mcpSessions.delete(transport.sessionId)) {
            console.error("[session] closed");
          }
        };
        const server = createMcpServer();
        await server.connect(transport);
        await transport.handleRequest(req, res);
        resolveLock();
      } catch (e) {
        rejectLock(e);
        throw e;
      } finally {
        clearInitLock();
      }
      return;
    }

    if (method === "GET") {
      const sessionId = req.headers["mcp-session-id"];
      if (!sessionId || !mcpSessions.has(sessionId)) {
        sendJson(res, 400, { error: "Missing or invalid mcp-session-id" });
        return;
      }
      touch(mcpSessions, sessionId);
      await mcpSessions.get(sessionId).transport.handleRequest(req, res);
      return;
    }

    // DELETE
    const sessionId = req.headers["mcp-session-id"];
    if (sessionId && mcpSessions.has(sessionId)) {
      await mcpSessions.get(sessionId).transport.handleRequest(req, res);
      mcpSessions.delete(sessionId);
    } else if (!res.headersSent) {
      res.writeHead(200); res.end();
    }
  } catch (e) {
    console.error(`[/mcp error] ${sanitizeForLog(e.code || e.name || "error", 40)}`);
    if (!res.headersSent) sendJson(res, 500, { error: "internal server error" });
  }
}

async function handleSse(req, res) {
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); res.writeHead(405); res.end(); return; }
  if (sseAtCap()) {
    res.setHeader("Retry-After", "2");
    sendJson(res, 503, { error: "Server at session capacity, retry shortly" });
    return;
  }
  const sseId = crypto.randomUUID();
  const transport = new SSEServerTransport(`/messages?sessionId=${sseId}`, res);
  const server = createMcpServer();
  sseSessions.set(sseId, { transport, createdAt: Date.now(), lastSeenAt: Date.now() });
  transport.onclose = () => sseSessions.delete(sseId);
  // An unclean TCP drop may not fire transport.onclose — reap on socket close too.
  res.on("close", () => sseSessions.delete(sseId));
  await server.connect(transport);
}

async function handleMessages(req, res, url) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); res.writeHead(405); res.end(); return; }
  if (Number(req.headers["content-length"]) > config.maxBodyBytes) {
    sendJson(res, 413, { ok: false, error: "Request body too large (max 64 KB)" });
    return;
  }
  const sseId = url.searchParams.get("sessionId");
  if (!sseId || !sseSessions.has(sseId)) {
    sendJson(res, 400, { error: "Unknown sessionId — connect via GET /sse first" });
    return;
  }
  touch(sseSessions, sseId);
  await sseSessions.get(sseId).transport.handlePostMessage(req, res);
}

// ── Top-level request handler ────────────────────────────────────────────────

async function handle(req, res) {
  setBaseHeaders(res);

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  let url;
  try {
    url = new URL(req.url, `http://localhost:${config.port}`);
  } catch {
    sendJson(res, 400, { error: "Invalid request URL" });
    return;
  }

  const ip = deriveClientIp(req);

  // Rate limiting on ALL paths. query_ponder has a tighter sub-limit.
  const apiTool = url.pathname.startsWith("/api/") ? url.pathname.slice(5) : "";
  const rl = checkRateLimit(ip, config.rateLimitMax);
  res.setHeader("X-RateLimit-Limit", rl.limit);
  res.setHeader("X-RateLimit-Remaining", Math.max(0, rl.limit - rl.count));
  res.setHeader("X-RateLimit-Reset", Math.ceil(rl.resetAt / 1000));
  if (!rl.allowed) {
    res.setHeader("Retry-After", Math.ceil((rl.resetAt - Date.now()) / 1000));
    sendJson(res, 429, { ok: false, error: "Rate limit exceeded. Please slow down." });
    return;
  }
  if (apiTool === "query_ponder") {
    const sub = checkRateLimit(`${ip}:ponder`, config.rateLimitPonderMax);
    if (!sub.allowed) {
      res.setHeader("Retry-After", Math.ceil((sub.resetAt - Date.now()) / 1000));
      sendJson(res, 429, { ok: false, error: "Rate limit exceeded. Please slow down." });
      return;
    }
  }

  const path = url.pathname;
  if (path === "/" || path === "/health") return handleHealth(res);
  if (path === "/llms.txt") return handleLlmsTxt(req, res);
  if (path === "/api" || path === "/api/") return handleApiIndex(res);
  if (path.startsWith("/api/")) return handleRest(req, res, url, ip);
  if (path === "/mcp") return handleMcp(req, res);
  if (path === "/sse") return handleSse(req, res);
  if (path === "/messages") return handleMessages(req, res, url);

  sendJson(res, 404, { error: "Not found", endpoints: ["/mcp", "/api", "/sse", "/health", "/llms.txt"] });
}

export function createHttpServer() {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error(`[http] unhandled ${sanitizeForLog(e?.code || e?.name || "error", 40)}`);
      if (!res.headersSent) sendJson(res, 500, { error: "internal server error" });
    });
  });

  // Slowloris / inbound-timeout guards (SECURITY §3.3).
  server.headersTimeout = config.headersTimeoutMs;
  server.requestTimeout = config.requestTimeoutMs;
  server.keepAliveTimeout = config.keepAliveTimeoutMs;

  startSweeper();
  return server;
}
