/**
 * Frankencoin API client
 * Wraps api.frankencoin.com REST endpoints and ponder.frankencoin.com GraphQL
 */

const API_BASE = "https://api.frankencoin.com";
const PONDER_BASE = "https://ponder.frankencoin.com";

const CHAIN_NAMES = {
  1: "Ethereum",
  10: "Optimism",
  100: "Gnosis",
  137: "Polygon",
  146: "Sonic",
  8453: "Base",
  42161: "Arbitrum",
  43114: "Avalanche",
};

async function apiFetch(path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${path}`);
  return res.json();
}

async function ponderQuery(query, variables = {}) {
  const res = await fetch(PONDER_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Ponder error ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data;
}

/** Decode 18-decimal bigint string to float */
function fromWei(val, decimals = 18) {
  if (!val) return 0;
  return Number(BigInt(val)) / Math.pow(10, decimals);
}

/** Basis points to percentage (e.g. 37500 → 3.75) */
function bpsToPercent(bps) {
  return bps / 10000;
}

/** PPM (parts per million) to percent */
function ppmToPercent(ppm) {
  return ppm / 10000;
}

// ─── REST API wrappers ────────────────────────────────────────────────────────

export async function getProtocolInfo() {
  const data = await apiFetch("/ecosystem/frankencoin/info");
  const chains = Object.entries(data.chains || {}).map(([id, c]) => ({
    chainId: Number(id),
    chainName: CHAIN_NAMES[id] || `Chain ${id}`,
    address: c.address,
    supply: c.supply,
    mintEvents: c.counter?.mint,
    burnEvents: c.counter?.burn,
    updated: new Date(c.updated * 1000).toISOString(),
  }));
  return {
    token: {
      name: data.erc20?.name,
      symbol: data.erc20?.symbol,
      decimals: data.erc20?.decimals,
    },
    totalSupply: data.token?.supply,
    priceUsd: data.token?.usd,
    fps: {
      priceChf: data.fps?.price,
      totalSupply: data.fps?.totalSupply,
      marketCapChf: data.fps?.marketCap,
    },
    tvl: {
      usd: data.tvl?.usd,
      chf: data.tvl?.chf,
    },
    chains,
  };
}

export async function getFpsInfo() {
  const data = await apiFetch("/ecosystem/fps/info");
  return {
    token: {
      name: data.erc20?.name,
      symbol: data.erc20?.symbol,
      decimals: data.erc20?.decimals,
      address: data.chains?.[1]?.address,
    },
    price: {
      usd: data.token?.price,
      chf: null, // not in this endpoint, use prices/list
    },
    totalSupply: data.token?.totalSupply,
    marketCapUsd: data.token?.marketCap,
    earnings: {
      profitChf: data.earnings?.profit,
      lossChf: data.earnings?.loss,
      netChf: (data.earnings?.profit || 0) - (data.earnings?.loss || 0),
    },
    reserve: {
      totalChf: data.reserve?.balance,
      equityChf: data.reserve?.equity,
      minterReserveChf: data.reserve?.minter,
    },
  };
}

export async function getPrices() {
  const data = await apiFetch("/prices/list");
  return (data || []).map((t) => ({
    chainId: t.chainId,
    address: t.address,
    name: t.name,
    symbol: t.symbol,
    priceUsd: t.price?.usd,
    priceChf: t.price?.chf,
    source: t.source,
    updatedAt: new Date(t.timestamp).toISOString(),
  }));
}

export async function getSavingsRates() {
  const data = await apiFetch("/savings/leadrate/info");
  const result = { approved: [], proposed: [] };

  for (const [chainId, modules] of Object.entries(data.rate || {})) {
    for (const [moduleAddr, m] of Object.entries(modules)) {
      result.approved.push({
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

  for (const [chainId, modules] of Object.entries(data.proposed || {})) {
    for (const [moduleAddr, m] of Object.entries(modules)) {
      result.proposed.push({
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

  return result;
}

export async function getSavingsStats() {
  const data = await apiFetch("/savings/core/info");
  const stats = [];
  for (const [chainId, modules] of Object.entries(data.status || {})) {
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
  return stats;
}

export async function getCollaterals() {
  const data = await apiFetch("/ecosystem/collateral/list");
  return (data.list || []).map((c) => ({
    chainId: c.chainId,
    chainName: CHAIN_NAMES[c.chainId] || `Chain ${c.chainId}`,
    address: c.address,
    name: c.name,
    symbol: c.symbol,
    decimals: c.decimals,
  }));
}

export async function getChallenges({ limit = 20, activeOnly = false } = {}) {
  const data = await apiFetch("/challenges/list");
  let list = data.list || [];
  if (activeOnly) {
    const now = Date.now() / 1000;
    list = list.filter(
      (c) => c.status !== "Success" && Number(c.start) + Number(c.duration) > now
    );
  }
  return {
    total: data.num,
    challenges: list.slice(0, limit).map((c) => ({
      id: c.id || `${c.position}-challenge-${c.number}`,
      position: c.position,
      number: Number(c.number),
      challenger: c.challenger,
      status: c.status,
      version: c.version,
      startedAt: new Date(Number(c.start) * 1000).toISOString(),
      expiresAt: new Date((Number(c.start) + Number(c.duration)) * 1000).toISOString(),
      durationSeconds: Number(c.duration),
      size: c.size,
      filledSize: c.filledSize,
      bids: Number(c.bids),
      txHash: c.txHash,
    })),
  };
}

export async function getPositions({ limit = 50, activeOnly = true } = {}) {
  const data = await apiFetch("/positions/open");
  const addresses = data.addresses || [];
  return {
    total: data.num,
    returned: Math.min(limit, addresses.length),
    addresses: addresses.slice(0, limit),
    note: "Use get_positions_detail tool for full position data from on-chain indexer",
  };
}

// ─── Ponder GraphQL wrappers ──────────────────────────────────────────────────

export async function getPositionsDetail({ limit = 20, activeOnly = true, collateral = null } = {}) {
  const whereClause = activeOnly
    ? `where: { closed: false, denied: false${collateral ? `, collateral: "${collateral}"` : ""} }`
    : collateral
    ? `where: { collateral: "${collateral}" }`
    : "";

  const query = `
    {
      mintingHubV2PositionV2s(limit: ${limit}, ${whereClause}) {
        items {
          position
          owner
          collateral
          collateralSymbol
          collateralBalance
          collateralDecimals
          minted
          availableForMinting
          price
          cooldown
          expiration
          start
          closed
          denied
          isOriginal
          isClone
          minimumCollateral
          riskPremiumPPM
          reserveContribution
          challengePeriod
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;
  const data = await ponderQuery(query);
  const items = data.mintingHubV2PositionV2s?.items || [];
  return {
    total: items.length,
    positions: items.map((p) => ({
      address: p.position,
      owner: p.owner,
      collateral: {
        address: p.collateral,
        symbol: p.collateralSymbol,
        balance: fromWei(p.collateralBalance, p.collateralDecimals || 18),
        decimals: p.collateralDecimals,
      },
      minted: fromWei(p.minted),
      availableForMinting: fromWei(p.availableForMinting),
      liquidationPrice: fromWei(p.price, 18),
      cooldownUntil: p.cooldown ? new Date(Number(p.cooldown) * 1000).toISOString() : null,
      expiresAt: p.expiration ? new Date(Number(p.expiration) * 1000).toISOString() : null,
      startedAt: p.start ? new Date(Number(p.start) * 1000).toISOString() : null,
      status: p.closed ? "closed" : p.denied ? "denied" : "active",
      isOriginal: p.isOriginal,
      isClone: p.isClone,
      riskPremiumPercent: ppmToPercent(p.riskPremiumPPM || 0),
      reserveContributionPercent: ppmToPercent(p.reserveContribution || 0),
      challengePeriodSeconds: Number(p.challengePeriod || 0),
    })),
    pageInfo: data.mintingHubV2PositionV2s?.pageInfo,
  };
}

export async function getAnalytics({ days = 30 } = {}) {
  const query = `
    {
      analyticDailyLogs(limit: ${days}, orderBy: "timestamp", orderDirection: "desc") {
        items {
          date
          timestamp
          totalSupply
          totalEquity
          totalSavings
          fpsTotalSupply
          fpsPrice
          currentLeadRate
          projectedInterests
          annualNetEarnings
          realizedNetEarnings
          earningsPerFPS
          annualV2BorrowRate
          totalMintedV1
          totalMintedV2
        }
      }
    }
  `;
  const data = await ponderQuery(query);
  return (data.analyticDailyLogs?.items || []).map((d) => ({
    date: d.date,
    supply: fromWei(d.totalSupply),
    equity: fromWei(d.totalEquity),
    savings: fromWei(d.totalSavings),
    fps: {
      supply: fromWei(d.fpsTotalSupply),
      priceChf: fromWei(d.fpsPrice),
      earningsPerFPS: fromWei(d.earningsPerFPS),
    },
    rates: {
      leadRatePercent: fromWei(d.currentLeadRate) * 100,
      annualBorrowRatePercent: fromWei(d.annualV2BorrowRate) * 100,
    },
    earnings: {
      projected: fromWei(d.projectedInterests),
      annual: fromWei(d.annualNetEarnings),
      realized: fromWei(d.realizedNetEarnings),
    },
    mintedV1: fromWei(d.totalMintedV1),
    mintedV2: fromWei(d.totalMintedV2),
  }));
}

export async function getEquityTrades({ limit = 20 } = {}) {
  const query = `
    {
      equityTrades(limit: ${limit}, orderBy: "timestamp", orderDirection: "desc") {
        items {
          id
          buyer
          seller
          amount
          shares
          price
          totalprice
          timestamp
          txHash
        }
      }
    }
  `;
  const data = await ponderQuery(query);
  return (data.equityTrades?.items || []).map((t) => ({
    id: t.id,
    buyer: t.buyer,
    seller: t.seller,
    sharesTraded: fromWei(t.shares),
    priceChf: fromWei(t.price),
    totalValueChf: fromWei(t.totalprice),
    timestamp: new Date(Number(t.timestamp) * 1000).toISOString(),
    txHash: t.txHash,
  }));
}

export async function getMinters({ limit = 20 } = {}) {
  const query = `
    {
      frankencoinMinters(limit: ${limit}) {
        items {
          id
          minter
          applicationPeriod
          applicationFee
          applyDate
          suggestor
          denyDate
          isMinter
        }
      }
    }
  `;
  const data = await ponderQuery(query);
  return (data.frankencoinMinters?.items || []).map((m) => ({
    address: m.minter,
    isActive: m.isMinter,
    applicationFeeChf: fromWei(m.applicationFee),
    appliedAt: m.applyDate ? new Date(Number(m.applyDate) * 1000).toISOString() : null,
    deniedAt: m.denyDate && m.denyDate !== "0" ? new Date(Number(m.denyDate) * 1000).toISOString() : null,
    suggestor: m.suggestor,
    applicationPeriodSeconds: Number(m.applicationPeriod),
  }));
}

export async function runPonderQuery(graphqlQuery) {
  return ponderQuery(graphqlQuery);
}

export async function getProtocolSummary() {
  const [info, fps, savings, challenges] = await Promise.all([
    getProtocolInfo(),
    getFpsInfo(),
    getSavingsRates(),
    getChallenges({ limit: 5, activeOnly: true }),
  ]);

  const leadRate = savings.approved.find((r) => r.chainId === 1 && r.rateBps > 10000);
  const baseRate = savings.approved.find((r) => r.chainId === 1 && r.rateBps === 10000);

  const activeChallenges = challenges.challenges.filter((c) => c.status !== "Success");

  return {
    zchf: {
      totalSupply: info.totalSupply,
      priceUsd: info.priceUsd,
      tvlChf: info.tvl.chf,
      tvlUsd: info.tvl.usd,
      chainBreakdown: info.chains.map((c) => ({
        chain: c.chainName,
        supply: c.supply,
        sharePercent: ((c.supply / info.totalSupply) * 100).toFixed(1),
      })),
    },
    fps: {
      priceChf: fps.reserve ? info.fps.priceChf : null,
      totalSupply: info.fps.totalSupply,
      marketCapChf: info.fps.marketCapChf,
      equityReserveChf: fps.reserve.equityChf,
      netEarningsChf: fps.earnings.netChf,
    },
    savings: {
      leadRatePercent: leadRate?.ratePercent ?? null,
      baseRatePercent: baseRate?.ratePercent ?? null,
      pendingRateChanges: savings.proposed.length,
    },
    challenges: {
      total: challenges.total,
      active: activeChallenges.length,
      recent: activeChallenges.slice(0, 3),
    },
    updatedAt: new Date().toISOString(),
  };
}
