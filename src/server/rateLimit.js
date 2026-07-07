/**
 * Proxy-aware per-IP token bucket (SECURITY §3.2).
 *
 * Client IP derivation (NEVER the left-most, spoofable XFF entry):
 *   1. X-Envoy-External-Address (Railway edge sets this; not client-appendable).
 *   2. else right-most XFF entry (the hop the trusted proxy wrote); TRUST_PROXY_HOPS from right.
 *   3. else socket remote address.
 *   4. else "unknown" (shared bucket — only ever makes the limit stricter).
 */

import { config } from "../config.js";

const buckets = new Map(); // key → { count, resetAt }
const MAX_BUCKETS = 50_000;

// Prune stale buckets every 5 min (unref so it never holds the process open).
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.resetAt < now) buckets.delete(k);
}, 5 * 60_000).unref();

const IP_RE = /^[0-9a-fA-F:.]+$/;

function normalizeIp(value) {
  if (!value) return null;
  const v = String(value).replace(/[\r\n]/g, "").trim();
  if (v.length === 0 || v.length > 45 || !IP_RE.test(v)) return null;
  return v;
}

export function deriveClientIp(req) {
  const envoy = normalizeIp(req.headers["x-envoy-external-address"]);
  if (envoy) return envoy;

  const xff = req.headers["x-forwarded-for"];
  if (xff) {
    const parts = String(xff).split(",").map((s) => s.trim()).filter(Boolean);
    // Take the (TRUST_PROXY_HOPS)-th entry from the right.
    const idx = parts.length - config.trustProxyHops;
    const candidate = normalizeIp(parts[idx >= 0 ? idx : 0]);
    if (candidate) return candidate;
  }

  return normalizeIp(req.socket?.remoteAddress) || "unknown";
}

function evictIfNeeded() {
  if (buckets.size <= MAX_BUCKETS) return;
  const now = Date.now();
  for (const [k, b] of buckets) {
    if (b.resetAt < now) buckets.delete(k);
    if (buckets.size <= MAX_BUCKETS) return;
  }
  // Still over cap → drop oldest-inserted entries.
  while (buckets.size > MAX_BUCKETS) {
    const oldest = buckets.keys().next().value;
    if (oldest === undefined) break;
    buckets.delete(oldest);
  }
}

/** Increment and check a bucket. Returns { allowed, count, limit, resetAt }. */
export function checkRateLimit(key, limit) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.resetAt < now) {
    b = { count: 0, resetAt: now + config.rateLimitWindowMs };
    buckets.set(key, b);
    evictIfNeeded();
  }
  b.count++;
  return { allowed: b.count <= limit, count: b.count, limit, resetAt: b.resetAt };
}

export function _clearBuckets() {
  buckets.clear();
}
