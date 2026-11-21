import { config } from "../config.js";
import { getOrLoad } from "../cache.js";
import { fetchJson } from "../upstream/client.js";
/**
 * get_market_data (Tool 2) — prices, peg health, CHF-stablecoin comparison, macro.
 *
 * Every monetary figure is a { chf, usd } pair. Where a source gives only one side
 * (CoinGecko caps/volumes in USD, or the CHF-stablecoin table in CHF), the other is
 * derived at the current CHF/USD rate (see the top-level `fx` block).
 *
 * ⚠️ Behavior change: WITHOUT COINGECKO_API_KEY this DEGRADES to partial data + a
 * top-level note (the old server hard-failed). Frankencoin-API-sourced fields
 * (prices/list, FPS, ZCHF peg, CHFAU on-chain supply) stay populated; CoinGecko-
 * derived fields (macro, 24h change, market caps, CHF-stablecoin table) become null.
 */

import { apiFetch } from "../upstream/frankencoin.js";
import { cgFetch } from "../upstream/coingecko.js";
import { ethReadBatch } from "../upstream/eth.js";
import { freshness } from "../lib/freshness.js";
import { priceQuality } from "../lib/prices.js";
import { observe } from "../lib/provider.js";
import { observeMetrics } from "../lib/metric-coverage.js";
import { CHFAU_CONTRACT } from "../lib/constants.js";
import { pegDeviation, pegStatus, round, money, moneyPair, moneyFromUsd } from "../lib/numbers.js";
import { chfUsdRateFromPrices, fxBlock } from "./fx.js";

import { collateralPrices } from "./collateral-prices.js";
import { UpstreamError } from "../lib/errors.js";

async function peerMarkets() {
  const rows = [];
  for (let page = 1; page <= 10; page++) {
    const path = "/coins/markets?vs_currency=chf&category=chf-stablecoin&per_page=100&page=" + page;
    const part = config.coingeckoKey ? await cgFetch(path) : await getOrLoad("public-cg:" + path, 120_000,
      () => fetchJson("https://api.coingecko.com/api/v3" + path, { source: "coingecko-public", timeout: 5000, retries: 0 }));
    if (!Array.isArray(part) || !part.every((c) => c?.id && typeof c.symbol === "string" && typeof c.name === "string")) throw new UpstreamError("coingecko");
    rows.push(...part);
    if (part.length < 100) return rows;
  }
  throw new UpstreamError("coingecko");
}

export async function getMarketData() {
  const registry = observe(apiFetch("/ecosystem/collateral/list"), (v) => Array.isArray(v?.list) && v.list.every((c) => Number.isSafeInteger(c?.chainId) && /^0x[0-9a-f]{40}$/i.test(c.address)));
  const metrics = ["usd", "chf", "usd_24h_change", "usd_market_cap"];
  const [rawPrices, ...observed] = await Promise.all([
    apiFetch("/prices/list"),
    observe(ethReadBatch(CHFAU_CONTRACT, ["0x18160ddd", "0x313ce567"]), (r) => r?.values?.length === 2 && BigInt(r.values[1]) <= 255n),
    observeMetrics(cgFetch(`/simple/price?ids=frankencoin&vs_currencies=usd,chf&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true`), ["frankencoin"], [...metrics, "usd_24h_vol"]),
    observeMetrics(cgFetch(`/simple/price?ids=bitcoin,ethereum&vs_currencies=usd,chf&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true`), ["bitcoin", "ethereum"], [...metrics, "usd_24h_vol"]),
    registry.then((r) => collateralPrices((r.value?.list ?? []).filter((c) => c.chainId === 1).map((c) => c.address))),
    observe(cgFetch(`/global`), (v) => Number.isFinite(v?.data?.total_market_cap?.usd)),
    observe(peerMarkets(), Array.isArray),
  ]);
  const peerSource = observed.at(-1);
  const peerFields = ["current_price", "market_cap", "total_volume", "price_change_percentage_24h", "circulating_supply"];
  if (peerSource.value?.length) {
    const missing = peerSource.value.flatMap((row) => peerFields.filter((key) => !Number.isFinite(row[key])).map((key) => row.id + "." + key));
    if (missing.length) Object.assign(peerSource.health, { status: "partial", missingFields: missing });
    peerSource.value = peerSource.value.map((r) => ({ ...r, ...Object.fromEntries(peerFields.map((key) => [key, Number.isFinite(r[key]) ? r[key] : null])) }));
  }
  const fcPrices = (rawPrices || []).map((row) => priceQuality(row));
  const [chfauObservation, zchfData, macroData, collateralData, globalData, chfStableData] = observed.map((r) => r.value);
  const names = ["chfauSupply", "coingeckoZchf", "coingeckoMacro", "coingeckoCollateral", "coingeckoGlobal", "coingeckoStablecoins"];
  const sources = Object.fromEntries(names.map((name, i) => [name, observed[i].health]));

  const chfauSupplyHex = chfauObservation?.values[0];
  sources.chfauSupply = { ...sources.chfauSupply, ...(chfauObservation ? { ...chfauObservation.block, asOf: chfauObservation.block.measuredAt, freshness: freshness(chfauObservation.block.measuredAt, 600) } : {}) };

  const rate = chfUsdRateFromPrices(fcPrices);
  const fps = (fcPrices || []).find((p) => p.symbol === "FPS");
  const zchfEntry = (fcPrices || []).find((p) => p.symbol === "ZCHF");
  const zchf = zchfData?.frankencoin || {};
  const zchfPriceChf = zchfEntry?.price?.chf ?? zchf.chf ?? null;
  const dev = pegDeviation(zchfPriceChf);

  const prices = (fcPrices || []).map((t) => ({
    chainId: t.chainId,
    address: t.address,
    name: t.name,
    symbol: t.symbol,
    price: moneyPair(t.price?.chf, t.price?.usd),
    source: t.source,
    updatedAt: t.updatedAt,
    freshness: t.freshness,
  }));

  const catalogue = await registry;
  sources.collateralCatalogue = catalogue.health;
  const collateral = catalogue.value?.list.map((entry) => {
    const addr = entry.address.toLowerCase();
    const cg = (entry.chainId === 1 ? collateralData?.[addr] : null) || {};
    const fcEntry = (fcPrices || []).find((p) => p.chainId === entry.chainId && p.address?.toLowerCase() === addr);
    return {
      symbol: entry.symbol,
      name: entry.name,
      address: addr, chainId: entry.chainId,
      freshness: fcEntry?.freshness ?? null,
      price: moneyPair(fcEntry?.price?.chf ?? cg.chf ?? null, cg.usd ?? fcEntry?.price?.usd ?? null),
      change24hPercent: cg.usd_24h_change != null ? round(cg.usd_24h_change, 2) : null,
      marketCap: moneyFromUsd(cg.usd_market_cap != null ? Math.round(cg.usd_market_cap) : null, rate),
    };
  }).sort((a, b) => (b.marketCap.usd ?? 0) - (a.marketCap.usd ?? 0));

  let chfauSupply = null;
  try {
    if (chfauSupplyHex && chfauSupplyHex !== "0x") chfauSupply = Number(BigInt(chfauSupplyHex)) / 10 ** Number(BigInt(chfauObservation.values[1]));
  } catch { chfauSupply = null; }

  // CHF-stablecoin CoinGecko data is denominated in CHF (vs_currency=chf) → derive USD.
  const cmp = (cg) => ({
    price: money(cg.current_price ?? null, rate),
    pegDeviationPercent: cg.current_price != null ? round((cg.current_price - 1) * 100, 4) : null,
    pegStatus: pegStatus(cg.current_price ?? null),
    marketCap: money(cg.market_cap ?? null, rate),
    volume24h: money(cg.total_volume ?? null, rate),
    change24hPercent: cg.price_change_percentage_24h != null ? round(cg.price_change_percentage_24h, 4) : null,
    circulatingSupply: cg.circulating_supply ?? null,
  });

  const chfStablecoins = chfStableData?.map((coin) => ({
    id: coin.id, name: coin.name, symbol: coin.symbol.toUpperCase(), ...cmp(coin),
  })) ?? [];
  if (zchfEntry && !chfStablecoins.some((c) => c.id === "frankencoin")) {
    chfStablecoins.push({ id: "frankencoin", name: zchfEntry.name, symbol: zchfEntry.symbol,
      ...cmp({ current_price: zchfPriceChf }), source: "Frankencoin prices" });
  }
  const self = chfStablecoins.find((c) => c.id === "frankencoin");
  if (self) Object.assign(self, { issuer: null, steward: "Frankencoin Association",
    issuerNote: "The attributed MiCA assessment describes a protocol with no identifiable issuer (see get_compliance)." });
  // This independently verified supply read remains available during peer discovery outages.
  const chfau = chfStablecoins?.find((coin) => coin.id === "allunity-chf");
  const supplyObservation = { contract: CHFAU_CONTRACT, totalSupply: chfauSupply,
    supplyScope: "Ethereum ERC-20 totalSupply", source: sources.chfauSupply };
  if (chfau) Object.assign(chfau, supplyObservation);

  // Macro CoinGecko data carries both usd and chf for price; caps/volumes are USD → derive CHF.
  const macroToken = (m) => ({
    price: moneyPair(m?.chf ?? null, m?.usd ?? null),
    change24hPercent: m?.usd_24h_change != null ? round(m.usd_24h_change, 2) : null,
    volume24h: moneyFromUsd(m?.usd_24h_vol ?? null, rate),
    marketCap: moneyFromUsd(m?.usd_market_cap != null ? Math.round(m.usd_market_cap) : null, rate),
  });

  const result = {
    status: catalogue.health.status === "available" && observed.every((r) => r.health.status === "available") ? "available" : "partial",
    sources,
    pegPolicy: { warningBps: config.pegWarningBps, criticalBps: config.pegCriticalBps },
    zchf: {
      price: moneyPair(zchfPriceChf, zchf.usd ?? zchfEntry?.price?.usd ?? null),
      change24hPercent: zchf.usd_24h_change != null ? round(zchf.usd_24h_change, 2) : null,
      volume24h: moneyFromUsd(zchf.usd_24h_vol ?? null, rate),
      marketCap: moneyFromUsd(zchf.usd_market_cap ?? null, rate),
      pegDeviationPercent: dev != null ? round(dev, 4) : null,
      pegStatus: pegStatus(zchfPriceChf),
    },
    fps: {
      price: moneyPair(fps?.price?.chf ?? null, fps?.price?.usd ?? null),
      note: "FPS price sourced from the Frankencoin API",
    },
    prices,
    collateral: collateral ?? null,
    chfauSupply: supplyObservation,
    chfStablecoins: chfStableData || chfStablecoins.length ? chfStablecoins : null,
    macro: {
      bitcoin: macroToken(macroData?.bitcoin),
      ethereum: macroToken(macroData?.ethereum),
    },
    defiTotalMarketCap: moneyFromUsd(
      globalData?.data?.total_market_cap?.usd != null ? Math.round(globalData.data.total_market_cap.usd) : null,
      rate,
    ),
    fx: fxBlock(rate),
    updatedAt: new Date().toISOString(),
  };

  if (result.status !== "available") result.note = "Optional market sources unavailable or not configured; inspect sources. Public API prices remain available. checkedAt assesses a cached response, not provider freshness; asOf is null when not supplied.";
  return result;
}
