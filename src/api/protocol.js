/**
 * Core Frankencoin protocol data — info, FPS, prices, savings, collaterals, summary
 */

import {
	apiFetch,
	CHAIN_NAMES,
	fromWei,
	bpsToPercent,
} from './helpers.js';
import { getChallenges } from './positions.js';

export async function getProtocolInfo() {
	const data = await apiFetch('/ecosystem/frankencoin/info');
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
		tvl: { usd: data.tvl?.usd, chf: data.tvl?.chf },
		chains,
	};
}

export async function getFpsInfo() {
	const data = await apiFetch('/ecosystem/fps/info');
	return {
		token: {
			name: data.erc20?.name,
			symbol: data.erc20?.symbol,
			decimals: data.erc20?.decimals,
			address: data.chains?.[1]?.address,
		},
		priceUsd: data.token?.price,
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
	const data = await apiFetch('/prices/list');
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
	const data = await apiFetch('/savings/leadrate/info');
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
	const data = await apiFetch('/savings/core/info');
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
	const data = await apiFetch('/ecosystem/collateral/list');
	return (data.list || []).map((c) => ({
		chainId: c.chainId,
		chainName: CHAIN_NAMES[c.chainId] || `Chain ${c.chainId}`,
		address: c.address,
		name: c.name,
		symbol: c.symbol,
		decimals: c.decimals,
	}));
}

export async function getProtocolSummary() {
	const [info, fps, savings, challenges] = await Promise.all([
		getProtocolInfo(),
		getFpsInfo(),
		getSavingsRates(),
		getChallenges({ limit: 5 }),
	]);

	const leadRate = savings.approved.find(
		(r) => r.chainId === 1 && r.rateBps > 10000,
	);
	const baseRate = savings.approved.find(
		(r) => r.chainId === 1 && r.rateBps === 10000,
	);
	const activeChallenges = challenges.challenges.filter(
		(c) => c.status !== 'Success',
	);

	return {
		zchf: {
			totalSupply: info.totalSupply,
			priceUsd: info.priceUsd,
			tvlChf: info.tvl.chf,
			tvlUsd: info.tvl.usd,
			chainBreakdown: info.chains.map((c) => ({
				chain: c.chainName,
				supply: c.supply,
				sharePercent: Number(
					((c.supply / info.totalSupply) * 100).toFixed(1),
				),
			})),
		},
		fps: {
			priceChf: info.fps.priceChf,
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
			active: challenges.active,
			recent: activeChallenges.slice(0, 3),
		},
		updatedAt: new Date().toISOString(),
	};
}
