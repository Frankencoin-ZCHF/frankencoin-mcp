/**
 * get_positions (Tool 5), get_challenges (Tool 6), get_collaterals (Tool 7).
 *
 * ⚠️ Behavior changes vs old server:
 *   - collateral.change24hPercent is a NUMBER (2dp), not a string.
 *   - get_collaterals returns { collaterals:[...], count } (was a bare array).
 *   - get_challenges batches per-position Ponder lookups into ONE request (fixes N+1).
 */

import { apiFetch } from "../upstream/frankencoin.js";
import { ponderQuery } from "../upstream/ponder.js";
import { cgFetch } from "../upstream/coingecko.js";
import { fromWei, ppmToPercent, round, isoFromUnix } from "../lib/numbers.js";
import { COINGECKO_IDS, chainName } from "../lib/constants.js";

/** Best-effort CoinGecko simple/price enrichment; returns {} on any failure or no key. */
async function cgEnrich(addresses) {
  const cgIds = [...new Set(addresses.map((a) => COINGECKO_IDS[a]).filter(Boolean))];
  if (cgIds.length === 0) return {};
  try {
    return await cgFetch(
      `/simple/price?ids=${cgIds.join(",")}&vs_currencies=usd,chf&include_24hr_change=true&include_market_cap=true`,
    );
  } catch {
    return {};
  }
}

export async function getPositions({ detail = false, limit, activeOnly, collateral = null } = {}) {
  if (!detail) {
    const effectiveLimit = limit ?? 50;
    const data = await apiFetch("/positions/open");
    const addresses = data.addresses || [];
    return {
      total: data.num,
      returned: Math.min(effectiveLimit, addresses.length),
      addresses: addresses.slice(0, effectiveLimit),
      note: "Set detail=true for full position data including collateral, amounts, and pricing.",
    };
  }

  const effectiveLimit = Math.min(limit ?? 20, 100);
  const effectiveActiveOnly = activeOnly ?? true;

  // collateral is validated to /^0x[a-fA-F0-9]{40}$/ by the tool schema before it
  // ever reaches this interpolation (SECURITY §4.4).
  const whereClause = effectiveActiveOnly
    ? `, where: {closed: false, denied: false${collateral ? `, collateral: "${collateral}"` : ""}}`
    : collateral ? `, where: {collateral: "${collateral}"}` : "";

  const [pData, prices, collateralList] = await Promise.all([
    ponderQuery(`{
      mintingHubV2PositionV2s(limit: ${effectiveLimit}${whereClause}) {
        items {
          position owner collateral collateralSymbol collateralBalance collateralDecimals
          minted availableForMinting price cooldown expiration start
          closed denied isOriginal isClone minimumCollateral
          riskPremiumPPM reserveContribution challengePeriod
        }
        pageInfo { hasNextPage endCursor }
      }
    }`),
    apiFetch("/prices/list"),
    apiFetch("/ecosystem/collateral/list"),
  ]);

  const priceMap = {};
  for (const p of prices) priceMap[p.address.toLowerCase()] = p;

  const decimalsMap = {};
  for (const c of collateralList.list || []) decimalsMap[c.address.toLowerCase()] = c.decimals;

  const items = pData.mintingHubV2PositionV2s?.items || [];
  const cgData = await cgEnrich(items.map((p) => p.collateral?.toLowerCase()).filter(Boolean));

  return {
    total: items.length,
    positions: items.map((p) => {
      const collateralAddr = p.collateral?.toLowerCase();
      const priceEntry = priceMap[collateralAddr];
      const cg = cgData[COINGECKO_IDS[collateralAddr]] ?? null;
      const decimals = decimalsMap[collateralAddr] ?? p.collateralDecimals ?? 18;

      const collateralBalance = fromWei(p.collateralBalance, decimals);
      const minted = fromWei(p.minted);
      const currentPriceChf = priceEntry?.price?.chf;
      const valueChf = currentPriceChf ? collateralBalance * currentPriceChf : null;
      const collateralRatio = valueChf == null
        ? null
        : minted === 0 ? "N/A" : round((valueChf / minted) * 100, 1);

      return {
        address: p.position,
        owner: p.owner,
        status: p.closed ? "closed" : p.denied ? "denied" : "active",
        isOriginal: p.isOriginal,
        isClone: p.isClone,
        collateral: {
          address: p.collateral,
          symbol: p.collateralSymbol,
          decimals,
          balance: collateralBalance,
          minimumRequired: fromWei(p.minimumCollateral, decimals),
          priceChf: currentPriceChf ?? null,
          priceUsd: priceEntry?.price?.usd ?? null,
          change24hPercent: cg?.usd_24h_change != null ? round(cg.usd_24h_change, 2) : null,
          marketCapUsd: cg?.usd_market_cap ? Math.round(cg.usd_market_cap) : null,
          valueChf: valueChf != null ? round(valueChf, 2) : null,
        },
        minted,
        availableForMinting: fromWei(p.availableForMinting),
        collateralRatioPercent: collateralRatio,
        liquidationPriceZchf: fromWei(p.price, 36 - decimals),
        riskPremiumPercent: ppmToPercent(p.riskPremiumPPM || 0),
        reserveContributionPercent: ppmToPercent(p.reserveContribution || 0),
        challengePeriodSeconds: Number(p.challengePeriod || 0),
        cooldownUntil: p.cooldown ? isoFromUnix(p.cooldown) : null,
        expiresAt: p.expiration ? isoFromUnix(p.expiration) : null,
        startedAt: p.start ? isoFromUnix(p.start) : null,
      };
    }),
    pageInfo: pData.mintingHubV2PositionV2s?.pageInfo,
  };
}

/** Batch-load position context for a set of addresses in ONE Ponder request (fixes N+1). */
async function loadPositionContext(addresses) {
  const map = {};
  if (addresses.length === 0) return map;
  const list = addresses.map((a) => `"${a}"`).join(", ");
  try {
    const d = await ponderQuery(`{
      v2: mintingHubV2PositionV2s(where: {position_in: [${list}]}) {
        items { position collateral collateralSymbol collateralDecimals collateralBalance minted price riskPremiumPPM owner }
      }
      v1: mintingHubV1PositionV1s(where: {position_in: [${list}]}) {
        items { position collateral collateralSymbol collateralDecimals collateralBalance minted price annualInterestPPM owner }
      }
    }`);
    for (const v1 of d.v1?.items || []) {
      v1.riskPremiumPPM = v1.annualInterestPPM;
      map[v1.position.toLowerCase()] = v1;
    }
    // V2 preferred — overwrite any V1 entry for the same position.
    for (const v2 of d.v2?.items || []) map[v2.position.toLowerCase()] = v2;
  } catch {
    /* non-fatal — challenges still return with null collateral context */
  }
  return map;
}

export async function getChallenges({ limit = 20, activeOnly = false } = {}) {
  const [data, prices] = await Promise.all([
    apiFetch("/challenges/list"),
    apiFetch("/prices/list"),
  ]);

  let list = data.list || [];
  if (activeOnly) list = list.filter((c) => c.status !== "Success");
  const sliced = list.slice(0, limit);

  const priceMap = {};
  for (const p of prices) priceMap[p.address.toLowerCase()] = p;

  const uniquePositions = [...new Set(sliced.map((c) => c.position.toLowerCase()))];
  const positionMap = await loadPositionContext(uniquePositions);

  const cgData = await cgEnrich(
    Object.values(positionMap).map((p) => p.collateral?.toLowerCase()).filter(Boolean),
  );

  const now = Date.now() / 1000;

  return {
    total: data.num,
    active: (data.list || []).filter((c) => c.status !== "Success").length,
    challenges: sliced.map((c) => {
      const pos = positionMap[c.position.toLowerCase()];
      const collateralDecimals = pos?.collateralDecimals ?? 18;
      const collateralAddr = pos?.collateral?.toLowerCase();
      const priceEntry = collateralAddr ? priceMap[collateralAddr] : null;
      const cg = collateralAddr ? cgData[COINGECKO_IDS[collateralAddr]] : null;

      const liqPriceZchf = fromWei(c.liqPrice, 36 - collateralDecimals);
      const sizeHuman = fromWei(c.size, collateralDecimals);
      const filledHuman = fromWei(c.filledSize, collateralDecimals);
      const acquiredHuman = fromWei(c.acquiredCollateral, collateralDecimals);
      const priceChf = priceEntry?.price?.chf;

      return {
        id: c.id || `${c.position}-challenge-${c.number}`,
        position: c.position,
        number: Number(c.number),
        challenger: c.challenger,
        status: c.status,
        version: c.version,
        startedAt: isoFromUnix(c.start),
        expiresAt: isoFromUnix(Number(c.start) + Number(c.duration)),
        isExpired: Number(c.start) + Number(c.duration) < now,
        durationSeconds: Number(c.duration),
        bids: Number(c.bids),
        txHash: c.txHash,
        collateral: pos ? {
          address: pos.collateral,
          symbol: pos.collateralSymbol,
          decimals: collateralDecimals,
          priceChf: priceChf ?? null,
          priceUsd: priceEntry?.price?.usd ?? null,
          change24hPercent: cg?.usd_24h_change != null ? round(cg.usd_24h_change, 2) : null,
          marketCapUsd: cg?.usd_market_cap ? Math.round(cg.usd_market_cap) : null,
        } : null,
        size: sizeHuman,
        filledSize: filledHuman,
        acquiredCollateral: acquiredHuman,
        fillPercent: sizeHuman > 0 ? round((filledHuman / sizeHuman) * 100, 1) : 0,
        liquidationPriceZchf: liqPriceZchf,
        marketVsLiqPremiumPercent: (priceChf && liqPriceZchf)
          ? round(((priceChf - liqPriceZchf) / liqPriceZchf) * 100, 2)
          : null,
        challengeValueZchf: sizeHuman > 0 ? round(sizeHuman * liqPriceZchf, 2) : null,
        positionOwner: pos?.owner ?? null,
        positionMintedZchf: pos ? fromWei(pos.minted) : null,
        positionCollateralBalance: pos ? fromWei(pos.collateralBalance, collateralDecimals) : null,
        positionRiskPremiumPercent: pos ? ppmToPercent(pos.riskPremiumPPM) : null,
      };
    }),
  };
}

export async function getCollaterals() {
  const data = await apiFetch("/ecosystem/collateral/list");
  const collaterals = (data.list || []).map((c) => ({
    chainId: c.chainId,
    chainName: c.chainName || chainName(c.chainId),
    address: c.address,
    name: c.name,
    symbol: c.symbol,
    decimals: c.decimals,
  }));
  // ⚠️ Behavior change: object envelope (was a bare array).
  return { collaterals, count: collaterals.length };
}
