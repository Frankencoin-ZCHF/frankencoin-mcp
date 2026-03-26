/**
 * MCP tool definitions for the Frankencoin MCP server
 *
 * 13 consolidated tools — organized by what the agent needs, not where data comes from.
 * Philosophy: single responsibility per tool, agent-centric design.
 */

import { z } from "zod";

export const TOOLS = [
  // ─── 1. Protocol Snapshot ───────────────────────────────────────────────────
  {
    name: "get_protocol_snapshot",
    description:
      "Full live state of the Frankencoin (ZCHF) protocol in one call. Returns: total supply + per-chain breakdown, TVL (CHF/USD), FPS price/supply/market cap/reserve/earnings, savings lead rate + base rate + pending proposals, and active challenge count. Best starting point for any protocol question.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },

  // ─── 2. Market Data ────────────────────────────────────────────────────────
  {
    name: "get_market_data",
    description:
      "Live market data: ZCHF peg health (price vs CHF, deviation, status), FPS price, all ecosystem token prices (collateral + ZCHF + FPS), CHF stablecoin comparison (ZCHF vs VCHF vs CHFAU — peg, market cap, volume, supply), macro context (BTC, ETH prices + 24h changes), and accepted collateral token prices with 24h changes. One call for everything price/market related.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },

  // ─── 3. Savings ─────────────────────────────────────────────────────────────
  {
    name: "get_savings",
    description:
      "Complete savings picture: current approved rates per chain/module, any pending rate proposals, plus per-module stats (total deposited, interest paid, withdrawals, event counts). Combines rate governance state with TVL/flow data in one call.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },

  // ─── 4. Governance ──────────────────────────────────────────────────────────
  {
    name: "get_governance",
    description:
      "Governance activity: rate proposals (pending/past), minter applications (pending/denied/all), FPS equity trades (buy/sell), and FPS/ZCHF holder stats from Dune. Use 'type' to select what governance data to return.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          description: "What governance data to return. One of: 'all' (default — everything), 'rate_proposals' (pending + recent rate changes), 'minters' (minter applications), 'equity_trades' (FPS buy/sell trades), 'holders' (holder counts from Dune).",
        },
        status: {
          type: "string",
          description: "Filter by status where applicable. For minters: 'active', 'denied', 'all' (default). For rate_proposals: 'pending', 'approved', 'all' (default).",
        },
        limit: {
          type: "number",
          description: "Maximum items to return per section (default: 20, max: 100).",
        },
      },
      required: [],
    },
  },

  // ─── 5. Positions ──────────────────────────────────────────────────────────
  {
    name: "get_positions",
    description:
      "ZCHF minting positions. By default returns address list + count (lightweight). Set detail=true for full on-chain data: collateral type/balance, minted amount, available capacity, liquidation price, collateral ratio, risk premium, expiry, cooldown, and live market prices.",
    inputSchema: {
      type: "object",
      properties: {
        detail: {
          type: "boolean",
          description: "If true, return full position details with collateral data and pricing (default: false — returns address list only).",
        },
        limit: {
          type: "number",
          description: "Maximum positions to return (default: 50 for list, 20 for detail, max: 100).",
        },
        active_only: {
          type: "boolean",
          description: "If true (default for detail), exclude closed and denied positions.",
        },
        collateral: {
          type: "string",
          description: "Filter by collateral token address (only with detail=true).",
        },
      },
      required: [],
    },
  },

  // ─── 6. Challenges ─────────────────────────────────────────────────────────
  {
    name: "get_challenges",
    description:
      "Liquidation challenges against collateral positions. Returns challenge status, size, bids, timing, collateral details, liquidation price, and position context.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of challenges to return (default: 20, max: 100).",
        },
        active_only: {
          type: "boolean",
          description: "If true, return only challenges that are still active/open (default: false).",
        },
      },
      required: [],
    },
  },

  // ─── 7. Collaterals ────────────────────────────────────────────────────────
  {
    name: "get_collaterals",
    description:
      "List all accepted collateral types in the Frankencoin protocol — token names, symbols, addresses, decimals, and which chain they're on.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },

  // ─── 8. Analytics ──────────────────────────────────────────────────────────
  {
    name: "get_analytics",
    description:
      "Historical protocol analytics. Use 'type' to select: 'time_series' (daily supply, equity, savings, FPS price, rates, earnings — default), 'trades' (FPS equity buy/sell trades), 'minters' (minter application history), 'rate_history' (governance rate change timeline).",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          description: "Analytics type: 'time_series' (default), 'trades', 'minters', 'rate_history'.",
        },
        days: {
          type: "number",
          description: "Number of days of history for time_series/rate_history (default: 90, max: 365).",
        },
        limit: {
          type: "number",
          description: "Maximum items for trades/minters (default: 20, max: 100).",
        },
      },
      required: [],
    },
  },

  // ─── 9. Knowledge ──────────────────────────────────────────────────────────
  {
    name: "get_knowledge",
    description:
      "All explanatory and reference content about Frankencoin. Use 'topic' to select: 'overview' (default — what is Frankencoin), 'faq', 'savings' (savings guide), 'governance', 'minting' (minting guide), 'opening_positions', 'auctions', 'risks', 'reserve', 'pool_shares' (FPS explanation), 'api' (API docs), 'compliance' (links + legal), 'token_addresses' (contract addresses all chains), 'links' (all key URLs + exchanges), 'what_is' (same as overview).",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "Topic to fetch. One of: overview, what_is, faq, savings, governance, minting, opening_positions, auctions, risks, reserve, pool_shares, api, compliance, token_addresses, links. Defaults to 'overview'.",
        },
      },
      required: [],
    },
  },

  // ─── 10. News ──────────────────────────────────────────────────────────────
  {
    name: "get_news",
    description:
      "Frankencoin media coverage: press articles (titles, sources, dates, URLs), videos, real-world use cases, and ecosystem partners. Sourced live from the Frankencoin website repository.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },

  // ─── 11. Merch ─────────────────────────────────────────────────────────────
  {
    name: "get_merch",
    description:
      "Frankencoin merch store products (merch.frankencoin.com) — titles, prices, variants, availability, images, and direct product URLs. Live data.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },

  // ─── 12. Dune Stats ────────────────────────────────────────────────────────
  {
    name: "get_dune_stats",
    description:
      "On-chain analytics from Dune Analytics — ZCHF holder count, FPS holder count, historical minting volume, and savings TVL over time. Data may be slightly delayed vs real-time.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },

  // ─── 13. Ponder Query ──────────────────────────────────────────────────────
  {
    name: "query_ponder",
    description:
      "Execute a raw GraphQL query against the Frankencoin on-chain indexer at ponder.frankencoin.com. Use for advanced queries not covered by other tools. Available entities: mintingHubV2PositionV2s, mintingHubV1PositionV1s, mintingHubV2ChallengeV2s, mintingHubV1ChallengeV1s, equityTrades, analyticDailyLogs, savingsActivity, savingsMappings, frankencoinMinters, eRC20Balances, eRC20TotalSupplys, leadrateRateChangeds, frankencoinProfitLosss, equityTradeCharts.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "GraphQL query string (e.g. `{ mintingHubV2PositionV2s(limit:5) { items { position owner minted } } }`).",
        },
      },
      required: ["query"],
    },
  },

  // ─── 14. Subscribe Events ─────────────────────────────────────────────────
  {
    name: "subscribe_events",
    description:
      "Subscribe to Frankencoin protocol events via webhook. Events are delivered as HTTP POST to your URL with HMAC-SHA256 signing. Supported events: mint, burn, large_transfer, challenge_start, challenge_bid, challenge_end, depeg, depeg_resolved, fps_large_trade, minter_proposed, minter_approved, rate_change, supply_change.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "HTTPS URL to receive webhook payloads." },
        secret: { type: "string", description: "HMAC secret for payload signing (min 32 chars). Store securely — not returned in responses." },
        events: { type: "string", description: "Comma-separated event types to subscribe to. Use '*' for all." },
        min_amount: { type: "number", description: "Minimum ZCHF amount filter (for amount-based events like mint, burn, fps_large_trade, supply_change)." },
        chain_id: { type: "number", description: "Filter events to a specific chain (1=Ethereum, 8453=Base, 42161=Arbitrum, etc.)." },
        address: { type: "string", description: "Filter by position/owner/trader address." },
      },
      required: ["url", "secret", "events"],
    },
  },

  // ─── 15. Unsubscribe Events ───────────────────────────────────────────────
  {
    name: "unsubscribe_events",
    description: "Remove a webhook subscription by ID.",
    inputSchema: {
      type: "object",
      properties: {
        subscription_id: { type: "string", description: "Subscription ID (e.g. sub_a1b2c3d4e5f6)." },
      },
      required: ["subscription_id"],
    },
  },

  // ─── 16. List Subscriptions ───────────────────────────────────────────────
  {
    name: "list_subscriptions",
    description: "List all active webhook subscriptions. Optionally filter by URL.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Filter subscriptions by URL (exact match)." },
      },
      required: [],
    },
  },

  // ─── 17. Get Webhook Status ───────────────────────────────────────────────
  {
    name: "get_webhook_status",
    description: "Health status of the webhook/event system: poller state, subscription counts, delivery stats, error counters.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
];
