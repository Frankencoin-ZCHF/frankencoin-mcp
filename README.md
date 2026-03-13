# Frankencoin MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that exposes real-time Frankencoin (ZCHF) protocol data to AI assistants and developer tools.

Connect Claude, Cursor, or any MCP-compatible client to live protocol data — supply, positions, savings rates, FPS analytics, challenges, on-chain history, docs, merch, and more.

**Public endpoint:** `https://mcp.frankencoin.com`

---

## Tools

### 📊 Protocol Data

| Tool | Description |
|------|-------------|
| `get_protocol_summary` | Full protocol snapshot — supply, TVL, FPS, savings rate, active challenges. Best starting point. |
| `get_protocol_info` | ZCHF supply per chain (Ethereum, Base, Gnosis, Arbitrum, Optimism, Polygon, Avalanche, Sonic), TVL in CHF/USD, FPS price and market cap |
| `get_fps_info` | FPS governance token — price, supply, market cap, equity reserve, minter reserve, cumulative earnings |
| `get_prices` | Live prices (CHF + USD) for ZCHF, FPS, and all accepted collateral tokens |
| `get_savings_rates` | Approved savings/lead rates and pending proposals per chain |
| `get_savings_stats` | Savings module stats — deposits, withdrawals, interest paid, per module per chain |
| `get_collaterals` | All accepted collateral types (WETH, WBTC, LsETH, cbBTC, wstETH, etc.) with addresses |
| `get_challenges` | Liquidation challenges — status, size, bids, timing |
| `get_positions` | Open minting position addresses |
| `get_positions_detail` | Full position data — collateral, minted amount, capacity, liquidation price, risk premium, cooldown |
| `get_equity_trades` | Recent FPS buy/sell trades — buyer, seller, price, volume |
| `get_minters` | Approved minter contracts with application dates and fees |

### 📈 Analytics & History

| Tool | Description |
|------|-------------|
| `get_analytics` | Daily historical data — supply, equity reserve, savings, FPS price, earnings per share (up to 365 days) |
| `get_historical` | Full time-series from October 2023 — supply, equity, savings TVL, interest rates, rate change governance history |
| `get_market_context` | Live CoinGecko data — ZCHF peg health vs CHF spot, FPS 24h change, BTC/ETH/wstETH/WBTC macro context |
| `get_dune_stats` | On-chain analytics from Dune — ZCHF and FPS holder counts, minting volume, savings TVL over time |

### 📚 Docs & Discovery

| Tool | Description |
|------|-------------|
| `get_docs` | Official documentation fetched live from the Frankencoin gitbook — always up to date. Sections: `overview`, `savings`, `pool_shares`, `governance`, `reserve`, `risks`, `faq`, `minting`, `opening_positions`, `auctions`, `api` |
| `get_token_addresses` | Official contract addresses for ZCHF, FPS, and svZCHF across all chains, with block explorer links |
| `get_links` | All key links — app sections, website, docs, whitepaper, GitHub, Telegram, Twitter, exchanges, on-ramps |
| `get_media_and_use_cases` | Press coverage, videos, real-world integrations, and ecosystem partners |
| `get_merch` | Products from the Frankencoin merch store — titles, prices, sizes, availability, and direct product URLs |

### 🔧 Advanced

| Tool | Description |
|------|-------------|
| `query_ponder` | Raw GraphQL against `ponder.frankencoin.com` for custom queries across all on-chain entities |

---

## Quickstart

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

- *"Give me a full protocol snapshot"*
- *"What's the ZCHF peg health right now?"*
- *"Show me all active collateral positions with their liquidation prices"*
- *"Are there any active liquidation challenges?"*
- *"Explain how Frankencoin savings work"* (fetches live docs)
- *"What's in the merch store?"*
- *"What's the FPS price and equity reserve today?"*

### Cursor / VS Code

In `.cursor/mcp.json` or workspace MCP config:

```json
{
  "mcpServers": {
    "frankencoin": {
      "url": "https://mcp.frankencoin.com/mcp"
    }
  }
}
```

### Local / stdio (CLI use)

```bash
git clone https://github.com/Frankencoin-ZCHF/frankencoin-mcp
cd frankencoin-mcp
npm install
node src/index.js   # stdio mode
```

For stdio in Claude Desktop config:

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

## Running the HTTP Server

```bash
npm install
node src/index.js --http          # port 3000
PORT=8080 node src/index.js --http
```

### Endpoints

| Endpoint | Transport | Use |
|----------|-----------|-----|
| `POST /mcp` | Streamable HTTP | All modern MCP clients (recommended) |
| `GET /sse` | SSE | Legacy clients (Claude Desktop pre-Nov 2024) |
| `GET /health` | JSON | Health check + full tool listing |

### Deployment (systemd)

```ini
# /etc/systemd/system/frankencoin-mcp.service
[Unit]
Description=Frankencoin MCP Server
After=network.target

[Service]
ExecStart=/usr/bin/node /opt/frankencoin-mcp/src/index.js --http
WorkingDirectory=/opt/frankencoin-mcp
Restart=always
RestartSec=5
Environment=PORT=3000
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now frankencoin-mcp
```

### nginx reverse proxy

```nginx
server {
    listen 443 ssl;
    server_name mcp.frankencoin.com;

    ssl_certificate     /etc/letsencrypt/live/mcp.frankencoin.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mcp.frankencoin.com/privkey.pem;

    location / {
        proxy_pass         http://localhost:3000;
        proxy_http_version 1.1;

        # Required for SSE
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
| CoinGecko Pro | `pro-api.coingecko.com` | Peg health, market context, collateral prices |
| Dune Analytics | `api.dune.com` | Holder counts, minting volume, savings TVL time-series |
| Frankencoin website repo | GitHub | Token addresses, links, docs, media, merch |

No authentication required from clients. All data is public and read-only.

---

## Advanced: Raw GraphQL

The `query_ponder` tool exposes the full Ponder indexer. Available entities:

```
mintingHubV2PositionV2s   mintingHubV1PositionV1s
mintingHubV2ChallengeV2s  mintingHubV1ChallengeV1s
equityTrades              equityTradeCharts
analyticDailyLogs         frankencoinProfitLosss
savingsActivity           savingsMappings
frankencoinMinters        eRC20Balances
eRC20TotalSupplys         leadrateRateChangeds
```

Example — ask Claude:
> *"Using query_ponder, show me the 5 largest active ZCHF positions by minted amount"*

---

## Protocol Overview

**Frankencoin (ZCHF)** is a collateral-backed Swiss franc stablecoin governed by its reserve holders. Key mechanics:

- **Collateral positions** — users lock collateral (WETH, WBTC, LsETH, cbBTC, wstETH, etc.) to mint ZCHF
- **FPS (Frankencoin Pool Share)** — governance token; holders share protocol earnings and control the reserve
- **Savings modules** — earn yield on ZCHF deposits at the current lead rate (~3.75% APY)
- **Challenges** — any holder can challenge undercollateralised positions via Dutch auction
- **Multichain** — deployed on Ethereum, Base, Gnosis, Arbitrum, Optimism, Polygon, Avalanche, Sonic

Learn more: [frankencoin.com](https://frankencoin.com) · [Whitepaper](https://app.frankencoin.com/thesis-frankencoin.pdf) · [Docs](https://docs.frankencoin.com)

---

## License

GPL-3.0 — Frankencoin Association
