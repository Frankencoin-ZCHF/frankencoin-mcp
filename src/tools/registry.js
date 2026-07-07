/**
 * The 13 read-only data tools. Each definition owns its zod input schema, so
 * validation, coercion, defaults AND clamps live with the tool (not scattered in a
 * dispatch switch). The SAME schema validates MCP and REST args (ARCHITECTURE §D).
 *
 * `params` is a hand-maintained JSON-Schema-ish descriptor used only for the
 * self-describing /api and /health manifests.
 */

import { z } from "zod";
import { getProtocolSnapshot } from "../services/snapshot.js";
import { getMarketData } from "../services/market.js";
import { getSavings } from "../services/savings.js";
import { getGovernance } from "../services/governance.js";
import { getPositions, getChallenges, getCollaterals } from "../services/positions.js";
import { getAnalytics, getDuneStats } from "../services/analytics.js";
import { getKnowledge, getNews, getMerch } from "../services/content.js";
import { runPonderQuery } from "../services/ponder.js";

// ── zod helpers ──────────────────────────────────────────────────────────────

const finite = (v) => Number.isFinite(v);

/** Integer, coerced from string (REST), finite-checked, clamped, with a default. */
const intClamp = (min, max, def) =>
  z.coerce.number().refine(finite).transform((v) => Math.min(max, Math.max(min, Math.trunc(v)))).default(def);

/** Same, but optional (no default) — used where the service picks a conditional default. */
const intClampOpt = (min, max) =>
  z.coerce.number().refine(finite).transform((v) => Math.min(max, Math.max(min, Math.trunc(v)))).optional();

/** Boolean accepting REST strings ("true"/"1") and native booleans. */
const bool = (def) =>
  z.preprocess((v) => (typeof v === "string" ? v === "true" || v === "1" : v), z.boolean()).default(def);
const boolOpt = () =>
  z.preprocess((v) => (typeof v === "string" ? v === "true" || v === "1" : v), z.boolean()).optional();

const empty = z.object({}).strict();

// ── registry ─────────────────────────────────────────────────────────────────

export const TOOLS = [
  {
    name: "get_protocol_snapshot",
    description:
      "Full live state of the Frankencoin (ZCHF) protocol in one call. Returns: total supply + per-chain breakdown, TVL (CHF/USD), FPS price/supply/market cap/reserve/earnings, savings lead rate + base rate + pending proposals, and active challenge count. Best starting point for any protocol question.",
    input: empty,
    params: [],
    handler: () => getProtocolSnapshot(),
  },
  {
    name: "get_market_data",
    description:
      "Live market data: ZCHF peg health (price vs CHF, deviation, status), FPS price, all ecosystem token prices (collateral + ZCHF + FPS), CHF stablecoin comparison (ZCHF vs VCHF vs CHFAU — peg, market cap, volume, supply), macro context (BTC, ETH prices + 24h changes), and accepted collateral token prices with 24h changes. One call for everything price/market related.",
    input: empty,
    params: [],
    handler: () => getMarketData(),
  },
  {
    name: "get_savings",
    description:
      "Complete savings picture: current approved rates per chain/module, any pending rate proposals, plus per-module stats (total deposited, interest paid, withdrawals, event counts). Combines rate governance state with TVL/flow data in one call.",
    input: empty,
    params: [],
    handler: () => getSavings(),
  },
  {
    name: "get_governance",
    description:
      "Governance activity: rate proposals (pending/past), minter applications (pending/denied/all), FPS equity trades (buy/sell), and FPS/ZCHF holder stats from Dune. Use 'type' to select what governance data to return.",
    input: z.object({
      type: z.enum(["all", "rate_proposals", "minters", "equity_trades", "holders"]).default("all"),
      status: z.enum(["active", "denied", "all", "pending", "approved"]).default("all"),
      limit: intClamp(1, 100, 20),
    }).strict(),
    params: [
      { name: "type", type: "string", required: false, description: "all | rate_proposals | minters | equity_trades | holders (default all)." },
      { name: "status", type: "string", required: false, description: "For minters: active | denied | all. For rate_proposals: pending | approved | all." },
      { name: "limit", type: "number", required: false, description: "Max items per section (default 20, max 100)." },
    ],
    handler: (a) => getGovernance({ type: a.type, status: a.status, limit: a.limit }),
  },
  {
    name: "get_positions",
    description:
      "ZCHF minting positions. By default returns address list + count (lightweight). Set detail=true for full on-chain data: collateral type/balance, minted amount, available capacity, liquidation price, collateral ratio, risk premium, expiry, cooldown, and live market prices.",
    input: z.object({
      detail: bool(false),
      limit: intClampOpt(1, 100),
      active_only: boolOpt(),
      collateral: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
    }).strict(),
    params: [
      { name: "detail", type: "boolean", required: false, description: "Full position details + pricing (default false)." },
      { name: "limit", type: "number", required: false, description: "Max positions (default 50 list / 20 detail, max 100)." },
      { name: "active_only", type: "boolean", required: false, description: "Exclude closed/denied (default true for detail)." },
      { name: "collateral", type: "string", required: false, description: "Filter by collateral token address (0x…40 hex; detail only)." },
    ],
    handler: (a) => getPositions({ detail: a.detail, limit: a.limit, activeOnly: a.active_only, collateral: a.collateral ?? null }),
  },
  {
    name: "get_challenges",
    description:
      "Liquidation challenges against collateral positions. Returns challenge status, size, bids, timing, collateral details, liquidation price, and position context.",
    input: z.object({
      limit: intClamp(1, 100, 20),
      active_only: bool(false),
    }).strict(),
    params: [
      { name: "limit", type: "number", required: false, description: "Max challenges (default 20, max 100)." },
      { name: "active_only", type: "boolean", required: false, description: "Only still-active challenges (default false)." },
    ],
    handler: (a) => getChallenges({ limit: a.limit, activeOnly: a.active_only }),
  },
  {
    name: "get_collaterals",
    description:
      "List all accepted collateral types in the Frankencoin protocol — token names, symbols, addresses, decimals, and which chain they're on.",
    input: empty,
    params: [],
    handler: () => getCollaterals(),
  },
  {
    name: "get_analytics",
    description:
      "Historical protocol analytics. Use 'type' to select: 'time_series' (daily supply, equity, savings, FPS price, rates, earnings — default), 'trades' (FPS equity buy/sell trades), 'minters' (minter application history), 'rate_history' (governance rate change timeline).",
    input: z.object({
      type: z.enum(["time_series", "trades", "minters", "rate_history"]).default("time_series"),
      days: intClamp(1, 365, 90),
      limit: intClamp(1, 100, 20),
    }).strict(),
    params: [
      { name: "type", type: "string", required: false, description: "time_series | trades | minters | rate_history (default time_series)." },
      { name: "days", type: "number", required: false, description: "Days of history (default 90, max 365)." },
      { name: "limit", type: "number", required: false, description: "Max items for trades/minters (default 20, max 100)." },
    ],
    handler: (a) => getAnalytics({ type: a.type, days: a.days, limit: a.limit }),
  },
  {
    name: "get_knowledge",
    description:
      "All explanatory and reference content about Frankencoin. Use 'topic' to select: 'overview' (default — what is Frankencoin), 'faq', 'savings' (savings guide), 'governance', 'minting' (minting guide), 'opening_positions', 'auctions', 'risks', 'reserve', 'pool_shares' (FPS explanation), 'api' (API docs), 'compliance' (links + legal), 'token_addresses' (contract addresses all chains), 'links' (all key URLs + exchanges), 'what_is' (same as overview).",
    // topic is a permissive string: an unknown topic returns { error, availableTopics }
    // from the handler (NOT a 400) and never builds a path from the raw value (SPEC/T28).
    input: z.object({ topic: z.string().max(64).default("overview") }).strict(),
    params: [
      { name: "topic", type: "string", required: false, description: "overview | what_is | faq | savings | governance | minting | opening_positions | auctions | risks | reserve | pool_shares | api | compliance | token_addresses | links (default overview)." },
    ],
    handler: (a) => getKnowledge({ topic: a.topic }),
  },
  {
    name: "get_news",
    description:
      "Frankencoin media coverage: press articles (titles, sources, dates, URLs), videos, real-world use cases, and ecosystem partners. Sourced live from the Frankencoin website repository.",
    input: empty,
    params: [],
    handler: () => getNews(),
  },
  {
    name: "get_merch",
    description:
      "Frankencoin merch store products (merch.frankencoin.com) — titles, prices, variants, availability, images, and direct product URLs. Live data.",
    input: empty,
    params: [],
    handler: () => getMerch(),
  },
  {
    name: "get_dune_stats",
    description:
      "On-chain analytics from Dune Analytics — ZCHF holder count, FPS holder count, historical minting volume, and savings TVL over time. Data may be slightly delayed vs real-time.",
    input: empty,
    params: [],
    handler: () => getDuneStats(),
  },
  {
    name: "query_ponder",
    description:
      "Execute a raw GraphQL query against the Frankencoin on-chain indexer at ponder.frankencoin.com. Read-only queries only. Available entities: mintingHubV2PositionV2s, mintingHubV1PositionV1s, mintingHubV2ChallengeV2s, mintingHubV1ChallengeV1s, equityTrades, analyticDailyLogs, savingsActivity, savingsMappings, frankencoinMinters, eRC20Balances, eRC20TotalSupplys, leadrateRateChangeds, frankencoinProfitLosss, equityTradeCharts.",
    input: z.object({ query: z.string().min(1) }).strict(),
    params: [
      { name: "query", type: "string", required: true, description: "Read-only GraphQL query string." },
    ],
    handler: (a) => runPonderQuery(a.query),
  },
];

/** name → tool definition. */
export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

/** Zod raw shape for MCP registration (server.tool expects a plain shape object). */
export function zodShape(def) {
  return def.input.shape || {};
}
