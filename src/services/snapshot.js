/**
 * get_protocol_snapshot (Tool 1) — full live protocol state in one call (SPEC §Tool 1).
 * Warm caches mean a repeated snapshot may issue zero outbound calls.
 */

import { apiFetch } from "../upstream/frankencoin.js";
import { chainName } from "../lib/constants.js";
import { getSavings } from "./savings.js";
import { getChallenges } from "./positions.js";

export async function getProtocolSnapshot() {
  const [infoData, fpsData, savings, challenges] = await Promise.all([
    apiFetch("/ecosystem/frankencoin/info"),
    apiFetch("/ecosystem/fps/info"),
    getSavings(),
    getChallenges({ limit: 5 }),
  ]);

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
      priceUsd: infoData.token?.usd,
      tvl: { chf: infoData.tvl?.chf, usd: infoData.tvl?.usd },
      chains,
    },
    fps: {
      name: fpsData.erc20?.name,
      symbol: fpsData.erc20?.symbol,
      address: fpsData.chains?.[1]?.address,
      priceChf: infoData.fps?.price,
      priceUsd: fpsData.token?.price,
      totalSupply: infoData.fps?.totalSupply,
      marketCapChf: infoData.fps?.marketCap,
      marketCapUsd: fpsData.token?.marketCap,
      earnings: {
        profitChf: fpsData.earnings?.profit,
        lossChf: fpsData.earnings?.loss,
        netChf: (fpsData.earnings?.profit || 0) - (fpsData.earnings?.loss || 0),
      },
      reserve: {
        totalChf: fpsData.reserve?.balance,
        equityChf: fpsData.reserve?.equity,
        minterReserveChf: fpsData.reserve?.minter,
      },
    },
    savings: {
      leadRatePercent: leadRate?.ratePercent ?? null,
      baseRatePercent: baseRate?.ratePercent ?? null,
      pendingRateChanges: savings.rates.proposed.length,
      totalDepositedChf: savings.stats.reduce((sum, s) => sum + s.balanceChf, 0),
    },
    challenges: {
      total: challenges.total,
      active: challenges.active,
      recent: activeChallenges.slice(0, 3),
    },
    updatedAt: new Date().toISOString(),
  };
}
