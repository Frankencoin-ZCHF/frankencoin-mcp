/**
 * get_protocol_snapshot — full live protocol state in one call.
 *
 * Consolidates: get_protocol_summary + get_protocol_info + get_fps_info
 */

import { apiFetch, fromWei, bpsToPercent, CHAIN_NAMES } from "./helpers.js";
import { getSavings } from "./savings.js";
import { getChallenges } from "./positions.js";

export async function getProtocolSnapshot() {
  // Fetch everything in parallel
  const [infoData, fpsData, savings, challenges] = await Promise.all([
    apiFetch("/ecosystem/frankencoin/info"),
    apiFetch("/ecosystem/fps/info"),
    getSavings(),
    getChallenges({ limit: 5 }),
  ]);

  // Parse chain breakdown
  const chains = Object.entries(infoData.chains || {}).map(([id, c]) => ({
    chainId: Number(id),
    chainName: CHAIN_NAMES[id] || `Chain ${id}`,
    address: c.address,
    supply: c.supply,
    sharePercent: infoData.token?.supply
      ? Number(((c.supply / infoData.token.supply) * 100).toFixed(1))
      : null,
    mintEvents: c.counter?.mint,
    burnEvents: c.counter?.burn,
    updated: new Date(c.updated * 1000).toISOString(),
  }));

  // Extract lead rate and base rate from savings data
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
