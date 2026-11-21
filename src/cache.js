/** Process-local LRU cache. Active reads are coalesced and retain their slots until settled. */
import { config } from "./config.js";
import { BusyError } from "./lib/errors.js";

const store = new Map();
let bytes = 0;

export function invalidate(key) {
  const entry = store.get(key);
  if (entry) bytes -= entry.bytes;
  store.delete(key);
}

function evictSettled() {
  for (const [key, entry] of store) {
    if (!entry.inflight) {
      invalidate(key);
      return true;
    }
  }
  return false;
}

function remember(key, entry, value, ttlMs, swrMs) {
  // Explicit invalidation during a load must also invalidate its eventual result.
  if (store.get(key) !== entry) return;
  let weight;
  try {
    weight = Buffer.byteLength(JSON.stringify(value)) + Buffer.byteLength(key);
  } catch {
    invalidate(key);
    return;
  }
  if (weight > config.cacheMaxBytes) {
    invalidate(key);
    return;
  }
  bytes += weight - entry.bytes;
  entry.bytes = weight;
  while (bytes > config.cacheMaxBytes) {
    if (!evictSettled()) {
      invalidate(key);
      return;
    }
  }
  entry.value = value;
  entry.expiresAt = Date.now() + ttlMs;
  entry.staleUntil = entry.expiresAt + swrMs;
}

export async function getOrLoad(key, ttlMs, loader, { swrMs = 0 } = {}) {
  if (!config.cacheEnabled) return loader();
  let entry = store.get(key);
  if (entry) {
    store.delete(key);
    store.set(key, entry);
    if (Date.now() < entry.expiresAt) return entry.value;
  } else {
    if (store.size >= config.cacheMaxEntries && !evictSettled())
      throw new BusyError();
    entry = { bytes: 0, expiresAt: 0, staleUntil: 0, inflight: null };
    store.set(key, entry);
  }
  const serveStale = swrMs > 0 && Date.now() < entry.staleUntil;
  if (!entry.inflight) {
    entry.inflight = Promise.resolve()
      .then(loader)
      .then((value) => {
        remember(key, entry, value, ttlMs, swrMs);
        return value;
      })
      .catch((error) => {
        if (store.get(key) === entry && Date.now() >= entry.staleUntil)
          invalidate(key);
        throw error;
      })
      .finally(() => {
        entry.inflight = null;
      });
    if (serveStale) entry.inflight.catch(() => {}); // The next request can retry the refresh.
  }
  return serveStale ? entry.value : entry.inflight;
}

export function clear() {
  store.clear();
  bytes = 0;
}
export function size() {
  return store.size;
}
