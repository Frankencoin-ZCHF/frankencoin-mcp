# Frankencoin MCP Server

Real-time Frankencoin (ZCHF) protocol data via three interfaces — pick whatever fits your stack:

| Interface | Endpoint | Best for |
|-----------|----------|----------|
| **MCP** | `POST https://mcp.frankencoin.com/mcp` | Claude Desktop, Cursor, any MCP-compatible agent |
| **REST API** | `GET https://mcp.frankencoin.com/tools/<tool>` | Agents, scripts, curl — single request, no handshake |
| **CLI** | `frankencoin <command>` | Humans at the terminal |

**Public endpoint:** `https://mcp.frankencoin.com`

---

## Tools

| Tool | Description |
|------|-------------|
| `get_protocol_summary` | Full protocol snapshot — supply, TVL, FPS, savings rate, active challenges |
| `get_protocol_info` | ZCHF supply per chain, TVL in CHF/USD, FPS price and market cap |
| `get_fps_info` | FPS token — price, supply, market cap, equity reserve, earnings |
| `get_prices` | Live prices (CHF + USD) for ZCHF, FPS, and all collateral tokens |
| `get_savings_rates` | Approved savings/lead rates and pending proposals per chain |
| `get_savings_stats` | Savings module stats — deposits, withdrawals, interest paid |
| `get_collaterals` | All accepted collateral types (WETH, WBTC, LsETH, etc.) |
| `get_challenges` | Liquidation challenges — status, size, bids, timing |
| `get_positions` | Open minting position addresses |
| `get_positions_detail` | Full position data — collateral, minted amount, capacity, liquidation price, risk premium |
| `get_analytics` | Daily historical data — supply, equity, savings, FPS price, earnings (up to 365 days) |
| `get_equity_trades` | Recent FPS buy/sell trades |
| `get_minters` | Approved minter contracts |
| `get_historical` | Historical time-series snapshots (up to 365 days) |
| `get_market_context` | Live CoinGecko data — ZCHF peg health, FPS 24h, BTC/ETH macro |
| `get_dune_stats` | On-chain analytics — holder counts, minting volume |
| `get_token_addresses` | Official contract addresses across all chains |
| `get_links` | All key links — app, docs, socials, exchanges |
| `get_docs` | Official documentation sections (overview, savings, governance, etc.) |
| `get_merch` | Merch store products, prices, availability |
| `get_media_and_use_cases` | Media coverage, use cases, ecosystem partners |
| `query_ponder` | Raw GraphQL against `ponder.frankencoin.com` for advanced queries |

---

## REST API — no handshake, agent-friendly

The `/tools` layer lets any agent or script call tools with a single HTTP request — no MCP session, no protocol overhead.

```bash
# Protocol snapshot
curl https://mcp.frankencoin.com/tools/get_protocol_summary

# Prices
curl https://mcp.frankencoin.com/tools/get_prices

# Positions with params
curl "https://mcp.frankencoin.com/tools/get_positions_detail?limit=10&active_only=true"

# Active challenges only
curl "https://mcp.frankencoin.com/tools/get_challenges?active_only=true"

# Historical data (30 days)
curl "https://mcp.frankencoin.com/tools/get_historical?days=30"

# Documentation section
curl "https://mcp.frankencoin.com/tools/get_docs?section=savings"

# Raw GraphQL (POST)
curl -X POST https://mcp.frankencoin.com/tools/query_ponder \
  -H "Content-Type: application/json" \
  -d '{"query":"{ analyticDailyLogs(limit:3, orderBy:\"timestamp\", orderDirection:\"desc\") { items { date totalSupply fpsPrice } } }"}'

# List all tools with descriptions and params
curl https://mcp.frankencoin.com/tools
```

**Response format:**
```json
{
  "ok": true,
  "tool": "get_protocol_summary",
  "result": { ... }
}
```

Errors return `{ "ok": false, "tool": "...", "error": "..." }` with an appropriate HTTP status.

---

## MCP — AI agents & desktop clients

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "frankencoin": {
      "url": "https://mcp.frankencoin.com/mcp"
    }
  }
}
```

Restart Claude Desktop. You can now ask:
- *"What is the current ZCHF total supply?"*
- *"Show me all active collateral positions"*
- *"What's the FPS price and reserve today?"*
- *"Are there any active liquidation challenges?"*

### Cursor / VS Code

```json
{
  "mcpServers": {
    "frankencoin": {
      "url": "https://mcp.frankencoin.com/mcp"
    }
  }
}
```

### Local stdio (for Claude Desktop without HTTP)

```bash
git clone https://github.com/Frankencoin-ZCHF/frankencoin-mcp
cd frankencoin-mcp
npm install
node src/index.js   # stdio mode
```

```json
{
  "mcpServers": {
    "frankencoin": {
      "command": "node",
      "args": ["/path/to/frankencoin-mcp/src/index.js"]
    }
  }
}
```

---

## CLI — humans at the terminal

```bash
git clone https://github.com/Frankencoin-ZCHF/frankencoin-mcp
cd frankencoin-mcp
npm install
npm link   # or: node src/cli.js <command>
```

```
frankencoin summary                        # full protocol snapshot
frankencoin prices                         # token prices
frankencoin fps                            # FPS token details
frankencoin positions-detail --limit 10    # open positions with collateral data
frankencoin challenges --active            # active liquidation challenges
frankencoin historical --days 30           # 30-day time series
frankencoin analytics --days 7             # daily analytics
frankencoin trades --limit 10              # recent FPS trades
frankencoin rates                          # savings/lead rates by chain
frankencoin savings                        # savings module stats
frankencoin market                         # peg health + macro context
frankencoin dune                           # holder counts, volumes
frankencoin addresses                      # contract addresses by chain
frankencoin docs --section savings         # documentation
frankencoin merch                          # merch store
frankencoin ponder '{ analyticDailyLogs(limit:3) { items { date totalSupply } } }'

# All commands support --json for raw JSON output
frankencoin summary --json | jq .zchf.totalSupply
```

```
frankencoin --help
frankencoin <command> --help
```

---

## Running the server yourself

```bash
npm install
node src/index.js --http          # port 3000
PORT=8080 node src/index.js --http
```

### Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /mcp` | MCP Streamable HTTP (recommended) |
| `GET /tools/<tool>` | REST API — plain JSON, no handshake |
| `POST /tools/<tool>` | REST API with JSON body params |
| `GET /tools` | Tool index — all tools with descriptions and param schemas |
| `GET /sse` | Legacy SSE transport (older clients) |
| `GET /health` | Health check + tool listing |

### Deployment (systemd)

```ini
[Unit]
Description=Frankencoin MCP Server
After=network.target

[Service]
ExecStart=/usr/bin/node /opt/frankencoin-mcp/src/index.js --http
WorkingDirectory=/opt/frankencoin-mcp
Restart=always
RestartSec=5
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
```

### nginx

```nginx
server {
    listen 443 ssl;
    server_name mcp.frankencoin.com;

    location / {
        proxy_pass         http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header   Connection '';
        proxy_buffering    off;
        proxy_cache        off;
        chunked_transfer_encoding on;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_read_timeout 3600s;
    }
}
```

---

## Data Sources

| Source | URL | Data |
|--------|-----|------|
| Frankencoin REST API | `api.frankencoin.com` | Supply, TVL, FPS, prices, savings, collaterals |
| Ponder GraphQL indexer | `ponder.frankencoin.com` | Positions, challenges, trades, analytics, minters |
| CoinGecko Pro | `pro-api.coingecko.com` | Market prices, peg health |
| Dune Analytics | `api.dune.com` | Holder counts, minting volume |

No authentication required for clients. All data is public and read-only.

---

## Advanced: Raw GraphQL

The `query_ponder` tool exposes the full Ponder indexer:

```
mintingHubV2PositionV2s   mintingHubV1PositionV1s
mintingHubV2ChallengeV2s  mintingHubV1ChallengeV1s
equityTrades              equityTradeCharts
analyticDailyLogs         frankencoinProfitLosss
savingsActivity           savingsMappings
frankencoinMinters        eRC20Balances
eRC20TotalSupplys         leadrateRateChangeds
```

Via REST:
```bash
curl -X POST https://mcp.frankencoin.com/tools/query_ponder \
  -H "Content-Type: application/json" \
  -d '{"query":"{ mintingHubV2PositionV2s(limit:5) { items { position owner minted } } }"}'
```

Via MCP — ask Claude:
> *"Using query_ponder, show me the 5 largest active ZCHF positions by minted amount"*

---

## Protocol Overview

**Frankencoin (ZCHF)** is a collateral-backed Swiss franc stablecoin governed by its reserve holders.

- **Collateral positions** — lock WETH, WBTC, LsETH etc. to mint ZCHF
- **FPS** — governance token; holders share earnings and control the reserve
- **Savings** — earn yield on ZCHF at the current lead rate (~3.75% APY)
- **Challenges** — any holder can challenge undercollateralised positions
- **Multichain** — Ethereum, Base, Gnosis, Arbitrum, Optimism, Polygon, Avalanche, Sonic

[frankencoin.com](https://frankencoin.com) · [Whitepaper](https://app.frankencoin.com/thesis-frankencoin.pdf)

---

## License

MIT — Frankencoin Association
