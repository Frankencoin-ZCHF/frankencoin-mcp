/**
 * API barrel — re-exports all API functions from their modules.
 * Import as: import * as api from './api/index.js'
 */

export {
	getProtocolInfo,
	getFpsInfo,
	getPrices,
	getSavingsRates,
	getSavingsStats,
	getCollaterals,
	getProtocolSummary,
} from './protocol.js';

export {
	getPositions,
	getPositionsDetail,
	getChallenges,
} from './positions.js';

export {
	getAnalytics,
	getEquityTrades,
	getMinters,
	getHistorical,
	runPonderQuery,
} from './analytics.js';

export {
	getMarketContext,
	getChfStablecoins,
	getDuneStats,
} from './market.js';

export {
	getTokenAddresses,
	getLinks,
	getDocs,
	getMediaAndUseCases,
	getMerch,
} from './content.js';
