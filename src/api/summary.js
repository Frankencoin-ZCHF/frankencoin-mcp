/**
 * High-level protocol summary (combines protocol + savings + challenges).
 */

import { getProtocolInfo, getFpsInfo, getSavingsRates } from "./protocol.js";
import { getChallenges } from "./positions.js";

export async function getProtocolSummary() {
  const [info, fps, savings, challenges] = await Promise.all([
    getProtocolInfo(),
    getFpsInfo(),
    getSavingsRates(),
    getChallenges({ limit: 5 }),
  ]);

  const leadRate = savings.approved.find((r) => r.chainId === 1 && r.rateBps > 10000);
  const baseRate = savings.approved.find((r) => r.chainId === 1 && r.rateBps === 10000);
  const activeChallenges = challenges.challenges.filter((c) => c.status !== "Success");

  return {
    zchf: {
      totalSupply: info.totalSupply,
      priceUsd: info.priceUsd,
      tvlChf: info.tvl.chf,
      tvlUsd: info.tvl.usd,
      chainBreakdown: info.chains.map((c) => ({
        chain: c.chainName,
        supply: c.supply,
        sharePercent: Number(((c.supply / info.totalSupply) * 100).toFixed(1)),
      })),
    },
    fps: {
      priceChf: info.fps.priceChf,
      totalSupply: info.fps.totalSupply,
      marketCapChf: info.fps.marketCapChf,
      equityReserveChf: fps.reserve.equityChf,
      netEarningsChf: fps.earnings.netChf,
    },
    savings: {
      leadRatePercent: leadRate?.ratePercent ?? null,
      baseRatePercent: baseRate?.ratePercent ?? null,
      pendingRateChanges: savings.proposed.length,
    },
    challenges: {
      total: challenges.total,
      active: challenges.active,
      recent: activeChallenges.slice(0, 3),
    },
    updatedAt: new Date().toISOString(),
  };
}
