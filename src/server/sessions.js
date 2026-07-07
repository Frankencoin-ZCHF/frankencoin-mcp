/**
 * Session stores for MCP Streamable HTTP (/mcp) and legacy SSE (/sse).
 *
 * Hardening (SECURITY §3.5): hard caps per map (refuse, never evict a live user),
 * idle-TTL + absolute-lifetime sweep, and an init lock that serializes first-time
 * initializes. Records track { transport, createdAt, lastSeenAt }.
 */

import { config } from "../config.js";

export const mcpSessions = new Map();
export const sseSessions = new Map();

let initLockPromise = null;
export function getInitLock() { return initLockPromise; }
export function setInitLock(p) { initLockPromise = p; }
export function clearInitLock() { initLockPromise = null; }

export function mcpAtCap() { return mcpSessions.size >= config.maxSessions; }
export function sseAtCap() { return sseSessions.size >= config.maxSseSessions; }

export function touch(map, id) {
  const rec = map.get(id);
  if (rec) rec.lastSeenAt = Date.now();
}

function closeRecord(rec) {
  try { rec.transport?.close?.(); } catch { /* ignore */ }
}

/** Close + delete sessions idle beyond the TTL or older than the absolute cap. */
function sweep(map) {
  const now = Date.now();
  for (const [id, rec] of map) {
    const idle = now - rec.lastSeenAt;
    const age = now - rec.createdAt;
    if (idle > config.sessionIdleMs || age > config.sessionAbsoluteMs) {
      closeRecord(rec);
      map.delete(id);
    }
  }
}

let sweeper = null;
export function startSweeper() {
  if (sweeper) return;
  sweeper = setInterval(() => { sweep(mcpSessions); sweep(sseSessions); }, 60_000);
  sweeper.unref();
}

export function stopSweeper() {
  if (sweeper) { clearInterval(sweeper); sweeper = null; }
}

export function activeSessionCount() {
  return mcpSessions.size + sseSessions.size;
}
