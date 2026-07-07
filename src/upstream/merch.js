/**
 * Merch (Shopify) products feed. Cached 30 min + SWR — catalog is not time-critical.
 */

import { fetchJson } from "./client.js";
import { getOrLoad } from "../cache.js";
import { MERCH_URL } from "../lib/constants.js";

export function merchProducts() {
  return getOrLoad(
    "merch:products",
    30 * 60_000,
    () => fetchJson(MERCH_URL, {
      source: "merch",
      timeout: 10_000,
      headers: { Accept: "application/json" },
    }),
    { swrMs: 15 * 60_000 },
  );
}
