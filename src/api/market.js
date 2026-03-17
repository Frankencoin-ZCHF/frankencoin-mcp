/**
 * External market data — CoinGecko market context, CHF stablecoin comparison, Dune Analytics
 */

import {
	apiFetch,
	cgFetch,
	duneExecute,
	ethCall,
	CG_KEY,
	DUNE_KEY,
	COINGECKO_IDS,
	DUNE_QUERIES,
	CHFAU_CONTRACT,
} from './helpers.js';

export async function getMarketContext() {
	if (!CG_KEY) throw new Error('CoinGecko API key not configured on server');

	const collateralCgIds = [...new Set(Object.values(COINGECKO_IDS))].join(
		',',
	);

	const [zchfData, macroData, collateralData, fcPrices, globalData] =
		await Promise.all([
			cgFetch(
				`/simple/price?ids=frankencoin&vs_currencies=usd,chf&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true`,
			),
			cgFetch(
				`/simple/price?ids=bitcoin,ethereum&vs_currencies=usd,chf&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true`,
			),
			cgFetch(
				`/simple/price?ids=${collateralCgIds}&vs_currencies=usd,chf&include_24hr_change=true&include_market_cap=true`,
			),
			apiFetch('/prices/list'),
			cgFetch(`/global`).catch(() => null),
		]);

	const fpsEntry = fcPrices.find((p) => p.symbol === 'FPS');
	const zchfEntry = fcPrices.find((p) => p.symbol === 'ZCHF');

	const zchf = zchfData['frankencoin'] || {};

	const zchfPriceChf = zchfEntry?.price?.chf ?? zchf.chf;
	const pegDeviation = zchfPriceChf ? (zchfPriceChf - 1) * 100 : null;

	const collateralTable = Object.entries(COINGECKO_IDS)
		.map(([addr, cgId]) => {
			const cg = collateralData[cgId] || {};
			const fcEntry = fcPrices.find(
				(p) => p.address?.toLowerCase() === addr,
			);
			return {
				symbol: fcEntry?.symbol ?? cgId,
				name: fcEntry?.name ?? cgId,
				address: addr,
				priceUsd: cg.usd ?? fcEntry?.price?.usd ?? null,
				priceChf: fcEntry?.price?.chf ?? cg.chf ?? null,
				change24hPercent:
					cg.usd_24h_change != null
						? Number(cg.usd_24h_change.toFixed(2))
						: null,
				marketCapUsd: cg.usd_market_cap
					? Math.round(cg.usd_market_cap)
					: null,
			};
		})
		.sort((a, b) => (b.marketCapUsd ?? 0) - (a.marketCapUsd ?? 0));

	return {
		zchf: {
			priceUsd: zchf.usd,
			priceChf: zchfPriceChf,
			change24hPercent:
				zchf.usd_24h_change != null
					? Number(zchf.usd_24h_change.toFixed(2))
					: null,
			volume24hUsd: zchf.usd_24h_vol ?? null,
			marketCapUsd: zchf.usd_market_cap ?? null,
			pegDeviationPercent:
				pegDeviation != null ? Number(pegDeviation.toFixed(4)) : null,
			pegStatus:
				pegDeviation == null
					? 'unknown'
					: Math.abs(pegDeviation) < 0.5
						? 'healthy'
						: Math.abs(pegDeviation) < 1.0
							? 'warning'
							: 'critical',
		},
		fps: {
			priceChf: fpsEntry?.price?.chf ?? null,
			priceUsd: fpsEntry?.price?.usd ?? null,
			note: 'FPS is not listed on CoinGecko — price sourced from Frankencoin API',
		},
		macro: {
			bitcoin: {
				priceUsd: macroData.bitcoin?.usd,
				priceChf: macroData.bitcoin?.chf,
				change24hPercent:
					macroData.bitcoin?.usd_24h_change != null
						? Number(macroData.bitcoin.usd_24h_change.toFixed(2))
						: null,
				volume24hUsd: macroData.bitcoin?.usd_24h_vol ?? null,
				marketCapUsd: macroData.bitcoin?.usd_market_cap
					? Math.round(macroData.bitcoin.usd_market_cap)
					: null,
			},
			ethereum: {
				priceUsd: macroData.ethereum?.usd,
				priceChf: macroData.ethereum?.chf,
				change24hPercent:
					macroData.ethereum?.usd_24h_change != null
						? Number(macroData.ethereum.usd_24h_change.toFixed(2))
						: null,
				volume24hUsd: macroData.ethereum?.usd_24h_vol ?? null,
				marketCapUsd: macroData.ethereum?.usd_market_cap
					? Math.round(macroData.ethereum.usd_market_cap)
					: null,
			},
		},
		collateral: collateralTable,
		defiTotalMarketCapUsd: globalData?.data?.total_market_cap?.usd
			? Math.round(globalData.data.total_market_cap.usd)
			: null,
		updatedAt: new Date().toISOString(),
	};
}

export async function getChfStablecoins() {
	if (!CG_KEY) throw new Error('CoinGecko API key not configured on server');

	const [cgData, chfauSupplyHex] = await Promise.all([
		cgFetch(
			`/coins/markets?vs_currency=chf&ids=frankencoin,vnx-swiss-franc&order=market_cap_desc&sparkline=false&price_change_percentage=24h`,
		),
		ethCall(CHFAU_CONTRACT, '0x18160ddd').catch(() => null),
	]);

	const zchfCg = cgData.find((c) => c.id === 'frankencoin') || {};
	const vchfCg = cgData.find((c) => c.id === 'vnx-swiss-franc') || {};

	let chfauSupply = null;
	try {
		if (chfauSupplyHex && chfauSupplyHex !== '0x') {
			chfauSupply = Math.round(Number(BigInt(chfauSupplyHex)) / 1e6);
		}
	} catch {
		chfauSupply = null;
	}

	function pegStatus(price) {
		if (price == null) return 'unknown';
		const dev = Math.abs(price - 1) * 100;
		return dev < 0.5 ? 'healthy' : dev < 1.0 ? 'warning' : 'critical';
	}

	return {
		stablecoins: [
			{
				name: 'Frankencoin',
				symbol: 'ZCHF',
				type: 'CDP / overcollateralised',
				issuer: 'Frankencoin Association',
				coingeckoId: 'frankencoin',
				priceChf: zchfCg.current_price ?? null,
				pegDeviationPercent:
					zchfCg.current_price != null
						? Number(((zchfCg.current_price - 1) * 100).toFixed(4))
						: null,
				pegStatus: pegStatus(zchfCg.current_price),
				marketCapChf: zchfCg.market_cap ?? null,
				volume24hChf: zchfCg.total_volume ?? null,
				change24hPercent:
					zchfCg.price_change_percentage_24h != null
						? Number(zchfCg.price_change_percentage_24h.toFixed(4))
						: null,
				circulatingSupply: zchfCg.circulating_supply ?? null,
				dataSource: 'CoinGecko',
			},
			{
				name: 'VNX Swiss Franc',
				symbol: 'VCHF',
				type: 'Fiat-backed',
				issuer: 'VNX',
				coingeckoId: 'vnx-swiss-franc',
				priceChf: vchfCg.current_price ?? null,
				pegDeviationPercent:
					vchfCg.current_price != null
						? Number(((vchfCg.current_price - 1) * 100).toFixed(4))
						: null,
				pegStatus: pegStatus(vchfCg.current_price),
				marketCapChf: vchfCg.market_cap ?? null,
				volume24hChf: vchfCg.total_volume ?? null,
				change24hPercent:
					vchfCg.price_change_percentage_24h != null
						? Number(vchfCg.price_change_percentage_24h.toFixed(4))
						: null,
				circulatingSupply: vchfCg.circulating_supply ?? null,
				dataSource: 'CoinGecko',
			},
			{
				name: 'AllUnity CHF',
				symbol: 'CHFAU',
				type: 'Fiat-backed',
				issuer: 'AllUnity (DWS + Flow Traders + Galaxy)',
				coingeckoId: 'allunity-chf',
				priceChf: null,
				pegDeviationPercent: null,
				pegStatus: 'unknown',
				marketCapChf: null,
				volume24hChf: null,
				change24hPercent: null,
				circulatingSupply: chfauSupply,
				contract: CHFAU_CONTRACT,
				note: 'No CoinGecko price feed yet — supply from on-chain (Ethereum, 6 decimals)',
				dataSource: 'Etherscan',
			},
		],
		updatedAt: new Date().toISOString(),
	};
}

export async function getDuneStats() {
	if (!DUNE_KEY) throw new Error('Dune API key not configured on server');

	const [zchfHolderRows, fpsHolderRows, mintingRows, savingsTvlRows] =
		await Promise.allSettled([
			duneExecute(DUNE_QUERIES.zchfHolders),
			duneExecute(DUNE_QUERIES.fpsHolders),
			duneExecute(DUNE_QUERIES.mintingVolume),
			duneExecute(DUNE_QUERIES.savingsTvl),
		]);

	function settled(r) {
		return r.status === 'fulfilled' ? r.value : null;
	}

	const zchfRows = settled(zchfHolderRows);
	const fpsRows = settled(fpsHolderRows);
	const mintRows = settled(mintingRows);
	const savRows = settled(savingsTvlRows);

	return {
		holders: {
			zchf: zchfRows ? zchfRows[0] : null,
			fps: fpsRows ? fpsRows[0] : null,
		},
		minting: mintRows ? mintRows.slice(0, 30) : null,
		savingsTvl: savRows ? savRows.slice(0, 30) : null,
		note: 'Data from Dune Analytics — may be slightly delayed vs on-chain',
	};
}
