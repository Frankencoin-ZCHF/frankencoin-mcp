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
import { collateralPrices } from "./collateral-prices.js";
import { priceQuality } from "../lib/prices.js";
import { fromWei, ppmToPercent, round, isoFromUnix } from "../lib/numbers.js";
import { chainName } from "../lib/constants.js";

function units(raw, decimals = 18) {
  if (raw == null || !/^\d+$/.test(String(raw)) || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) return null;
  return fromWei(raw, decimals);
}
function numberOrNull(value) {
  return value != null && /^\d+$/.test(String(value)) && Number.isFinite(Number(value)) ? Number(value) : null;
}
export async function getPositions({ detail = false, limit, activeOnly, collateral = null } = {}) {
  if (!detail) {
    const effectiveLimit = limit ?? 50;
    const data = await apiFetch("/positions/open");
    const addresses = data.addresses || [];
    return {
      total: data.num,
      totalMatching: data.num ?? null,
      totalScope: "source_open_population",
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
  for (const p of prices) if (p.chainId === 1) priceMap[p.address.toLowerCase()] = priceQuality(p);

  const decimalsMap = {};
  for (const c of collateralList.list || []) if (c.chainId === 1) decimalsMap[c.address.toLowerCase()] = c.decimals;

  const items = pData.mintingHubV2PositionV2s?.items || [];
  const enrichment = await collateralPrices(items.map((p) => p.collateral?.toLowerCase()).filter(Boolean));

  return {
    sources: { coingecko: enrichment.health },
    total: items.length,
    returned: items.length,
    totalMatching: null,
    totalScope: "returned_page",
    capacityNote: "availableForMinting is the source nominal allowance, not executable capacity; closed/denied/expired/cooldown and collateral constraints require additional contract checks. total is retained as a deprecated page-length alias; totalMatching is not provided by this query.",
    positions: items.map((p) => {
      const collateralAddr = p.collateral?.toLowerCase();
      const priceEntry = priceMap[collateralAddr];
      const cg = enrichment.value?.[collateralAddr] ?? null;
      const decimals = numberOrNull(decimalsMap[collateralAddr] ?? p.collateralDecimals);

      const collateralBalance = units(p.collateralBalance, decimals);
      const minted = units(p.minted);
      const currentPriceChf = priceEntry?.price?.chf;
      const valueChf = currentPriceChf != null && collateralBalance != null ? collateralBalance * currentPriceChf : null;
      const collateralRatio = valueChf == null || minted == null
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
          minimumRequired: units(p.minimumCollateral, decimals),
          freshness: priceEntry?.freshness ?? null,
          priceChf: currentPriceChf ?? null,
          priceUsd: priceEntry?.price?.usd ?? null,
          change24hPercent: cg?.usd_24h_change != null ? round(cg.usd_24h_change, 2) : null,
          marketCapUsd: cg?.usd_market_cap != null ? Math.round(cg.usd_market_cap) : null,
          valueChf: valueChf != null ? round(valueChf, 2) : null,
        },
        minted,
        availableForMinting: units(p.availableForMinting),
        availableForMintingNominal: units(p.availableForMinting),
        executableMintingCapacity: null,
        collateralRatioPercent: collateralRatio,
        liquidationPriceZchf: units(p.price, decimals == null ? null : 36 - decimals),
        riskPremiumPercent: p.riskPremiumPPM == null ? null : ppmToPercent(p.riskPremiumPPM),
        reserveContributionPercent: p.reserveContribution == null ? null : ppmToPercent(p.reserveContribution),
        challengePeriodSeconds: numberOrNull(p.challengePeriod),
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
  for (const p of prices) if (p.chainId === 1) priceMap[p.address.toLowerCase()] = priceQuality(p);

  const uniquePositions = [...new Set(sliced.map((c) => c.position.toLowerCase()))];
  const positionMap = await loadPositionContext(uniquePositions);

  const enrichment = await collateralPrices(
    Object.values(positionMap).map((p) => p.collateral?.toLowerCase()).filter(Boolean),
  );

  const now = Date.now() / 1000;

  return {
    sources: { coingecko: enrichment.health },
    total: data.num,
    active: (data.list || []).filter((c) => c.status !== "Success").length,
    challenges: sliced.map((c) => {
      const pos = positionMap[c.position.toLowerCase()];
      const collateralDecimals = numberOrNull(pos?.collateralDecimals);
      const collateralAddr = pos?.collateral?.toLowerCase();
      const priceEntry = collateralAddr ? priceMap[collateralAddr] : null;
      const cg = collateralAddr ? enrichment.value?.[collateralAddr] : null;

      const liqPriceZchf = units(c.liqPrice, collateralDecimals == null ? null : 36 - collateralDecimals);
      const sizeHuman = units(c.size, collateralDecimals);
      const filledHuman = units(c.filledSize, collateralDecimals);
      const acquiredHuman = units(c.acquiredCollateral, collateralDecimals);
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
          freshness: priceEntry?.freshness ?? null,
          priceChf: priceChf ?? null,
          priceUsd: priceEntry?.price?.usd ?? null,
          change24hPercent: cg?.usd_24h_change != null ? round(cg.usd_24h_change, 2) : null,
          marketCapUsd: cg?.usd_market_cap != null ? Math.round(cg.usd_market_cap) : null,
        } : null,
        size: sizeHuman,
        filledSize: filledHuman,
        acquiredCollateral: acquiredHuman,
        fillPercent: sizeHuman > 0 && filledHuman != null ? round((filledHuman / sizeHuman) * 100, 1) : null,
        liquidationPriceZchf: liqPriceZchf,
        marketVsLiqPremiumPercent: (priceChf && liqPriceZchf)
          ? round(((priceChf - liqPriceZchf) / liqPriceZchf) * 100, 2)
          : null,
        challengeValueZchf: sizeHuman != null && liqPriceZchf != null ? round(sizeHuman * liqPriceZchf, 2) : null,
        positionOwner: pos?.owner ?? null,
        positionMintedZchf: pos ? units(pos.minted) : null,
        positionCollateralBalance: pos ? units(pos.collateralBalance, collateralDecimals) : null,
        positionRiskPremiumPercent: pos?.riskPremiumPPM != null ? ppmToPercent(pos.riskPremiumPPM) : null,
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
