import { getOrLoad } from "../cache.js";
import { fetchJson } from "../upstream/client.js";
import { UpstreamError } from "../lib/errors.js";
import { ledgerToken } from "./ledgers.js";

const networks = {
  1: "ethereum",
  10: "optimism",
  100: "gnosischain",
  137: "polygon",
  146: "sonic",
  8453: "base",
  42161: "arbitrum",
  43114: "avalanche",
};
const addr = /^0x[\da-f]{40}$/i;
const identifier = /^0x(?:[\da-f]{40}|[\da-f]{64})$/i;
const metric = (v) => (Number.isFinite(v) && v >= 0 ? v : null);
export function pools({ chainId, asset }) {
  const token = ledgerToken(chainId, asset),
    network = networks[chainId];
  return getOrLoad("dex-pools:" + network + ":" + token, 30_000, async () => {
    const rows = await fetchJson(
      "https://api.dexscreener.com/token-pairs/v1/" + network + "/" + token,
      { source: "dexscreener", timeout: 6000, retries: 0 },
    );
    if (!Array.isArray(rows)) throw new UpstreamError("dexscreener");
    const pools = rows.map((row) => {
      const base = row?.baseToken?.address?.toLowerCase(),
        quote = row?.quoteToken?.address?.toLowerCase();
      if (
        row?.chainId !== network ||
        !addr.test(base) ||
        !addr.test(quote) ||
        ![base, quote].includes(token) ||
        !identifier.test(row?.pairAddress)
      )
        throw new UpstreamError("dexscreener");
      return {
        poolId: row.pairAddress.toLowerCase(),
        dex: /^[a-z0-9_-]{1,40}$/i.test(row.dexId) ? row.dexId : null,
        base,
        quote,
        liquidityUsd: metric(row.liquidity?.usd),
        volume24hUsd: metric(row.volume?.h24),
      };
    });
    return {
      chainId,
      asset,
      token,
      pools,
      retrievedAt: new Date().toISOString(),
      source: "DEX Screener",
      scope:
        "Provider-listed pairs only. Pool liquidity is inventory, not executable depth.",
    };
  });
}
