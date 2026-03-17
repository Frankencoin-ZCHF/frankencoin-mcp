/**
 * get_analytics — historical time-series, trades, minters, rate history.
 *
 * Consolidates: get_analytics + get_historical + get_equity_trades + get_minters
 * into one tool with a 'type' parameter.
 */

import {
  ponderQuery, duneExecute,
  fromWei, bpsToPercent, ppmToPercent,
  CHAIN_NAMES, DUNE_QUERIES, DUNE_KEY,
} from "./helpers.js";

async function getTimeSeries({ days = 90 } = {}) {
  const [analyticsData, rateData] = await Promise.all([
    ponderQuery(`{
      analyticDailyLogs(limit: ${Math.min(days, 365)}, orderBy: "timestamp", orderDirection: "desc") {
        items {
          date
          totalSupply totalEquity totalSavings
          fpsTotalSupply fpsPrice
          currentLeadRate
          annualV1BorrowRate
          annualV2BorrowRate
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
      savingsRatePercent: fromWei(d.currentLeadRate) * 100,
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
    date: new Date(Number(r.created) * 1000).toISOString().split("T")[0],
    chainId: r.chainId,
    chainName: CHAIN_NAMES[r.chainId] || `Chain ${r.chainId}`,
    ratePercent: bpsToPercent(r.approvedRate),
    module: r.module,
    txHash: r.txHash,
  }));

  const ethRateTimeline = rateHistory
    .filter((r) => r.chainId === 1)
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    note: {
      savingsRate: "currentLeadRate / savingsRatePercent = what ZCHF savers earn",
      v1BorrowRate: "annualV1BorrowRate = interest rate for V1 (legacy CDP) borrowers",
      v2BorrowRate: "annualV2BorrowRate = effective interest rate for V2 position borrowers",
      dataRange: `${daily[daily.length - 1]?.date ?? "?"} → ${daily[0]?.date ?? "?"}`,
      totalDays: daily.length,
    },
    daily,
    rateHistory: {
      ethereum: ethRateTimeline,
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
  return (data.equityTrades?.items || []).map((t) => ({
    count: Number(t.count),
    kind: t.kind,
    trader: t.trader,
    sharesTraded: fromWei(t.shares),
    priceChf: fromWei(t.price),
    amountChf: fromWei(t.amount),
    timestamp: new Date(Number(t.created) * 1000).toISOString(),
    txHash: t.txHash,
  }));
}

async function getMinters({ limit = 20 } = {}) {
  const data = await ponderQuery(`{
    frankencoinMinters(limit: ${Math.min(limit, 100)}) {
      items { chainId txHash minter applicationPeriod applicationFee applyMessage applyDate suggestor denyMessage denyDate denyTxHash vetor }
    }
  }`);
  return (data.frankencoinMinters?.items || []).map((m) => ({
    address: m.minter,
    chainId: m.chainId,
    isActive: !m.denyDate,
    applicationFeeChf: fromWei(m.applicationFee),
    appliedAt: m.applyDate ? new Date(Number(m.applyDate) * 1000).toISOString() : null,
    deniedAt: m.denyDate ? new Date(Number(m.denyDate) * 1000).toISOString() : null,
    suggestor: m.suggestor,
    applyMessage: m.applyMessage || null,
    denyMessage: m.denyMessage || null,
    vetor: m.vetor || null,
    txHash: m.txHash,
    applicationPeriodSeconds: Number(m.applicationPeriod),
  }));
}

async function getRateHistory({ days = 90 } = {}) {
  const data = await ponderQuery(`{
    leadrateRateChangeds(limit: 100, orderBy: "created", orderDirection: "desc") {
      items { chainId module approvedRate created blockheight txHash }
    }
  }`);

  const all = (data.leadrateRateChangeds?.items || []).map((r) => ({
    date: new Date(Number(r.created) * 1000).toISOString().split("T")[0],
    chainId: r.chainId,
    chainName: CHAIN_NAMES[r.chainId] || `Chain ${r.chainId}`,
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
    case "time_series":
      return getTimeSeries({ days });
    case "trades":
      return { trades: await getTrades({ limit }) };
    case "minters":
      return { minters: await getMinters({ limit }) };
    case "rate_history":
      return { rateHistory: await getRateHistory({ days }) };
    default:
      return { error: `Unknown analytics type: "${type}". Use: time_series, trades, minters, rate_history.` };
  }
}

// Keep Dune stats as separate tool
export async function getDuneStats() {
  if (!DUNE_KEY) throw new Error("Dune API key not configured on server");

  const [zchfHolderRows, fpsHolderRows, mintingRows, savingsTvlRows] = await Promise.allSettled([
    duneExecute(DUNE_QUERIES.zchfHolders),
    duneExecute(DUNE_QUERIES.fpsHolders),
    duneExecute(DUNE_QUERIES.mintingVolume),
    duneExecute(DUNE_QUERIES.savingsTvl),
  ]);

  function settled(r) { return r.status === "fulfilled" ? r.value : null; }

  return {
    holders: {
      zchf: settled(zchfHolderRows)?.[0] ?? null,
      fps: settled(fpsHolderRows)?.[0] ?? null,
    },
    minting: settled(mintingRows)?.slice(0, 30) ?? null,
    savingsTvl: settled(savingsTvlRows)?.slice(0, 30) ?? null,
    note: "Data from Dune Analytics — may be slightly delayed vs on-chain",
  };
}

// Keep raw Ponder query
export async function runPonderQuery(graphqlQuery) {
  return ponderQuery(graphqlQuery);
}
