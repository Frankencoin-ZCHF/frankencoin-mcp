/**
 * get_savings (Tool 3) — approved/proposed rates + per-module stats (SPEC §Tool 3).
 */

import { apiFetch } from "../upstream/frankencoin.js";
import { fromWei, bpsToPercent, isoFromUnix } from "../lib/numbers.js";
import { chainName } from "../lib/constants.js";

export async function getSavings() {
  const [rateData, coreData] = await Promise.all([
    apiFetch("/savings/leadrate/info"),
    apiFetch("/savings/core/info"),
  ]);

  const approved = [];
  for (const [chainId, modules] of Object.entries(rateData.rate || {})) {
    for (const [moduleAddr, m] of Object.entries(modules)) {
      approved.push({
        chainId: Number(chainId),
        chainName: chainName(chainId),
        module: moduleAddr,
        ratePercent: bpsToPercent(m.approvedRate),
        rateBps: m.approvedRate,
        appliedAt: isoFromUnix(m.created),
        voteCount: m.count,
      });
    }
  }

  const proposed = [];
  for (const [chainId, modules] of Object.entries(rateData.proposed || {})) {
    for (const [moduleAddr, m] of Object.entries(modules)) {
      proposed.push({
        chainId: Number(chainId),
        chainName: chainName(chainId),
        module: moduleAddr,
        proposedRatePercent: bpsToPercent(m.nextRate),
        proposedRateBps: m.nextRate,
        proposer: m.proposer,
        effectiveAt: isoFromUnix(m.nextChange),
        proposedAt: isoFromUnix(m.created),
      });
    }
  }

  const stats = [];
  for (const [chainId, modules] of Object.entries(coreData.status || {})) {
    for (const [moduleAddr, m] of Object.entries(modules)) {
      stats.push({
        chainId: Number(chainId),
        chainName: chainName(chainId),
        module: moduleAddr,
        balanceChf: fromWei(m.balance),
        totalInterestPaidChf: fromWei(m.interest),
        totalSavedChf: fromWei(m.save),
        totalWithdrawnChf: fromWei(m.withdraw),
        ratePercent: bpsToPercent(m.rate),
        updatedAt: isoFromUnix(m.updated),
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
