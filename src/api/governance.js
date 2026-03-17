/**
 * get_governance — rate proposals, minter applications, FPS trades, holder stats.
 *
 * New consolidated tool combining governance-related data from multiple sources.
 */

import {
  ponderQuery, duneExecute,
  fromWei, bpsToPercent, ppmToPercent,
  CHAIN_NAMES, DUNE_QUERIES, DUNE_KEY,
} from "./helpers.js";

async function getRateProposals({ status = "all", limit = 20 } = {}) {
  const data = await ponderQuery(`{
    leadrateRateChangeds(limit: ${Math.min(limit, 100)}, orderBy: "created", orderDirection: "desc") {
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
    status: "approved",
  }));

  if (status === "approved") return all;
  // Note: pending proposals come from the savings API, not from the rate changes log
  // For a unified view, return all approved changes + note that pending requires get_savings
  return all;
}

async function getMinters({ status = "all", limit = 20 } = {}) {
  const data = await ponderQuery(`{
    frankencoinMinters(limit: ${Math.min(limit, 100)}) {
      items { chainId txHash minter applicationPeriod applicationFee applyMessage applyDate suggestor denyMessage denyDate denyTxHash vetor }
    }
  }`);

  let items = (data.frankencoinMinters?.items || []).map((m) => ({
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

  if (status === "active") items = items.filter((m) => m.isActive);
  else if (status === "denied") items = items.filter((m) => !m.isActive);

  return items;
}

async function getEquityTrades({ limit = 20 } = {}) {
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

async function getHolderStats() {
  if (!DUNE_KEY) return { note: "Dune API key not configured — holder stats unavailable" };

  const [zchfHolderRows, fpsHolderRows] = await Promise.allSettled([
    duneExecute(DUNE_QUERIES.zchfHolders),
    duneExecute(DUNE_QUERIES.fpsHolders),
  ]);

  function settled(r) { return r.status === "fulfilled" ? r.value : null; }

  return {
    zchf: settled(zchfHolderRows)?.[0] ?? null,
    fps: settled(fpsHolderRows)?.[0] ?? null,
  };
}

export async function getGovernance({ type = "all", status = "all", limit = 20 } = {}) {
  const result = {};

  if (type === "all" || type === "rate_proposals") {
    result.rateProposals = await getRateProposals({ status, limit });
  }
  if (type === "all" || type === "minters") {
    result.minters = await getMinters({ status, limit });
  }
  if (type === "all" || type === "equity_trades") {
    result.equityTrades = await getEquityTrades({ limit });
  }
  if (type === "all" || type === "holders") {
    result.holders = await getHolderStats();
  }

  return result;
}
