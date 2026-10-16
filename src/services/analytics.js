/**
 * get_analytics (Tool 8) — time_series / trades / minters / rate_history.
 * get_dune_stats (Tool 12) — on-chain analytics from Dune.
 *
 * ⚠️ Behavior change: get_dune_stats WITHOUT DUNE_API_KEY returns a soft note
 * (the old server threw). Unifies it with get_governance?type=holders.
 */

import { ponderQuery } from "../upstream/ponder.js";
import { duneMetrics } from "./dune.js";
import { fromWei, bpsToPercent, dateFromUnix } from "../lib/numbers.js";
import { chainName } from "../lib/constants.js";
import { getChfUsdRate, FX_SOURCE } from "./fx.js";
import { mapMinter, mapTrade } from "./governance.js";

async function getTimeSeries({ days = 90 } = {}) {
  const [analyticsData, rateData, rate] = await Promise.all([
    ponderQuery(`{
      analyticDailyLogs(limit: ${Math.min(days, 365)}, orderBy: "timestamp", orderDirection: "desc") {
        items {
          date
          totalEquity totalSavings
          fpsTotalSupply fpsPrice
          realizedNetEarnings earningsPerFPS
          totalInflow totalOutflow
        }
      }
    }`),
    ponderQuery(`{
      leadrateRateChangeds(limit: 100, orderBy: "created", orderDirection: "desc") {
        items { chainId module approvedRate created blockheight txHash }
      }
    }`),
    getChfUsdRate(),
  ]);

  const daily = (analyticsData.analyticDailyLogs?.items || []).map((d) => ({
    date: d.date,
    supply: {
      total: null,
      mintedV1: null,
      mintedV2: null,
    },
    fps: {
      supply: fromWei(d.fpsTotalSupply),
      priceChf: fromWei(d.fpsPrice),
      marketCapChf: fromWei(d.fpsTotalSupply) * fromWei(d.fpsPrice),
      earningsPerFPS: fromWei(d.earningsPerFPS),
    },
    rates: {
      savingsRatePercent: null,
      v1BorrowRatePercent: null,
      v2BorrowRatePercent: null,
    },
    protocol: {
      equity: fromWei(d.totalEquity),
      savings: fromWei(d.totalSavings),
      projectedAnnualInterestIncome: null,
      annualNetEarnings: null,
      realizedNetEarnings: fromWei(d.realizedNetEarnings),
      cumulativeInflow: fromWei(d.totalInflow),
      cumulativeOutflow: fromWei(d.totalOutflow),
      cumulativeTradeFees: null,
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
    unavailableFields: ["totalSupply", "totalMintedV1", "totalMintedV2", "currentSaveLeadRate", "annualV1BorrowRate", "annualV2BorrowRate", "projectedInterests", "annualNetEarnings", "totalTradeFee"],
    note: {
      schema: "These fields are not supplied by the current indexer; null is unavailable, never zero. Historical supply is not inferred from minting or equity.",
      savingsRate: "currentSaveLeadRate / savingsRatePercent = what ZCHF savers earn",
      v1BorrowRate: "annualV1BorrowRate = interest rate for V1 (legacy CDP) borrowers",
      v2BorrowRate: "annualV2BorrowRate = effective interest rate for V2 position borrowers",
      dataRange: `${daily[daily.length - 1]?.date ?? "?"} → ${daily[0]?.date ?? "?"}`,
      totalDays: daily.length,
    },
    // Historical series stays in CHF: the *current* CHF/USD rate must NOT be applied to
    // past rows (that would fabricate USD figures that never existed, and we have no
    // historical FX). Multiply a CHF value by fx.chfUsd only for a rough current-rate view.
    fx: {
      chfUsd: rate,
      source: FX_SOURCE,
      note: "Series values are historical CHF. No historical USD is provided — applying today's rate to past values would be inaccurate. Use get_market_data / get_protocol_snapshot for current dual-denominated figures.",
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

async function getRateHistory({ days, limit }) {
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const data = await ponderQuery(`{
    leadrateRateChangeds(limit: ${limit}, where: {created_gte: "${since}"}, orderBy: "created", orderDirection: "desc") {
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
    days, since: new Date(since * 1000).toISOString(),
    ethereum: all.filter((r) => r.chainId === 1).sort((a, b) => a.date.localeCompare(b.date)),
    all,
  };
}

export async function getAnalytics({ type = "time_series", days = 90, limit = 20 } = {}) {
  switch (type) {
    case "time_series": return getTimeSeries({ days });
    case "trades": return { trades: await getTrades({ limit }) };
    case "minters": return { minters: await getMinters({ limit }) };
    case "rate_history": return { rateHistory: await getRateHistory({ days, limit }) };
    default:
      return { error: `Unknown analytics type: "${type}". Use: time_series, trades, minters, rate_history.` };
  }
}

export async function getDuneStats() {
  const { values, ...health } = await duneMetrics(["zchfHolders", "fpsHolders", "mintingVolume", "savingsTvl"]);
  return {
    ...health,
    holders: Object.values(health.queries).every((q) => q.status === "unconfigured") ? null : { zchf: values.zchfHolders?.[0] ?? null, fps: values.fpsHolders?.[0] ?? null },
    minting: values.mintingVolume?.slice(0, 30) ?? null,
    savingsTvl: values.savingsTvl?.slice(0, 30) ?? null,
  };
}
