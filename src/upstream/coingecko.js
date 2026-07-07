/**
 * CoinGecko Pro client. Degradable: throws MissingSecretError (WITHOUT touching the
 * network) when no key is configured — services catch it and degrade (ARCHITECTURE §C).
 * Secret header is attached only to the CoinGecko host; redirect:"error" ensures the
 * key never travels cross-host (SECURITY §7).
 */

import { fetchJson } from "./client.js";
import { getOrLoad } from "../cache.js";
import { config } from "../config.js";
import { CG_BASE } from "../lib/constants.js";
import { MissingSecretError } from "../lib/errors.js";

function ttlFor(path) {
  // /global and /coins/markets move slowly — protect quota harder.
  return path.startsWith("/global") || path.startsWith("/coins/markets") ? 120_000 : 60_000;
}

// async so the missing-secret case rejects rather than throwing synchronously.
export async function cgFetch(path) {
  if (!config.coingeckoKey) throw new MissingSecretError("coingecko");
  return getOrLoad(
    `cg:${path}`,
    ttlFor(path),
    () => fetchJson(`${CG_BASE}${path}`, {
      source: "coingecko",
      timeout: 10_000,
      redirect: "error",
      headers: { "x-cg-pro-api-key": config.coingeckoKey, Accept: "application/json" },
    }),
  );
}
