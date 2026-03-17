/**
 * MCP tool definitions for the Frankencoin MCP server — 13 consolidated tools.
 */

export const TOOLS = [
  {
    name: "get_protocol_snapshot",
    description:
      "Full live protocol state in one call: ZCHF supply by chain, TVL, FPS price/supply/market cap/reserve, savings rate, active challenge count, peg deviation. Best starting point for any protocol question.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_market_data",
    description:
      "All price and market data: ecosystem token prices (ZCHF, FPS, all collateral), ZCHF peg health, FPS price, macro context (BTC/ETH), and CHF stablecoin comparison (ZCHF vs VCHF vs CHFAU). Use for price checks, peg monitoring, or competitive analysis.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_savings",
    description:
      "Current savings rates across all chains and modules, pending rate proposals, TVL per module, and total interest paid. Use for anything about ZCHF savings, yields, or deposit stats.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_governance",
    description:
      "Full governance lifecycle: minter contract proposals (pending/approved/denied), lead rate change proposals and history, and recent FPS buy/sell trades. Use for governance monitoring, proposal tracking, or FPS trading activity.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          description: "What to return: 'minters' (minter proposals), 'rates' (rate proposals + history), 'trades' (FPS buy/sell), or 'all' (default: all)",
        },
        status: {
          type: "string",
          description: "Filter by status: 'pending', 'past', or 'all' (default: all). Applies to minters and rates.",
        },
        limit: {
          type: "number",
          description: "Maximum items per category (default: 20, max: 100)",
        },
      },
      required: [],
    },
  },
  {
    name: "get_positions",
    description:
      "Collateral positions for ZCHF minting. Returns position addresses by default; set detail=true for full on-chain data including collateral balance, minted amount, liquidation price, risk premium, and expiry.",
    inputSchema: {
      type: "object",
      properties: {
        detail: {
          type: "boolean",
          description: "If true, return full position data (collateral, amounts, pricing). Default: false (addresses only).",
        },
        limit: {
          type: "number",
          description: "Maximum number of positions to return (default: 50 for addresses, 20 for detail, max: 100)",
        },
        active_only: {
          type: "boolean",
          description: "If true, exclude closed and denied positions (default: true when detail=true)",
        },
        collateral: {
          type: "string",
          description: "Filter by collateral token address (optional)",
        },
      },
      required: [],
    },
  },
  {
    name: "get_challenges",
    description:
      "Liquidation challenges against collateral positions — status, size, bids, timing, collateral details. Use for monitoring liquidation activity.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of challenges to return (default: 20, max: 100)",
        },
        active_only: {
          type: "boolean",
          description: "If true, return only active/open challenges (default: false)",
        },
      },
      required: [],
    },
  },
  {
    name: "get_collaterals",
    description:
      "All accepted collateral types — token names, symbols, addresses, and which chain they're on.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_analytics",
    description:
      "Historical protocol analytics. Summary mode (default): daily snapshots of supply, equity, savings, FPS price, earnings, rates. Full mode: adds rate change history, flow data, and V1/V2 breakdowns.",
    inputSchema: {
      type: "object",
      properties: {
        days: {
          type: "number",
          description: "Number of days of history (default: 30, max: 365)",
        },
        type: {
          type: "string",
          description: "'summary' (daily snapshots only, default) or 'full' (includes rate history and detailed breakdowns)",
        },
      },
      required: [],
    },
  },
  {
    name: "get_knowledge",
    description:
      "Explanatory content about Frankencoin — documentation, FAQs, compliance info, guides, contract addresses, and links. Choose a topic to get the relevant content.",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "Topic to fetch: overview, what_is, faq, how_it_works, savings_guide, governance_guide, compliance, risks, reserve, auctions, token_addresses, links, api_reference. Default: overview",
        },
      },
      required: [],
    },
  },
  {
    name: "get_news",
    description:
      "Press coverage (articles and videos), real-world use cases, and ecosystem partners. Use for media mentions, partnership info, or marketing content.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_merch",
    description:
      "Frankencoin merchandise — products, prices, variants (sizes/colors), availability, and images from the official store.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_dune_stats",
    description:
      "On-chain analytics — ZCHF holder count, FPS holder count, historical minting volume, and savings TVL over time. Data may be slightly delayed.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "query_ponder",
    description:
      "Execute a raw GraphQL query against the on-chain indexer. For advanced queries not covered by other tools. Available entities: positions (V1/V2), challenges (V1/V2), equityTrades, analyticDailyLogs, savingsActivity, savingsMappings, frankencoinMinters, eRC20Balances, eRC20TotalSupplys, leadrateRateChangeds, frankencoinProfitLosss, equityTradeCharts.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "GraphQL query string",
        },
      },
      required: ["query"],
    },
  },
];
