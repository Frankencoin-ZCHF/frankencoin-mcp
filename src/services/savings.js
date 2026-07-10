/**
 * get_savings (Tool 3) — approved/proposed rates + per-module stats (SPEC §Tool 3).
 */

import { apiFetch } from "../upstream/frankencoin.js";
import { fromWei, bpsToPercent, isoFromUnix, money } from "../lib/numbers.js";
import { chainName } from "../lib/constants.js";
import { getChfUsdRate, fxBlock } from "./fx.js";

export async function getSavings() {
  const [rateData, coreData, rate] = await Promise.all([
    apiFetch("/savings/leadrate/info"),
    apiFetch("/savings/core/info"),
    getChfUsdRate(),
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
      const balanceChf = fromWei(m.balance);
      const interestChf = fromWei(m.interest);
      stats.push({
        chainId: Number(chainId),
        chainName: chainName(chainId),
        module: moduleAddr,
        balance: money(balanceChf, rate),
        totalInterestPaid: money(interestChf, rate),
        totalSaved: money(fromWei(m.save), rate),
        totalWithdrawn: money(fromWei(m.withdraw), rate),
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

  const totalDepositedChf = stats.reduce((sum, s) => sum + (s.balance.chf ?? 0), 0);
  const totalInterestPaidChf = stats.reduce((sum, s) => sum + (s.totalInterestPaid.chf ?? 0), 0);

  return {
    rates: { approved, proposed },
    stats,
    summary: {
      totalDeposited: money(totalDepositedChf, rate),
      totalInterestPaid: money(totalInterestPaidChf, rate),
      pendingRateChanges: proposed.length,
    },
    fx: fxBlock(rate),
  };
}
