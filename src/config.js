/**
 * Configuration. Read process.env ONCE, apply defaults, freeze, export.
 * NOTHING is required to boot — missing secrets only degrade two tools.
 * Secrets come from env only (no file fallback — that coupled behavior to the
 * deploy user's home dir; SECURITY §5.2 / ARCHITECTURE §C).
 */

import { readFileSync } from "node:fs";

function int(name, def) {
  const raw = process.env[name];
  if (raw == null || raw === "") return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : def;
}

let version = "3.0.0";
try {
  version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version || version;
} catch {
  /* keep default */
}

export const config = Object.freeze({
  version,

  port: int("PORT", 3000),

  // Optional secrets — absence degrades, never crashes.
  coingeckoKey: process.env.COINGECKO_API_KEY || null,
  duneKey: process.env.DUNE_API_KEY || null,

  // Rate limiting.
  rateLimitWindowMs: int("RATE_LIMIT_WINDOW_MS", 60000),
  rateLimitMax: int("RATE_LIMIT_MAX", 120),
  rateLimitPonderMax: int("RATE_LIMIT_PONDER_MAX", 20),
  trustProxyHops: int("TRUST_PROXY_HOPS", 1),

  // Body / upstream / cache bounds.
  maxBodyBytes: int("MAX_BODY_BYTES", 65536), // 64 KB
  upstreamMaxConcurrency: int("UPSTREAM_MAX_CONCURRENCY", 8),
  upstreamMaxBytes: int("UPSTREAM_MAX_BYTES", 8 * 1024 * 1024), // 8 MB
  maxRetryAfterMs: int("MAX_RETRY_AFTER_MS", 10_000), // cap honored Retry-After
  cacheMaxEntries: int("CACHE_MAX_ENTRIES", 500),
  cacheEnabled: (process.env.CACHE_ENABLED ?? "true") !== "false",

  // query_ponder validation bounds (SECURITY §2).
  ponderMaxQueryBytes: int("PONDER_MAX_QUERY_BYTES", 8000),
  ponderMaxDepth: int("PONDER_MAX_DEPTH", 8),
  ponderMaxFields: int("PONDER_MAX_FIELDS", 200),
  ponderMaxAliases: int("PONDER_MAX_ALIASES", 20),
  ponderMaxDirectives: int("PONDER_MAX_DIRECTIVES", 10),
  ponderMaxFragments: int("PONDER_MAX_FRAGMENTS", 8),
  ponderMaxArgNodes: int("PONDER_MAX_ARG_NODES", 100),
  ponderMaxArgLiteral: int("PONDER_MAX_ARG_LITERAL", 512),
  ponderMaxLimitArg: int("PONDER_MAX_LIMIT_ARG", 1000),
  ponderMaxResultBytes: int("PONDER_MAX_RESULT_BYTES", 1_000_000), // 1 MB

  // Sessions / concurrency caps (SECURITY §3).
  maxSessions: int("MAX_SESSIONS", 1000),
  maxSseSessions: int("MAX_SSE_SESSIONS", 1000),
  sessionIdleMs: int("SESSION_IDLE_MS", 10 * 60_000),
  sessionAbsoluteMs: int("SESSION_ABSOLUTE_MS", 60 * 60_000),
  globalInflightMax: int("GLOBAL_INFLIGHT_MAX", 100),
  perIpInflightMax: int("PER_IP_INFLIGHT_MAX", 10),

  // HTTP server hardening.
  headersTimeoutMs: int("HEADERS_TIMEOUT_MS", 10_000),
  requestTimeoutMs: int("REQUEST_TIMEOUT_MS", 30_000),
  keepAliveTimeoutMs: int("KEEP_ALIVE_TIMEOUT_MS", 5_000),

  logLevel: process.env.LOG_LEVEL || "info",
});
