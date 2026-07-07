/**
 * get_market_data (Tool 2) — prices, peg health, CHF-stablecoin comparison, macro.
 *
 * ⚠️ Behavior change: WITHOUT COINGECKO_API_KEY this DEGRADES to partial data + a
 * top-level note (the old server hard-failed). Frankencoin-API-sourced fields
 * (prices/list, FPS, ZCHF peg, CHFAU on-chain supply) stay populated; CoinGecko-
 * derived fields (macro, 24h change, market caps, CHF-stablecoin table) become null.
 */

import { apiFetch } from "../upstream/frankencoin.js";
import { cgFetch } from "../upstream/coingecko.js";
import { ethCall } from "../upstream/eth.js";
import { config } from "../config.js";
import { COINGECKO_IDS, CHFAU_CONTRACT } from "../lib/constants.js";
import { pegDeviation, pegStatus, round } from "../lib/numbers.js";

const CG_ABSENT_NOTE = "CoinGecko API key not configured — market/macro fields unavailable";

/** Await a promise, returning null on any rejection (best-effort CoinGecko calls). */
async function safe(p) {
  try { return await p; } catch { return null; }
}

export async function getMarketData() {
  const hasCg = !!config.coingeckoKey;
  const collateralCgIds = [...new Set(Object.values(COINGECKO_IDS))].join(",");

  const [fcPrices, chfauSupplyHex, zchfData, macroData, collateralData, globalData, chfStableData] =
    await Promise.all([
      apiFetch("/prices/list"),
      safe(ethCall(CHFAU_CONTRACT, "0x18160ddd")),
      hasCg ? safe(cgFetch(`/simple/price?ids=frankencoin&vs_currencies=usd,chf&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true`)) : null,
      hasCg ? safe(cgFetch(`/simple/price?ids=bitcoin,ethereum&vs_currencies=usd,chf&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true`)) : null,
      hasCg ? safe(cgFetch(`/simple/price?ids=${collateralCgIds}&vs_currencies=usd,chf&include_24hr_change=true&include_market_cap=true`)) : null,
      hasCg ? safe(cgFetch(`/global`)) : null,
      hasCg ? safe(cgFetch(`/coins/markets?vs_currency=chf&ids=frankencoin,vnx-swiss-franc&order=market_cap_desc&sparkline=false&price_change_percentage=24h`)) : null,
    ]);

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
    priceUsd: t.price?.usd,
    priceChf: t.price?.chf,
    source: t.source,
    updatedAt: t.timestamp != null ? new Date(t.timestamp).toISOString() : null,
  }));

  const collateral = Object.entries(COINGECKO_IDS).map(([addr, cgId]) => {
    const cg = collateralData?.[cgId] || {};
    const fcEntry = (fcPrices || []).find((p) => p.address?.toLowerCase() === addr);
    return {
      symbol: fcEntry?.symbol ?? cgId,
      name: fcEntry?.name ?? cgId,
      address: addr,
      priceUsd: cg.usd ?? fcEntry?.price?.usd ?? null,
      priceChf: fcEntry?.price?.chf ?? cg.chf ?? null,
      change24hPercent: cg.usd_24h_change != null ? round(cg.usd_24h_change, 2) : null,
      marketCapUsd: cg.usd_market_cap ? Math.round(cg.usd_market_cap) : null,
    };
  }).sort((a, b) => (b.marketCapUsd ?? 0) - (a.marketCapUsd ?? 0));

  const zchfCg = (chfStableData || []).find((c) => c.id === "frankencoin") || {};
  const vchfCg = (chfStableData || []).find((c) => c.id === "vnx-swiss-franc") || {};

  let chfauSupply = null;
  try {
    if (chfauSupplyHex && chfauSupplyHex !== "0x") chfauSupply = Math.round(Number(BigInt(chfauSupplyHex)) / 1e6);
  } catch { chfauSupply = null; }

  const cmp = (cg) => ({
    priceChf: cg.current_price ?? null,
    pegDeviationPercent: cg.current_price != null ? round((cg.current_price - 1) * 100, 4) : null,
    pegStatus: pegStatus(cg.current_price ?? null),
    marketCapChf: cg.market_cap ?? null,
    volume24hChf: cg.total_volume ?? null,
    change24hPercent: cg.price_change_percentage_24h != null ? round(cg.price_change_percentage_24h, 4) : null,
    circulatingSupply: cg.circulating_supply ?? null,
  });

  const chfStablecoins = [
    { name: "Frankencoin", symbol: "ZCHF", type: "CDP / overcollateralised", issuer: "Frankencoin Association", ...cmp(zchfCg) },
    { name: "VNX Swiss Franc", symbol: "VCHF", type: "Fiat-backed", issuer: "VNX", ...cmp(vchfCg) },
    {
      name: "AllUnity CHF", symbol: "CHFAU", type: "Fiat-backed", issuer: "AllUnity (DWS + Flow Traders + Galaxy)",
      priceChf: null, pegDeviationPercent: null, pegStatus: "unknown",
      marketCapChf: null, volume24hChf: null, change24hPercent: null,
      circulatingSupply: chfauSupply,
      contract: CHFAU_CONTRACT,
      note: "No CoinGecko price feed yet — supply from on-chain (Ethereum, 6 decimals)",
    },
  ];

  const macroToken = (m) => ({
    priceUsd: m?.usd,
    priceChf: m?.chf,
    change24hPercent: m?.usd_24h_change != null ? round(m.usd_24h_change, 2) : null,
    volume24hUsd: m?.usd_24h_vol ?? null,
    marketCapUsd: m?.usd_market_cap ? Math.round(m.usd_market_cap) : null,
  });

  const result = {
    zchf: {
      priceUsd: zchf.usd ?? null,
      priceChf: zchfPriceChf,
      change24hPercent: zchf.usd_24h_change != null ? round(zchf.usd_24h_change, 2) : null,
      volume24hUsd: zchf.usd_24h_vol ?? null,
      marketCapUsd: zchf.usd_market_cap ?? null,
      pegDeviationPercent: dev != null ? round(dev, 4) : null,
      pegStatus: pegStatus(zchfPriceChf),
    },
    fps: {
      priceChf: fps?.price?.chf ?? null,
      priceUsd: fps?.price?.usd ?? null,
      note: "FPS is not listed on CoinGecko — price sourced from Frankencoin API",
    },
    prices,
    collateral,
    chfStablecoins,
    macro: {
      bitcoin: macroToken(macroData?.bitcoin),
      ethereum: macroToken(macroData?.ethereum),
    },
    defiTotalMarketCapUsd: globalData?.data?.total_market_cap?.usd
      ? Math.round(globalData.data.total_market_cap.usd) : null,
    updatedAt: new Date().toISOString(),
  };

  if (!hasCg) result.note = CG_ABSENT_NOTE;
  return result;
}
