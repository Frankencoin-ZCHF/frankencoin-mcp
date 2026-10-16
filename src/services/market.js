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
import { ethCall } from "../upstream/eth.js";
import { priceQuality } from "../lib/prices.js";
import { observe } from "../lib/provider.js";
import { COINGECKO_IDS, CHFAU_CONTRACT } from "../lib/constants.js";
import { pegDeviation, pegStatus, round, money, moneyPair, moneyFromUsd } from "../lib/numbers.js";
import { chfUsdRateFromPrices, fxBlock } from "./fx.js";

export async function getMarketData() {
  const collateralCgIds = [...new Set(Object.values(COINGECKO_IDS))].join(",");
  const [rawPrices, ...observed] = await Promise.all([
    apiFetch("/prices/list"),
    observe(ethCall(CHFAU_CONTRACT, "0x18160ddd"), (v) => typeof v === "string" && /^0x[0-9a-f]+$/i.test(v)),
    observe(cgFetch(`/simple/price?ids=frankencoin&vs_currencies=usd,chf&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true`), (v) => v?.frankencoin?.usd != null),
    observe(cgFetch(`/simple/price?ids=bitcoin,ethereum&vs_currencies=usd,chf&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true`), (v) => v?.bitcoin?.usd != null || v?.ethereum?.usd != null),
    observe(cgFetch(`/simple/price?ids=${collateralCgIds}&vs_currencies=usd,chf&include_24hr_change=true&include_market_cap=true`), (v) => v && Object.values(v).some((x) => x?.usd != null)),
    observe(cgFetch(`/global`), (v) => v?.data?.total_market_cap?.usd != null),
    observe(cgFetch(`/coins/markets?vs_currency=chf&ids=frankencoin,vnx-swiss-franc&order=market_cap_desc&sparkline=false&price_change_percentage=24h`), (v) => Array.isArray(v) && v.length > 0),
  ]);
  const fcPrices = (rawPrices || []).map((row) => priceQuality(row));
  const [chfauSupplyHex, zchfData, macroData, collateralData, globalData, chfStableData] = observed.map((r) => r.value);
  const names = ["chfauSupply", "coingeckoZchf", "coingeckoMacro", "coingeckoCollateral", "coingeckoGlobal", "coingeckoStablecoins"];
  const sources = Object.fromEntries(names.map((name, i) => [name, observed[i].health]));
  // A 200 with only part of the requested dataset is not full source availability.
  const expected = [null, ["frankencoin"], ["bitcoin", "ethereum"], collateralCgIds.split(","), null, ["frankencoin", "vnx-swiss-franc"]];
  observed.forEach((entry, i) => {
    if (!expected[i] || entry.health.status !== "available") return;
    const missing = expected[i].filter((id) => Array.isArray(entry.value)
      ? !entry.value.some((v) => v.id === id && v.current_price != null)
      : entry.value[id]?.usd == null);
    if (missing.length) Object.assign(entry.health, { status: "partial", missingFields: missing });
  });

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

  const collateral = Object.entries(COINGECKO_IDS).map(([addr, cgId]) => {
    const cg = collateralData?.[cgId] || {};
    const fcEntry = (fcPrices || []).find((p) => p.address?.toLowerCase() === addr);
    return {
      symbol: fcEntry?.symbol ?? cgId,
      name: fcEntry?.name ?? cgId,
      address: addr,
      freshness: fcEntry?.freshness ?? null,
      price: moneyPair(fcEntry?.price?.chf ?? cg.chf ?? null, cg.usd ?? fcEntry?.price?.usd ?? null),
      change24hPercent: cg.usd_24h_change != null ? round(cg.usd_24h_change, 2) : null,
      marketCap: moneyFromUsd(cg.usd_market_cap ? Math.round(cg.usd_market_cap) : null, rate),
    };
  }).sort((a, b) => (b.marketCap.usd ?? 0) - (a.marketCap.usd ?? 0));

  const zchfCg = (chfStableData || []).find((c) => c.id === "frankencoin") || {};
  const vchfCg = (chfStableData || []).find((c) => c.id === "vnx-swiss-franc") || {};

  let chfauSupply = null;
  try {
    if (chfauSupplyHex && chfauSupplyHex !== "0x") chfauSupply = Math.round(Number(BigInt(chfauSupplyHex)) / 1e6);
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

  const chfStablecoins = [
    { name: "Frankencoin", symbol: "ZCHF", type: "CDP / overcollateralised", issuer: null, issuerNote: "Decentralised protocol with no identifiable issuer, as described in the attributed MiCA legal assessment (see get_compliance).", steward: "Frankencoin Association", ...cmp(zchfCg) },
    { name: "VNX Swiss Franc", symbol: "VCHF", type: "Fiat-backed", issuer: "VNX", ...cmp(vchfCg) },
    {
      name: "AllUnity CHF", symbol: "CHFAU", type: "Fiat-backed", issuer: "AllUnity (DWS + Flow Traders + Galaxy)",
      price: moneyPair(null, null), pegDeviationPercent: null, pegStatus: "unknown",
      marketCap: moneyPair(null, null), volume24h: moneyPair(null, null), change24hPercent: null,
      circulatingSupply: chfauSupply,
      contract: CHFAU_CONTRACT,
      note: "No CoinGecko price feed yet — supply from on-chain (Ethereum, 6 decimals)",
    },
  ];

  // Macro CoinGecko data carries both usd and chf for price; caps/volumes are USD → derive CHF.
  const macroToken = (m) => ({
    price: moneyPair(m?.chf ?? null, m?.usd ?? null),
    change24hPercent: m?.usd_24h_change != null ? round(m.usd_24h_change, 2) : null,
    volume24h: moneyFromUsd(m?.usd_24h_vol ?? null, rate),
    marketCap: moneyFromUsd(m?.usd_market_cap ? Math.round(m.usd_market_cap) : null, rate),
  });

  const result = {
    status: observed.every((r) => r.health.status === "available") ? "available" : "partial",
    sources,
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
      note: "FPS is not listed on CoinGecko — price sourced from Frankencoin API",
    },
    prices,
    collateral,
    chfStablecoins,
    macro: {
      bitcoin: macroToken(macroData?.bitcoin),
      ethereum: macroToken(macroData?.ethereum),
    },
    defiTotalMarketCap: moneyFromUsd(
      globalData?.data?.total_market_cap?.usd ? Math.round(globalData.data.total_market_cap.usd) : null,
      rate,
    ),
    fx: fxBlock(rate),
    updatedAt: new Date().toISOString(),
  };

  if (result.status !== "available") result.note = "Optional market sources unavailable or not configured; inspect sources. Public API prices remain available. checkedAt assesses a cached response, not provider freshness; asOf is null when not supplied.";
  return result;
}
