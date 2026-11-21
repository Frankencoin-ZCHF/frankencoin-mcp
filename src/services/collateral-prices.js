import { cgFetch } from "../upstream/coingecko.js";
import { observeMetrics } from "../lib/metric-coverage.js";

// The v1/v2 positions index is on Ethereum. Match by contract, including assets
// with colliding tickers. CoinGecko accepts up to 30 contracts per request.
export async function collateralPrices(addresses) {
  const ids = [...new Set(addresses.filter((a) => /^0x[0-9a-f]{40}$/i.test(a)).map((a) => a.toLowerCase()))].sort();
  if (!ids.length) return { value: {}, health: { status: "not_requested", asOf: null } };
  const requests = [];
  for (let i = 0; i < ids.length; i += 30) {
    const batch = ids.slice(i, i + 30);
    requests.push(observeMetrics(cgFetch("/simple/token_price/ethereum?contract_addresses=" + batch.join(",") +
      "&vs_currencies=usd,chf&include_24hr_change=true&include_market_cap=true"), batch,
      ["usd", "chf", "usd_24h_change", "usd_market_cap"]));
  }
  const results = await Promise.all(requests);
  if (results.length === 1) return results[0];
  const status = results.every((r) => r.health.status === "available") ? "available" :
    results.some((r) => r.value) ? "partial" : "unavailable";
  return { value: Object.assign({}, ...results.map((r) => r.value)), health: { status, batches: results.map((r) => r.health) } };
}
