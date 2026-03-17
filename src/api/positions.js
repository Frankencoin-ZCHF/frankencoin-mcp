/**
 * Positions and challenges
 */

import {
	apiFetch,
	ponderQuery,
	cgFetch,
	CG_KEY,
	COINGECKO_IDS,
	fromWei,
	ppmToPercent,
} from './helpers.js';

export async function getPositions({ limit = 50 } = {}) {
	const data = await apiFetch('/positions/open');
	return {
		total: data.num,
		returned: Math.min(limit, (data.addresses || []).length),
		addresses: (data.addresses || []).slice(0, limit),
		note: 'Use get_positions_detail for full position data including collateral, amounts, and pricing',
	};
}

export async function getPositionsDetail({
	limit = 20,
	activeOnly = true,
	collateral = null,
} = {}) {
	// Fetch positions, prices, and collateral list in parallel.
	// The collateral list is the authoritative source for decimals — the position
	// entity's collateralDecimals field can be stale/wrong for tokens with non-18
	// decimals (e.g. LENDS shows 18 in position entity but 0 in collateral list).
	const [pData, prices, collateralList] = await Promise.all([
		ponderQuery(`{
      mintingHubV2PositionV2s(limit: ${limit}${activeOnly ? ', where: {closed: false, denied: false' + (collateral ? `, collateral: "${collateral}"` : '') + '}' : collateral ? `, where: {collateral: "${collateral}"}` : ''}) {
        items {
          position owner collateral collateralSymbol collateralBalance collateralDecimals
          minted availableForMinting price cooldown expiration start
          closed denied isOriginal isClone minimumCollateral
          riskPremiumPPM reserveContribution challengePeriod
        }
        pageInfo { hasNextPage endCursor }
      }
    }`),
		apiFetch('/prices/list'),
		apiFetch('/ecosystem/collateral/list'),
	]);

	const priceMap = {};
	for (const p of prices) priceMap[p.address.toLowerCase()] = p;

	// Build authoritative decimals map from collateral list (keyed by lowercase address)
	const decimalsMap = {};
	for (const c of collateralList.list || []) {
		decimalsMap[c.address.toLowerCase()] = c.decimals;
	}

	// Enrich with CoinGecko data for all unique collaterals
	const collateralAddrs = [
		...new Set(
			(pData.mintingHubV2PositionV2s?.items || [])
				.map((p) => p.collateral?.toLowerCase())
				.filter(Boolean),
		),
	];
	const cgIds = [
		...new Set(
			collateralAddrs.map((a) => COINGECKO_IDS[a]).filter(Boolean),
		),
	];
	let cgData = {};
	if (cgIds.length > 0 && CG_KEY) {
		try {
			cgData = await cgFetch(
				`/simple/price?ids=${cgIds.join(',')}&vs_currencies=usd,chf&include_24hr_change=true&include_market_cap=true`,
			);
		} catch {
			/* non-fatal */
		}
	}

	const items = pData.mintingHubV2PositionV2s?.items || [];
	return {
		total: items.length,
		positions: items.map((p) => {
			const collateralAddr = p.collateral?.toLowerCase();
			const priceEntry = priceMap[collateralAddr];
			const cgId = COINGECKO_IDS[collateralAddr];
			const cg = cgId ? cgData[cgId] : null;
			// Use collateral list decimals as ground truth; fall back to position entity field.
			const decimals =
				decimalsMap[collateralAddr] ?? p.collateralDecimals ?? 18;

			const collateralBalance = fromWei(p.collateralBalance, decimals);
			const minted = fromWei(p.minted);
			// Price is stored as ZCHF × 10^(36 - collateralDecimals) per collateral token
			const liqPrice = fromWei(p.price, 36 - decimals);
			const currentPriceChf = priceEntry?.price?.chf;

			// Collateral value at current market price
			const collateralValueChf = currentPriceChf
				? collateralBalance * currentPriceChf
				: null;
			// Collateral ratio = collateral value / minted ZCHF
			const collateralRatio =
				collateralValueChf == null
					? null
					: minted === 0
						? 'N/A'
						: Number(
								((collateralValueChf / minted) * 100).toFixed(
									1,
								),
							);

			return {
				address: p.position,
				owner: p.owner,
				status: p.closed ? 'closed' : p.denied ? 'denied' : 'active',
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
					change24hPercent: cg?.usd_24h_change?.toFixed(2) ?? null,
					marketCapUsd: cg?.usd_market_cap
						? Math.round(cg.usd_market_cap)
						: null,
					valueChf: collateralValueChf
						? Number(collateralValueChf.toFixed(2))
						: null,
				},
				minted,
				availableForMinting: fromWei(p.availableForMinting),
				collateralRatioPercent: collateralRatio,
				liquidationPriceZchf: liqPrice,
				riskPremiumPercent: ppmToPercent(p.riskPremiumPPM || 0),
				reserveContributionPercent: ppmToPercent(
					p.reserveContribution || 0,
				),
				challengePeriodSeconds: Number(p.challengePeriod || 0),
				cooldownUntil: p.cooldown
					? new Date(Number(p.cooldown) * 1000).toISOString()
					: null,
				expiresAt: p.expiration
					? new Date(Number(p.expiration) * 1000).toISOString()
					: null,
				startedAt: p.start
					? new Date(Number(p.start) * 1000).toISOString()
					: null,
			};
		}),
		pageInfo: pData.mintingHubV2PositionV2s?.pageInfo,
	};
}

export async function getChallenges({ limit = 20, activeOnly = false } = {}) {
	// Fetch challenges + prices in parallel
	const [data, prices] = await Promise.all([
		apiFetch('/challenges/list'),
		apiFetch('/prices/list'),
	]);

	let list = data.list || [];

	// Use API status as ground truth — don't re-derive from expiry timestamp
	if (activeOnly) {
		list = list.filter((c) => c.status !== 'Success');
	}
	const sliced = list.slice(0, limit);

	// Build price lookup by address (lowercase)
	const priceMap = {};
	for (const p of prices) priceMap[p.address.toLowerCase()] = p;

	// Fetch position details for each unique position address individually
	const uniquePositions = [
		...new Set(sliced.map((c) => c.position.toLowerCase())),
	];
	const positionMap = {};

	await Promise.all(
		uniquePositions.map(async (addr) => {
			try {
				const q = `{
        v2: mintingHubV2PositionV2s(where: {position: "${addr}"}) {
          items { position collateral collateralSymbol collateralDecimals collateralBalance minted price riskPremiumPPM owner }
        }
        v1: mintingHubV1PositionV1s(where: {position: "${addr}"}) {
          items { position collateral collateralSymbol collateralDecimals collateralBalance minted price annualInterestPPM owner }
        }
      }`;
				const d = await ponderQuery(q);
				const v2 = d.v2?.items?.[0];
				const v1 = d.v1?.items?.[0];
				if (v2) {
					positionMap[addr] = v2;
				} else if (v1) {
					// Normalize V1 field name to match V2 interface
					v1.riskPremiumPPM = v1.annualInterestPPM;
					positionMap[addr] = v1;
				}
			} catch {
				/* non-fatal */
			}
		}),
	);

	// Enrich with CoinGecko 24h change if available
	const collateralAddresses = Object.values(positionMap)
		.map((p) => p.collateral?.toLowerCase())
		.filter(Boolean);
	const cgIds = [
		...new Set(
			collateralAddresses.map((a) => COINGECKO_IDS[a]).filter(Boolean),
		),
	];
	let cgData = {};
	if (cgIds.length > 0 && CG_KEY) {
		try {
			cgData = await cgFetch(
				`/simple/price?ids=${cgIds.join(',')}&vs_currencies=usd,chf&include_24hr_change=true&include_market_cap=true`,
			);
		} catch {
			/* non-fatal */
		}
	}

	const now = Date.now() / 1000;

	return {
		total: data.num,
		active: (data.list || []).filter((c) => c.status !== 'Success').length,
		challenges: sliced.map((c) => {
			const pos = positionMap[c.position.toLowerCase()];
			const collateralDecimals = pos?.collateralDecimals ?? 18;
			const collateralAddr = pos?.collateral?.toLowerCase();
			const priceEntry = collateralAddr ? priceMap[collateralAddr] : null;
			const cgId = collateralAddr ? COINGECKO_IDS[collateralAddr] : null;
			const cg = cgId ? cgData[cgId] : null;

			// liqPrice is stored as ZCHF-per-collateral-token × 10^(36 - collateralDecimals)
			const liqPriceZchf = fromWei(c.liqPrice, 36 - collateralDecimals);

			const sizeHuman = fromWei(c.size, collateralDecimals);
			const filledHuman = fromWei(c.filledSize, collateralDecimals);
			const acquiredHuman = fromWei(
				c.acquiredCollateral,
				collateralDecimals,
			);

			return {
				id: c.id || `${c.position}-challenge-${c.number}`,
				position: c.position,
				number: Number(c.number),
				challenger: c.challenger,
				status: c.status,
				version: c.version,
				startedAt: new Date(Number(c.start) * 1000).toISOString(),
				expiresAt: new Date(
					(Number(c.start) + Number(c.duration)) * 1000,
				).toISOString(),
				isExpired: Number(c.start) + Number(c.duration) < now,
				durationSeconds: Number(c.duration),
				bids: Number(c.bids),
				txHash: c.txHash,

				// ── Collateral details ──
				collateral: pos
					? {
							address: pos.collateral,
							symbol: pos.collateralSymbol,
							decimals: collateralDecimals,
							priceChf: priceEntry?.price?.chf ?? null,
							priceUsd: priceEntry?.price?.usd ?? null,
							change24hPercent:
								cg?.usd_24h_change?.toFixed(2) ?? null,
							marketCapUsd: cg?.usd_market_cap
								? Math.round(cg.usd_market_cap)
								: null,
						}
					: null,

				// ── Challenge sizing (human-readable, correct decimals) ──
				size: sizeHuman,
				filledSize: filledHuman,
				acquiredCollateral: acquiredHuman,
				fillPercent:
					sizeHuman > 0
						? Number(((filledHuman / sizeHuman) * 100).toFixed(1))
						: 0,

				// ── Pricing ──
				liquidationPriceZchf: liqPriceZchf,
				marketVsLiqPremiumPercent:
					priceEntry?.price?.chf && liqPriceZchf
						? Number(
								(
									((priceEntry.price.chf - liqPriceZchf) /
										liqPriceZchf) *
									100
								).toFixed(2),
							)
						: null,
				challengeValueZchf:
					sizeHuman > 0
						? Number((sizeHuman * liqPriceZchf).toFixed(2))
						: null,

				// ── Position context ──
				positionOwner: pos?.owner ?? null,
				positionMintedZchf: pos ? fromWei(pos.minted) : null,
				positionCollateralBalance: pos
					? fromWei(pos.collateralBalance, collateralDecimals)
					: null,
				positionRiskPremiumPercent: pos
					? ppmToPercent(pos.riskPremiumPPM)
					: null,
			};
		}),
	};
}
