/**
 * API barrel — re-exports all handlers from the modular api/ directory.
 *
 * 13 consolidated tools:
 *   1. getProtocolSnapshot  — full live state
 *   2. getMarketData        — prices, peg, CHF comparison, macro
 *   3. getSavings           — rates + TVL + module stats
 *   4. getGovernance        — rate proposals, minters, FPS trades, holders
 *   5. getPositions         — positions (list or detail)
 *   6. getChallenges        — liquidation challenges
 *   7. getCollaterals       — accepted collateral list
 *   8. getAnalytics         — historical time-series, trades, minters, rate history
 *   9. getKnowledge         — docs, token addresses, links (topic param)
 *  10. getNews              — press, videos, ecosystem
 *  11. getMerch             — merch store
 *  12. getDuneStats         — Dune holder/volume analytics
 *  13. runPonderQuery       — raw GraphQL escape hatch
 */

export { getProtocolSnapshot } from "./api/snapshot.js";
export { getMarketData } from "./api/market.js";
export { getSavings } from "./api/savings.js";
export { getGovernance } from "./api/governance.js";
export { getPositions, getChallenges, getCollaterals } from "./api/positions.js";
export { getAnalytics, getDuneStats, runPonderQuery } from "./api/analytics.js";
export { getKnowledge, getNews, getMerch } from "./api/content.js";
