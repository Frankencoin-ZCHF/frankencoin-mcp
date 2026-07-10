/**
 * get_protocol_snapshot (Tool 1) — full live protocol state in one call (SPEC §Tool 1).
 * Warm caches mean a repeated snapshot may issue zero outbound calls.
 */

import { apiFetch } from "../upstream/frankencoin.js";
import { chainName } from "../lib/constants.js";
import { money, moneyPair, round } from "../lib/numbers.js";
import { chfUsdRateFromPrices, fxBlock } from "./fx.js";
import { getSavings } from "./savings.js";
import { getChallenges } from "./positions.js";

export async function getProtocolSnapshot() {
  const [infoData, fpsData, prices, savings, challenges] = await Promise.all([
    apiFetch("/ecosystem/frankencoin/info"),
    apiFetch("/ecosystem/fps/info"),
    apiFetch("/prices/list"),
    getSavings(),
    getChallenges({ limit: 5 }),
  ]);

  // FPS USD price: /ecosystem/fps/info.token.price is CHF-denominated (despite the
  // bare "price" name), so using it as priceUsd made USD == CHF. /prices/list carries
  // the correct chf/usd split — the SAME source get_market_data trusts. Keep the two
  // tools consistent by sourcing FPS pricing here too.
  const priceList = Array.isArray(prices) ? prices : [];
  const fpsPrice = priceList.find((p) => p.symbol === "FPS");
  const zchfPrice = priceList.find((p) => p.symbol === "ZCHF");
  const fpsPriceChf = fpsPrice?.price?.chf ?? infoData.fps?.price ?? null;
  const fpsPriceUsd = fpsPrice?.price?.usd ?? null;
  const fpsSupply = infoData.fps?.totalSupply ?? fpsData.token?.totalSupply ?? null;

  // CHF→USD rate from the ZCHF feed (falls back to token.usd, ≈ the peg rate).
  const rate = chfUsdRateFromPrices(priceList) ?? infoData.token?.usd ?? null;

  const chains = Object.entries(infoData.chains || {}).map(([id, c]) => ({
    chainId: Number(id),
    chainName: chainName(id),
    address: c.address,
    supply: c.supply,
    sharePercent: infoData.token?.supply
      ? Number(((c.supply / infoData.token.supply) * 100).toFixed(1))
      : null,
    mintEvents: c.counter?.mint,
    burnEvents: c.counter?.burn,
    updated: new Date(c.updated * 1000).toISOString(),
  }));

  // Lead vs base rate on Ethereum by the bps×10 threshold (10000 = base, >10000 = savings).
  const leadRate = savings.rates.approved.find((r) => r.chainId === 1 && r.rateBps > 10000);
  const baseRate = savings.rates.approved.find((r) => r.chainId === 1 && r.rateBps === 10000);
  const activeChallenges = challenges.challenges.filter((c) => c.status !== "Success");

  return {
    zchf: {
      name: infoData.erc20?.name,
      symbol: infoData.erc20?.symbol,
      totalSupply: infoData.token?.supply,
      price: moneyPair(zchfPrice?.price?.chf ?? null, zchfPrice?.price?.usd ?? infoData.token?.usd ?? null),
      tvl: moneyPair(infoData.tvl?.chf, infoData.tvl?.usd),
      chains,
    },
    fps: {
      name: fpsData.erc20?.name,
      symbol: fpsData.erc20?.symbol,
      address: fpsData.chains?.[1]?.address,
      price: moneyPair(fpsPriceChf, fpsPriceUsd),
      totalSupply: fpsSupply,
      marketCap: moneyPair(
        infoData.fps?.marketCap,
        (fpsPriceUsd != null && fpsSupply != null) ? round(fpsPriceUsd * fpsSupply, 2) : null,
      ),
      earnings: {
        window: "cumulative",
        profit: money(fpsData.earnings?.profit, rate),
        loss: money(fpsData.earnings?.loss, rate),
        net: money((fpsData.earnings?.profit || 0) - (fpsData.earnings?.loss || 0), rate),
        note: "All-time totals accrued to the FPS reserve since inception. For annual/daily windows use get_analytics.",
      },
      reserve: {
        total: money(fpsData.reserve?.balance, rate),
        equity: money(fpsData.reserve?.equity, rate),
        minter: money(fpsData.reserve?.minter, rate),
      },
    },
    savings: {
      leadRatePercent: leadRate?.ratePercent ?? null,
      baseRatePercent: baseRate?.ratePercent ?? null,
      pendingRateChanges: savings.rates.proposed.length,
      totalDeposited: savings.summary.totalDeposited,
    },
    challenges: {
      total: challenges.total,
      active: challenges.active,
      recent: activeChallenges.slice(0, 3),
    },
    fx: fxBlock(rate),
    updatedAt: new Date().toISOString(),
  };
}
