/**
 * Analytics, historical data, equity trades, minters, and raw Ponder queries
 */

import {
	ponderQuery,
	CHAIN_NAMES,
	fromWei,
	bpsToPercent,
} from './helpers.js';

export async function getAnalytics({ days = 30 } = {}) {
	const data = await ponderQuery(`{
    analyticDailyLogs(limit: ${days}, orderBy: "timestamp", orderDirection: "desc") {
      items {
        date timestamp totalSupply totalEquity totalSavings
        fpsTotalSupply fpsPrice currentLeadRate projectedInterests
        annualNetEarnings realizedNetEarnings earningsPerFPS
        annualV2BorrowRate totalMintedV1 totalMintedV2
      }
    }
  }`);
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
	const data = await ponderQuery(`{
    equityTrades(limit: ${limit}, orderBy: "created", orderDirection: "desc") {
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

export async function getMinters({ limit = 20 } = {}) {
	const data = await ponderQuery(`{
    frankencoinMinters(limit: ${limit}) {
      items { chainId txHash minter applicationPeriod applicationFee applyMessage applyDate suggestor denyMessage denyDate denyTxHash vetor }
    }
  }`);
	return (data.frankencoinMinters?.items || []).map((m) => ({
		address: m.minter,
		chainId: m.chainId,
		isActive: !m.denyDate,
		applicationFeeChf: fromWei(m.applicationFee),
		appliedAt: m.applyDate
			? new Date(Number(m.applyDate) * 1000).toISOString()
			: null,
		deniedAt: m.denyDate
			? new Date(Number(m.denyDate) * 1000).toISOString()
			: null,
		suggestor: m.suggestor,
		applyMessage: m.applyMessage || null,
		denyMessage: m.denyMessage || null,
		vetor: m.vetor || null,
		txHash: m.txHash,
		applicationPeriodSeconds: Number(m.applicationPeriod),
	}));
}

export async function getHistorical({ days = 90, metric = 'all' } = {}) {
	// Daily analytics (FPS price, supply, rates) — data goes back to 2023-10-28
	const analyticsData = await ponderQuery(`{
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
  }`);

	// Full rate change history (all governance votes)
	const rateData = await ponderQuery(`{
    leadrateRateChangeds(limit: 100, orderBy: "created", orderDirection: "desc") {
      items { chainId module approvedRate created blockheight txHash }
    }
  }`);

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

	// Rate change history — group by chain, show chronological governance timeline
	const rateHistory = (rateData.leadrateRateChangeds?.items || []).map(
		(r) => ({
			date: new Date(Number(r.created) * 1000)
				.toISOString()
				.split('T')[0],
			chainId: r.chainId,
			chainName: CHAIN_NAMES[r.chainId] || `Chain ${r.chainId}`,
			ratePercent: bpsToPercent(r.approvedRate),
			module: r.module,
			txHash: r.txHash,
		}),
	);

	// Ethereum-only rate timeline (clearest governance signal)
	const ethRateTimeline = rateHistory
		.filter((r) => r.chainId === 1)
		.sort((a, b) => a.date.localeCompare(b.date));

	return {
		note: {
			savingsRate:
				'currentLeadRate / savingsRatePercent = what ZCHF savers earn',
			v1BorrowRate:
				'annualV1BorrowRate = interest rate for V1 (legacy CDP) borrowers',
			v2BorrowRate:
				'annualV2BorrowRate = effective interest rate for V2 position borrowers',
			dataRange: `${daily[daily.length - 1]?.date ?? '?'} → ${daily[0]?.date ?? '?'}`,
			totalDays: daily.length,
		},
		daily,
		rateHistory: {
			ethereum: ethRateTimeline,
			all: rateHistory,
		},
	};
}

export async function runPonderQuery(graphqlQuery) {
	return ponderQuery(graphqlQuery);
}
