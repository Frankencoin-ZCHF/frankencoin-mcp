/**
 * In-memory TTL cache with single-flight coalescing and an LRU bound.
 * Applied at the upstream-client boundary so a single upstream fetch is shared
 * across every tool that needs it (ARCHITECTURE §B). Non-authoritative — wiped on
 * restart; a pure latency/amplification optimization.
 */

import { config } from "./config.js";

/** @type {Map<string, {value:any, expiresAt:number, staleUntil:number, inflight:Promise|null, lastUsed:number}>} */
const store = new Map();

function now() {
  return Date.now();
}

/** Evict least-recently-used entries until under the cap. */
function evictIfNeeded() {
  const cap = config.cacheMaxEntries;
  if (store.size <= cap) return;
  // Map preserves insertion order; we re-insert on touch so the oldest key is LRU.
  while (store.size > cap) {
    const oldestKey = store.keys().next().value;
    if (oldestKey === undefined) break;
    store.delete(oldestKey);
  }
}

/** Opportunistic purge of a few expired (non-SWR) entries to keep the map tidy. */
function lazyPurge() {
  const t = now();
  let checked = 0;
  for (const [key, entry] of store) {
    if (checked++ >= 8) break;
    if (!entry.inflight && t >= entry.expiresAt && t >= (entry.staleUntil || 0)) {
      store.delete(key);
    }
  }
}

function touch(key, entry) {
  entry.lastUsed = now();
  // Re-insert to move to the end (most-recently-used) for LRU ordering.
  store.delete(key);
  store.set(key, entry);
}

/**
 * Get a fresh cached value or load it. The only method callers use.
 *
 *  1. Fresh hit           → return value.
 *  2. In-flight           → await the existing promise (single-flight coalescing).
 *  3. SWR stale           → return stale value, revalidate in background.
 *  4. Miss / expired      → load, store on success (never cache errors).
 */
export async function getOrLoad(key, ttlMs, loader, { swrMs = 0 } = {}) {
  if (!config.cacheEnabled) return loader();

  const t = now();
  const entry = store.get(key);

  if (entry) {
    if (entry.value !== undefined && t < entry.expiresAt) {
      touch(key, entry);
      return entry.value; // fresh
    }
    if (entry.inflight) {
      return entry.inflight; // coalesce concurrent loads
    }
    if (entry.value !== undefined && swrMs > 0 && t < entry.staleUntil) {
      // stale-while-revalidate: serve stale, refresh in background
      touch(key, entry);
      entry.inflight = loader()
        .then((value) => {
          entry.value = value;
          entry.expiresAt = now() + ttlMs;
          entry.staleUntil = now() + ttlMs + swrMs;
          return value;
        })
        .catch((err) => {
          // keep stale value; log to stderr
          console.error(`[cache] background revalidate failed for ${key}: ${err.code || err.name}`);
          return entry.value;
        })
        .finally(() => { entry.inflight = null; });
      return entry.value;
    }
  }

  lazyPurge();

  // Miss / expired: single loader, tracked so concurrent callers coalesce.
  const rec = entry || { value: undefined, expiresAt: 0, staleUntil: 0, inflight: null, lastUsed: t };
  rec.inflight = loader()
    .then((value) => {
      rec.value = value;
      rec.expiresAt = now() + ttlMs;
      rec.staleUntil = swrMs > 0 ? now() + ttlMs + swrMs : 0;
      return value;
    })
    .finally(() => { rec.inflight = null; });

  store.set(key, rec);
  touch(key, rec);
  evictIfNeeded();

  return rec.inflight;
}

/** Test helpers. */
export function invalidate(key) {
  store.delete(key);
}

export function clear() {
  store.clear();
}

export function size() {
  return store.size;
}
