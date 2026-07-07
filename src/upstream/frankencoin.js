/**
 * Frankencoin REST client (api.frankencoin.com). No auth. Cached at this boundary
 * so a single /prices/list fetch is shared across snapshot/market/positions/challenges.
 */

import { fetchJson } from "./client.js";
import { getOrLoad } from "../cache.js";
import { API_BASE } from "../lib/constants.js";

// Endpoints that change rarely get a long TTL + SWR (ARCHITECTURE §B TTL table).
const LONG_TTL = { ttl: 60 * 60_000, swr: 15 * 60_000 };
const SHORT_TTL = { ttl: 30_000, swr: 0 };

function ttlFor(path) {
  return path === "/ecosystem/collateral/list" ? LONG_TTL : SHORT_TTL;
}

export function apiFetch(path) {
  const { ttl, swr } = ttlFor(path);
  return getOrLoad(
    `fc:${path}`,
    ttl,
    () => fetchJson(`${API_BASE}${path}`, {
      source: "frankencoin",
      timeout: 10_000,
      headers: { Accept: "application/json" },
    }),
    { swrMs: swr },
  );
}
