# Frankencoin MCP Server

Real-time Frankencoin (ZCHF) protocol data via three interfaces — pick whatever fits your stack:

| Interface | Endpoint | Best for |
|-----------|----------|----------|
| **MCP** | `POST https://mcp.frankencoin.com/mcp` | Claude Desktop, Cursor, any MCP-compatible agent |
| **REST API** | `GET https://mcp.frankencoin.com/api/<tool>` | Agents, scripts, curl — single request, no handshake |
| **CLI** | `frankencoin <command>` | Humans at the terminal |

**Public endpoint:** `https://mcp.frankencoin.com`

---

## Tools (v2.0 — 13 consolidated tools)

Organised by **what the agent needs**, not where data comes from. One tool per responsibility.

| # | Tool | Description |
|---|------|-------------|
| 1 | `get_protocol_snapshot` | Full live state — supply (per chain), TVL, FPS price/reserve/earnings, savings rate, challenges |
| 2 | `get_market_data` | Prices, peg health, CHF stablecoin comparison (ZCHF/VCHF/CHFAU), macro (BTC/ETH), collateral prices |
| 3 | `get_savings` | Rates (approved + pending) + module stats (TVL, interest paid, deposits, withdrawals) |
| 4 | `get_governance` | Rate proposals, minter applications, FPS equity trades, holder stats. `type` param to filter |
| 5 | `get_positions` | Minting positions. `detail=true` for full on-chain data; default returns address list |
| 6 | `get_challenges` | Liquidation challenges with collateral details, pricing, position context |
| 7 | `get_collaterals` | Accepted collateral types across all chains |
| 8 | `get_analytics` | Historical time-series, FPS trades, minter history, rate change timeline. `type` param |
| 9 | `get_knowledge` | All docs and reference: FAQ, guides, token addresses, links. `topic` param |
| 10 | `get_news` | Press articles, videos, use cases, ecosystem partners |
| 11 | `get_merch` | Merch store products, prices, availability |
| 12 | `get_dune_stats` | Dune Analytics — holder counts, minting volume, savings TVL over time |
| 13 | `query_ponder` | Raw GraphQL escape hatch against ponder.frankencoin.com |

### Design Philosophy

- **Single responsibility per tool** — organised by what the tool returns, not where data comes from
- **Agent-centric** — the agent asks "what do I need?", the server aggregates internally
- **Consolidated from 23→13** — fewer tool calls, richer responses, less context wasted

---

## Data Sources

All data aggregated server-side — the agent doesn't need to know about underlying APIs:

| Source | What it provides |
|--------|-----------------|
| [api.frankencoin.com](https://api.frankencoin.com) | Supply, TVL, FPS, savings rates, collaterals, challenges, prices |
| [ponder.frankencoin.com](https://ponder.frankencoin.com) | On-chain indexed data — positions, trades, minters, analytics |
| [CoinGecko Pro](https://coingecko.com) | Market prices, 24h changes, peg health, CHF stablecoin comparison |
| [Dune Analytics](https://dune.com/frankencoin) | Holder counts, minting volume, savings TVL history |
| [GitHub repos](https://github.com/Frankencoin-ZCHF) | Documentation (gitbook), website content (links, media, token addresses) |
| [merch.frankencoin.com](https://merch.frankencoin.com) | Merch store products via Shopify API |

---

## Quick Start

### MCP (Claude Desktop / Cursor)

Add to your MCP config:

```json
{
  "mcpServers": {
    "frankencoin": {
      "url": "https://mcp.frankencoin.com/mcp"
    }
  }
}
```

### REST API (curl / scripts)

```bash
# Full protocol snapshot
curl https://mcp.frankencoin.com/api/get_protocol_snapshot

# Market data with peg health
curl https://mcp.frankencoin.com/api/get_market_data

# Savings rates + stats
curl https://mcp.frankencoin.com/api/get_savings

# Governance activity (minters only)
curl "https://mcp.frankencoin.com/api/get_governance?type=minters&status=active"

# Positions with full detail
curl "https://mcp.frankencoin.com/api/get_positions?detail=true&limit=10"

# Historical analytics (30 days)
curl "https://mcp.frankencoin.com/api/get_analytics?type=time_series&days=30"

# Documentation
curl "https://mcp.frankencoin.com/api/get_knowledge?topic=faq"

# Raw GraphQL
curl -X POST https://mcp.frankencoin.com/api/query_ponder \
  -H 'Content-Type: application/json' \
  -d '{"query": "{ analyticDailyLogs(limit:3) { items { date totalSupply } } }"}'
```

### CLI

```bash
npx frankencoin-mcp snapshot
npx frankencoin-mcp market
npx frankencoin-mcp savings
npx frankencoin-mcp positions --detail --limit 10
npx frankencoin-mcp analytics --type trades --limit 5
npx frankencoin-mcp knowledge --topic governance
npx frankencoin-mcp ponder '{ equityTrades(limit:3) { items { kind trader shares } } }'
```

---

## Self-Hosting

```bash
# Clone and install
git clone https://github.com/Frankencoin-ZCHF/frankencoin-mcp.git
cd frankencoin-mcp
npm install

# Run in HTTP mode (port 3000)
node src/index.js --http

# Or stdio mode (for MCP clients)
node src/index.js
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | HTTP port (default: 3000) |
| `COINGECKO_API_KEY` | Yes* | CoinGecko Pro API key (for market data) |
| `DUNE_API_KEY` | No | Dune Analytics API key (for get_dune_stats) |

*Or place at `~/.config/coingecko/api_key`

---

## Architecture

```
src/
├── index.js          # Server entry — MCP + REST + SSE transports
├── tools.js          # 13 tool definitions (names, descriptions, schemas)
├── api.js            # Barrel re-export of all handlers
├── cli.js            # CLI interface
└── api/
    ├── helpers.js    # Shared: fetch helpers, constants, key loading
    ├── snapshot.js   # get_protocol_snapshot
    ├── market.js     # get_market_data
    ├── savings.js    # get_savings
    ├── governance.js # get_governance
    ├── positions.js  # get_positions, get_challenges, get_collaterals
    ├── analytics.js  # get_analytics, get_dune_stats, query_ponder
    └── content.js    # get_knowledge, get_news, get_merch
```

---

## Example Prompts

> "What's the current state of the Frankencoin protocol?"
→ `get_protocol_snapshot`

> "How is the ZCHF peg? Compare with other CHF stablecoins."
→ `get_market_data`

> "What's the savings rate and how much is deposited?"
→ `get_savings`

> "Show me recent FPS trades and any pending governance proposals."
→ `get_governance`

> "List all active positions with their collateral ratios."
→ `get_positions` with `detail=true`

> "What are the risks of using Frankencoin?"
→ `get_knowledge` with `topic=risks`

> "Show me 90 days of protocol analytics."
→ `get_analytics` with `type=time_series&days=90`

---

## License

MIT — [Frankencoin Association](https://frankencoin.com)
