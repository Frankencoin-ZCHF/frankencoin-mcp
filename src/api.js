/**
 * Frankencoin API — barrel re-export.
 *
 * Modules:
 *   api/helpers.js   — shared constants, fetch helpers, number utils
 *   api/protocol.js  — ZCHF info, FPS, prices, savings rates/stats, collaterals
 *   api/positions.js — positions and challenges
 *   api/analytics.js — analytics, historical, equity trades, minters, Dune
 *   api/market.js    — market context, CHF stablecoin comparison
 *   api/content.js   — docs, links, token addresses, media, merch
 *   api/summary.js   — high-level protocol summary
 */

export { getProtocolInfo, getFpsInfo, getPrices, getSavingsRates, getSavingsStats, getCollaterals } from "./api/protocol.js";
export { getPositions, getPositionsDetail, getChallenges } from "./api/positions.js";
export { getAnalytics, getHistorical, getEquityTrades, getMinters, getDuneStats, runPonderQuery } from "./api/analytics.js";
export { getMarketContext, getChfStablecoins } from "./api/market.js";
export { getTokenAddresses, getLinks, getDocs, getMediaAndUseCases, getMerch } from "./api/content.js";
export { getProtocolSummary } from "./api/summary.js";
