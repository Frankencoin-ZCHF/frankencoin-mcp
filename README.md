# Frankencoin MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that exposes real-time Frankencoin (ZCHF) protocol data to AI assistants and developer tools.

Connect Claude, Cursor, or any MCP-compatible client to live protocol data — supply, positions, savings rates, FPS analytics, challenges, and on-chain history.

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
| `query_ponder` | Raw GraphQL against `ponder.frankencoin.com` for advanced queries |

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
- *"What is the current ZCHF total supply?"*
- *"Show me all active collateral positions"*
- *"What's the FPS price and reserve today?"*
- *"Are there any active liquidation challenges?"*

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
| `GET /health` | JSON | Health check, tool listing |

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

### nginx reverse proxy (mcp.frankencoin.com)

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

No authentication required. All data is public and read-only.

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

- **Collateral positions** — users lock collateral (WETH, WBTC, LsETH, etc.) to mint ZCHF
- **FPS (Frankencoin Pool Share)** — governance token; holders share protocol earnings and control the reserve
- **Savings modules** — earn yield on ZCHF deposits at the current lead rate (~3.75% APY)
- **Challenges** — any holder can challenge undercollateralised positions via auction
- **Multichain** — deployed on Ethereum, Base, Gnosis, Arbitrum, Optimism, Polygon, Avalanche, Sonic

Learn more: [frankencoin.com](https://frankencoin.com) · [Whitepaper](https://app.frankencoin.com/thesis-frankencoin.pdf)

---

## License

MIT — Frankencoin Association
