/**
 * get_analytics (Tool 8) — time_series / trades / minters / rate_history.
 * get_dune_stats (Tool 12) — on-chain analytics from Dune.
 *
 * ⚠️ Behavior change: get_dune_stats WITHOUT DUNE_API_KEY returns a soft note
 * (the old server threw). Unifies it with get_governance?type=holders.
 */

import { ponderQuery } from "../upstream/ponder.js";
import { duneExecute } from "../upstream/dune.js";
import { fromWei, bpsToPercent, dateFromUnix } from "../lib/numbers.js";
import { DUNE_QUERIES, chainName } from "../lib/constants.js";
import { mapMinter, mapTrade } from "./governance.js";

async function getTimeSeries({ days = 90 } = {}) {
  const [analyticsData, rateData] = await Promise.all([
    ponderQuery(`{
      analyticDailyLogs(limit: ${Math.min(days, 365)}, orderBy: "timestamp", orderDirection: "desc") {
        items {
          date
          totalSupply totalEquity totalSavings
          fpsTotalSupply fpsPrice
          currentSaveLeadRate annualV1BorrowRate annualV2BorrowRate
          projectedInterests annualNetEarnings realizedNetEarnings earningsPerFPS
          totalMintedV1 totalMintedV2
          totalInflow totalOutflow totalTradeFee
        }
      }
    }`),
    ponderQuery(`{
      leadrateRateChangeds(limit: 100, orderBy: "created", orderDirection: "desc") {
        items { chainId module approvedRate created blockheight txHash }
      }
    }`),
  ]);

  const daily = (analyticsData.analyticDailyLogs?.items || []).map((d) => ({
    date: d.date,
    supply: {
      total: fromWei(d.totalSupply),
      mintedV1: fromWei(d.totalMintedV1),
      mintedV2: fromWei(d.totalMintedV2),
    },
    fps: {
      supply: fromWei(d.fpsTotalSupply),
      priceChf: fromWei(d.fpsPrice),
      marketCapChf: fromWei(d.fpsTotalSupply) * fromWei(d.fpsPrice),
      earningsPerFPS: fromWei(d.earningsPerFPS),
    },
    rates: {
      savingsRatePercent: bpsToPercent(d.currentSaveLeadRate),
      v1BorrowRatePercent: fromWei(d.annualV1BorrowRate) * 100,
      v2BorrowRatePercent: fromWei(d.annualV2BorrowRate) * 100,
    },
    protocol: {
      equity: fromWei(d.totalEquity),
      savings: fromWei(d.totalSavings),
      projectedAnnualInterestIncome: fromWei(d.projectedInterests),
      annualNetEarnings: fromWei(d.annualNetEarnings),
      realizedNetEarnings: fromWei(d.realizedNetEarnings),
      cumulativeInflow: fromWei(d.totalInflow),
      cumulativeOutflow: fromWei(d.totalOutflow),
      cumulativeTradeFees: fromWei(d.totalTradeFee),
    },
  }));

  const rateHistory = (rateData.leadrateRateChangeds?.items || []).map((r) => ({
    date: dateFromUnix(r.created),
    chainId: r.chainId,
    chainName: chainName(r.chainId),
    ratePercent: bpsToPercent(r.approvedRate),
    module: r.module,
    txHash: r.txHash,
  }));

  return {
    note: {
      savingsRate: "currentSaveLeadRate / savingsRatePercent = what ZCHF savers earn",
      v1BorrowRate: "annualV1BorrowRate = interest rate for V1 (legacy CDP) borrowers",
      v2BorrowRate: "annualV2BorrowRate = effective interest rate for V2 position borrowers",
      dataRange: `${daily[daily.length - 1]?.date ?? "?"} → ${daily[0]?.date ?? "?"}`,
      totalDays: daily.length,
    },
    daily,
    rateHistory: {
      ethereum: rateHistory.filter((r) => r.chainId === 1).sort((a, b) => a.date.localeCompare(b.date)),
      all: rateHistory,
    },
  };
}

async function getTrades({ limit = 20 } = {}) {
  const data = await ponderQuery(`{
    equityTrades(limit: ${Math.min(limit, 100)}, orderBy: "created", orderDirection: "desc") {
      items { kind count trader amount shares price created txHash }
    }
  }`);
  return (data.equityTrades?.items || []).map(mapTrade);
}

async function getMinters({ limit = 20 } = {}) {
  const data = await ponderQuery(`{
    frankencoinMinters(limit: ${Math.min(limit, 100)}) {
      items { chainId txHash minter applicationPeriod applicationFee applyMessage applyDate suggestor denyMessage denyDate denyTxHash vetor }
    }
  }`);
  return (data.frankencoinMinters?.items || []).map(mapMinter);
}

async function getRateHistory() {
  const data = await ponderQuery(`{
    leadrateRateChangeds(limit: 100, orderBy: "created", orderDirection: "desc") {
      items { chainId module approvedRate created blockheight txHash }
    }
  }`);
  const all = (data.leadrateRateChangeds?.items || []).map((r) => ({
    date: dateFromUnix(r.created),
    chainId: r.chainId,
    chainName: chainName(r.chainId),
    ratePercent: bpsToPercent(r.approvedRate),
    module: r.module,
    txHash: r.txHash,
  }));
  return {
    ethereum: all.filter((r) => r.chainId === 1).sort((a, b) => a.date.localeCompare(b.date)),
    all,
  };
}

export async function getAnalytics({ type = "time_series", days = 90, limit = 20 } = {}) {
  switch (type) {
    case "time_series": return getTimeSeries({ days });
    case "trades": return { trades: await getTrades({ limit }) };
    case "minters": return { minters: await getMinters({ limit }) };
    case "rate_history": return { rateHistory: await getRateHistory() };
    default:
      return { error: `Unknown analytics type: "${type}". Use: time_series, trades, minters, rate_history.` };
  }
}

export async function getDuneStats() {
  const [zchf, fps, minting, savingsTvl] = await Promise.allSettled([
    duneExecute(DUNE_QUERIES.zchfHolders),
    duneExecute(DUNE_QUERIES.fpsHolders),
    duneExecute(DUNE_QUERIES.mintingVolume),
    duneExecute(DUNE_QUERIES.savingsTvl),
  ]);

  // No key → soft note (degrade, don't throw).
  if (zchf.status === "rejected" && zchf.reason?.name === "MissingSecretError") {
    return {
      note: "Dune API key not configured — on-chain analytics unavailable",
      holders: null, minting: null, savingsTvl: null,
    };
  }

  const val = (r) => (r.status === "fulfilled" ? r.value : null);
  return {
    holders: { zchf: val(zchf)?.[0] ?? null, fps: val(fps)?.[0] ?? null },
    minting: val(minting)?.slice(0, 30) ?? null,
    savingsTvl: val(savingsTvl)?.slice(0, 30) ?? null,
    note: "Data from Dune Analytics — may be slightly delayed vs on-chain",
  };
}
