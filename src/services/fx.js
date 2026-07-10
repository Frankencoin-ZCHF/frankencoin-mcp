/**
 * CHF↔USD rate, the single source used to dual-denominate every monetary figure.
 *
 * Derived from the ZCHF price feed itself (usd / chf on /prices/list) so it tracks any
 * live peg deviation rather than assuming 1 CHF = 1 ZCHF. /prices/list is already cached
 * at the upstream boundary, so this is effectively free and shared across tools.
 *
 * There is NO historical rate — this is the *current* rate only. Applying it to a past
 * value yields an approximation, not the historical USD figure (see get_analytics).
 */

import { apiFetch } from "../upstream/frankencoin.js";

export const FX_SOURCE = "ZCHF price feed (api.frankencoin.com/prices/list)";

/** Compute the CHF→USD rate from an already-fetched /prices/list array. Null if absent. */
export function chfUsdRateFromPrices(prices) {
  const zchf = (Array.isArray(prices) ? prices : []).find((p) => p.symbol === "ZCHF");
  const chf = zchf?.price?.chf;
  const usd = zchf?.price?.usd;
  if (Number.isFinite(chf) && Number.isFinite(usd) && chf !== 0) return usd / chf;
  return null;
}

/** Fetch (cached) and return the current CHF→USD rate, or null if unavailable. */
export async function getChfUsdRate() {
  try {
    return chfUsdRateFromPrices(await apiFetch("/prices/list"));
  } catch {
    return null;
  }
}

/** Standard `fx` block attached to every dual-denominated response. */
export function fxBlock(rate, extra) {
  return {
    chfUsd: rate,
    source: FX_SOURCE,
    note: "USD figures are derived from CHF at the current CHF/USD rate.",
    ...(extra || {}),
  };
}
