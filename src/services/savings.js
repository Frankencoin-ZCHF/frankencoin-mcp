/**
 * get_savings (Tool 3) — approved/proposed rates + per-module stats (SPEC §Tool 3).
 */

import { apiFetch } from "../upstream/frankencoin.js";
import { fromWei, bpsToPercent, isoFromUnix, money } from "../lib/numbers.js";
import { chainName } from "../lib/constants.js";
import { getChfUsdRate, fxBlock } from "./fx.js";

const amount = (v) => v == null || !/^\d+$/.test(String(v)) ? null : fromWei(v);

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
        ratePercent: m.approvedRate == null ? null : bpsToPercent(m.approvedRate),
        rateBps: m.approvedRate == null ? null : m.approvedRate / 100,
        ratePpm: m.approvedRate,
        appliedAt: isoFromUnix(m.created),
        voteCount: m.count,
      });
    }
  }

  const proposed = [];
  for (const [chainId, modules] of Object.entries(rateData.open || {})) {
    for (const [moduleAddr, m] of Object.entries(modules)) {
      proposed.push({
        chainId: Number(chainId),
        chainName: chainName(chainId),
        module: moduleAddr,
        proposedRatePercent: m.nextRate == null ? null : bpsToPercent(m.nextRate),
        proposedRateBps: m.nextRate == null ? null : m.nextRate / 100,
        proposedRatePpm: m.nextRate,
        proposer: m.proposer,
        effectiveAt: isoFromUnix(m.nextChange),
        proposedAt: isoFromUnix(m.created),
      });
    }
  }

  const stats = [];
  for (const [chainId, modules] of Object.entries(coreData.status || {})) {
    for (const [moduleAddr, m] of Object.entries(modules)) {
      const balanceChf = amount(m.balance);
      const interestChf = amount(m.interest);
      stats.push({
        chainId: Number(chainId),
        chainName: chainName(chainId),
        module: moduleAddr,
        balance: money(balanceChf, rate),
        totalInterestPaid: money(interestChf, rate),
        totalSaved: money(amount(m.save), rate),
        totalWithdrawn: money(amount(m.withdraw), rate),
        ratePercent: m.rate == null ? null : bpsToPercent(m.rate),
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

  const sum = (field) => stats.length && stats.every((s) => Number.isFinite(s[field].chf))
    ? stats.reduce((total, s) => total + s[field].chf, 0) : null;
  const totalDepositedChf = sum("balance");
  const totalInterestPaidChf = sum("totalInterestPaid");

  return {
    rates: { approved, proposed, pendingStatus: rateData.open && typeof rateData.open === "object" && !Array.isArray(rateData.open) ? "available" : "unavailable" },
    stats,
    summary: {
      totalDeposited: money(totalDepositedChf, rate),
      totalInterestPaid: money(totalInterestPaidChf, rate),
      pendingRateChanges: rateData.open && typeof rateData.open === "object" && !Array.isArray(rateData.open) ? proposed.length : null,
    },
    fx: fxBlock(rate),
  };
}
