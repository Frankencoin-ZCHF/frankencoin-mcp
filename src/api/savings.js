/**
 * get_savings — rates + TVL + module stats in one call.
 *
 * Consolidates: get_savings_rates + get_savings_stats
 */

import { apiFetch, fromWei, bpsToPercent, CHAIN_NAMES } from "./helpers.js";

export async function getSavings() {
  // Fetch both endpoints in parallel
  const [rateData, coreData] = await Promise.all([
    apiFetch("/savings/leadrate/info"),
    apiFetch("/savings/core/info"),
  ]);

  // ── Rates (approved + proposed) ──
  const approved = [];
  const proposed = [];

  for (const [chainId, modules] of Object.entries(rateData.rate || {})) {
    for (const [moduleAddr, m] of Object.entries(modules)) {
      approved.push({
        chainId: Number(chainId),
        chainName: CHAIN_NAMES[chainId] || `Chain ${chainId}`,
        module: moduleAddr,
        ratePercent: bpsToPercent(m.approvedRate),
        rateBps: m.approvedRate,
        appliedAt: new Date(m.created * 1000).toISOString(),
        voteCount: m.count,
      });
    }
  }
  for (const [chainId, modules] of Object.entries(rateData.proposed || {})) {
    for (const [moduleAddr, m] of Object.entries(modules)) {
      proposed.push({
        chainId: Number(chainId),
        chainName: CHAIN_NAMES[chainId] || `Chain ${chainId}`,
        module: moduleAddr,
        proposedRatePercent: bpsToPercent(m.nextRate),
        proposedRateBps: m.nextRate,
        proposer: m.proposer,
        effectiveAt: new Date(m.nextChange * 1000).toISOString(),
        proposedAt: new Date(m.created * 1000).toISOString(),
      });
    }
  }

  // ── Module stats ──
  const stats = [];
  for (const [chainId, modules] of Object.entries(coreData.status || {})) {
    for (const [moduleAddr, m] of Object.entries(modules)) {
      stats.push({
        chainId: Number(chainId),
        chainName: CHAIN_NAMES[chainId] || `Chain ${chainId}`,
        module: moduleAddr,
        balanceChf: fromWei(m.balance),
        totalInterestPaidChf: fromWei(m.interest),
        totalSavedChf: fromWei(m.save),
        totalWithdrawnChf: fromWei(m.withdraw),
        ratePercent: bpsToPercent(m.rate),
        updatedAt: new Date(m.updated * 1000).toISOString(),
        events: {
          interestPayments: m.counter?.interest,
          rateChanges: m.counter?.rateChanged,
          deposits: m.counter?.save,
          withdrawals: m.counter?.withdraw,
        },
      });
    }
  }

  return {
    rates: { approved, proposed },
    stats,
    summary: {
      totalDepositedChf: stats.reduce((sum, s) => sum + s.balanceChf, 0),
      totalInterestPaidChf: stats.reduce((sum, s) => sum + s.totalInterestPaidChf, 0),
      pendingRateChanges: proposed.length,
    },
  };
}
