import { getOrLoad } from "../cache.js";
import { fetchJson } from "../upstream/client.js";
import { UpstreamError } from "../lib/errors.js";
import { ledgerToken } from "./ledgers.js";

const tenMinutes = 600_000;
const options = (source) => ({ source, timeout: 6000, retries: 0 });

// Cache confirmed (including empty) catalogues for ten minutes. A failed refresh
// has unknown coverage; coalesce and retry it after thirty seconds.
async function discover(key, source, load) {
  return getOrLoad("market-attempt:" + key, 30_000, async () => {
    try {
      return await getOrLoad("market-list:" + key, tenMinutes, async () => ({
        status: "available",
        source,
        observedAt: new Date().toISOString(),
        ...(await load()),
      }));
    } catch {
      return { status: "unavailable", source, observedAt: null, markets: null };
    }
  });
}

export function krakenMarkets() {
  return discover("kraken-zchf", "Kraken AssetPairs", async () => {
    const reply = await fetchJson(
      "https://api.kraken.com/0/public/AssetPairs",
      options("kraken"),
    );
    if (
      !Array.isArray(reply?.error) ||
      reply.error.length ||
      !reply.result ||
      typeof reply.result !== "object" ||
      Array.isArray(reply.result) ||
      !Object.keys(reply.result).length
    )
      throw new UpstreamError("kraken");
    const markets = [];
    for (const [pair, entry] of Object.entries(reply.result)) {
      if (!entry || typeof entry.base !== "string")
        throw new UpstreamError("kraken");
      if (entry.base !== "ZCHF" || entry.status !== "online") continue;
      const [base, quote, extra] = String(entry.wsname).split("/");
      if (
        base !== "ZCHF" ||
        extra ||
        !/^[A-Z0-9.-]{1,24}$/.test(quote ?? "") ||
        !/^[A-Za-z0-9.-]{1,48}$/.test(pair)
      )
        throw new UpstreamError("kraken");
      markets.push({ pair, base, quote });
    }
    return { markets: markets.sort((a, b) => a.pair.localeCompare(b.pair)) };
  });
}

export function indexedMarkets(asset) {
  return discover("tickers:" + asset, "CoinGecko tickers", async () => {
    const api = "https://api.coingecko.com/api/v3";
    let id = "frankencoin";
    if (asset !== "ZCHF") {
      const token = ledgerToken(1, asset);
      const coin = await fetchJson(
        api + "/coins/ethereum/contract/" + token,
        options("coingecko-public"),
      );
      if (
        coin?.platforms?.ethereum?.toLowerCase() !== token ||
        !/^[a-z0-9-]{1,100}$/.test(coin.id)
      )
        throw new UpstreamError("coingecko-public");
      id = coin.id;
    }
    const markets = new Map();
    for (let page = 1; page <= 3; page++) {
      const r = await fetchJson(
        api + "/coins/" + id + "/tickers?page=" + page,
        options("coingecko-public"),
      );
      if (!Array.isArray(r?.tickers))
        throw new UpstreamError("coingecko-public");
      for (const t of r.tickers) {
        if (
          (t.coin_id !== id && t.target_coin_id !== id) ||
          t.is_stale !== false ||
          t.is_anomaly !== false
        )
          continue;
        const exchange = t.market?.identifier;
        if (
          ![exchange, t.base, t.target].every(
            (x) => typeof x === "string" && x.length > 0 && x.length <= 160,
          )
        )
          continue;
        markets.set(JSON.stringify([exchange, t.base, t.target]), {
          exchange,
          base: t.base,
          quote: t.target,
        });
      }
      if (r.tickers.length < 100)
        return { markets: [...markets.values()], truncated: false };
    }
    return { markets: [...markets.values()], truncated: true };
  });
}
