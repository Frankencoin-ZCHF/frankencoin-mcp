/**
 * get_governance (Tool 4) — rate proposals, minters, equity trades, holder stats.
 */

import { ponderQuery } from "../upstream/ponder.js";
import { duneExecute } from "../upstream/dune.js";
import { fromWei, bpsToPercent, dateFromUnix, isoFromUnix } from "../lib/numbers.js";
import { DUNE_QUERIES, chainName } from "../lib/constants.js";

async function getRateProposals({ limit = 20 } = {}) {
  const data = await ponderQuery(`{
    leadrateRateChangeds(limit: ${Math.min(limit, 100)}, orderBy: "created", orderDirection: "desc") {
      items { chainId module approvedRate created blockheight txHash }
    }
  }`);
  // Note: pending proposals come from get_savings; this returns approved rate changes.
  return (data.leadrateRateChangeds?.items || []).map((r) => ({
    date: dateFromUnix(r.created),
    chainId: r.chainId,
    chainName: chainName(r.chainId),
    ratePercent: bpsToPercent(r.approvedRate),
    module: r.module,
    txHash: r.txHash,
    status: "approved",
  }));
}

function mapMinter(m) {
  return {
    address: m.minter,
    chainId: m.chainId,
    isActive: !m.denyDate,
    applicationFeeChf: fromWei(m.applicationFee),
    appliedAt: m.applyDate ? isoFromUnix(m.applyDate) : null,
    deniedAt: m.denyDate ? isoFromUnix(m.denyDate) : null,
    suggestor: m.suggestor,
    applyMessage: m.applyMessage || null,
    denyMessage: m.denyMessage || null,
    vetor: m.vetor || null,
    txHash: m.txHash,
    applicationPeriodSeconds: Number(m.applicationPeriod),
  };
}

async function getMinters({ status = "all", limit = 20 } = {}) {
  const data = await ponderQuery(`{
    frankencoinMinters(limit: ${Math.min(limit, 100)}) {
      items { chainId txHash minter applicationPeriod applicationFee applyMessage applyDate suggestor denyMessage denyDate denyTxHash vetor }
    }
  }`);
  let items = (data.frankencoinMinters?.items || []).map(mapMinter);
  if (status === "active") items = items.filter((m) => m.isActive);
  else if (status === "denied") items = items.filter((m) => !m.isActive);
  return items;
}

function mapTrade(t) {
  return {
    count: Number(t.count),
    kind: t.kind,
    trader: t.trader,
    sharesTraded: fromWei(t.shares),
    priceChf: fromWei(t.price),
    amountChf: fromWei(t.amount),
    timestamp: isoFromUnix(t.created),
    txHash: t.txHash,
  };
}

async function getEquityTrades({ limit = 20 } = {}) {
  const data = await ponderQuery(`{
    equityTrades(limit: ${Math.min(limit, 100)}, orderBy: "created", orderDirection: "desc") {
      items { kind count trader amount shares price created txHash }
    }
  }`);
  return (data.equityTrades?.items || []).map(mapTrade);
}

async function getHolderStats() {
  const [zchf, fps] = await Promise.allSettled([
    duneExecute(DUNE_QUERIES.zchfHolders),
    duneExecute(DUNE_QUERIES.fpsHolders),
  ]);
  // No key (MissingSecretError) or upstream failure → soft note, never a 500.
  if (zchf.status === "rejected" && zchf.reason?.name === "MissingSecretError") {
    return { note: "Dune API key not configured — holder stats unavailable" };
  }
  const val = (r) => (r.status === "fulfilled" ? r.value?.[0] ?? null : null);
  return { zchf: val(zchf), fps: val(fps) };
}

export async function getGovernance({ type = "all", status = "all", limit = 20 } = {}) {
  const result = {};
  if (type === "all" || type === "rate_proposals") result.rateProposals = await getRateProposals({ limit });
  if (type === "all" || type === "minters") result.minters = await getMinters({ status, limit });
  if (type === "all" || type === "equity_trades") result.equityTrades = await getEquityTrades({ limit });
  if (type === "all" || type === "holders") result.holders = await getHolderStats();
  return result;
}

export { mapMinter, mapTrade };
