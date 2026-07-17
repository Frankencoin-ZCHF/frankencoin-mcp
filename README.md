# Frankencoin MCP Server

Real-time [Frankencoin](https://frankencoin.com) (ZCHF) protocol data for AI agents and developers. One read-only server, several ways to reach it — supply, prices, peg health, savings, minting positions, liquidation challenges, governance, insurance products, and historical analytics across every supported chain.

**Public endpoint:** `https://mcp.frankencoin.com`

| Interface | Endpoint | Best for |
|-----------|----------|----------|
| **MCP** (Streamable HTTP) | `POST /mcp` | Claude Desktop, Cursor, any MCP client / AI agent |
| **REST** | `GET /api/<tool>` | Scripts, curl, agents — one request, no handshake |
| **CLI** | `frankencoin <command>` | Humans at the terminal |
| **llms.txt** | `GET /llms.txt` | A compact, self-describing guide for LLMs/agents |
| **Legacy SSE** | `GET /sse` | Older MCP clients |

No authentication. No API key required. Read-only.

---

## Quick start

### MCP (Claude Desktop / Cursor)

```json
{
  "mcpServers": {
    "frankencoin": {
      "url": "https://mcp.frankencoin.com/mcp"
    }
  }
}
```

Then ask your assistant things like *"What's the current state of the Frankencoin protocol?"* or *"How healthy is the ZCHF peg versus other CHF stablecoins?"*.

### REST (curl / scripts)

```bash
# Full protocol snapshot — the best starting point
curl https://mcp.frankencoin.com/api/get_protocol_snapshot

# Market data + peg health
curl https://mcp.frankencoin.com/api/get_market_data

# Governance: pending minter applications
curl "https://mcp.frankencoin.com/api/get_governance?type=minters&status=pending"

# Positions with full on-chain detail
curl "https://mcp.frankencoin.com/api/get_positions?detail=true&limit=10"

# 30 days of protocol analytics
curl "https://mcp.frankencoin.com/api/get_analytics?type=time_series&days=30"

# Raw read-only GraphQL against the on-chain indexer
curl -X POST https://mcp.frankencoin.com/api/query_ponder \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ analyticDailyLogs(limit:3){ items { date totalSupply } } }"}'
```

Every REST response is a JSON envelope: `{ "ok": true, "tool": "<name>", "result": { … } }`.

### CLI

```bash
npx frankencoin-mcp snapshot
npx frankencoin-mcp market
npx frankencoin-mcp positions --detail --limit 10
npx frankencoin-mcp analytics --type trades --limit 5
npx frankencoin-mcp knowledge --topic governance
npx frankencoin-mcp ponder '{ equityTrades(limit:3){ items { kind trader shares } } }'
```

### Discover everything

`GET /health` and `GET /api` are self-describing manifests, and [`GET /llms.txt`](https://mcp.frankencoin.com/llms.txt) is a compact, always-current guide generated from the live tool registry.

---

## Tools

Organised by **what the agent needs**, not where the data comes from — one tool per responsibility, each aggregating from multiple sources internally.

| Tool | Description |
|------|-------------|
| `get_protocol_snapshot` | Full live state — supply (per chain), TVL, FPS price/reserve/earnings, savings rate, active challenges |
| `get_market_data` | Prices, peg health, CHF-stablecoin comparison (ZCHF/VCHF/CHFAU), macro (BTC/ETH), collateral prices |
| `get_savings` | Approved + pending rates, plus per-module stats (TVL, interest paid, deposits, withdrawals) |
| `get_governance` | Rate proposals, minter applications, FPS equity trades, holder stats (`type` filter) |
| `get_positions` | Minting positions; `detail=true` for full on-chain data, else a lightweight address list |
| `get_challenges` | Liquidation challenges with collateral details, pricing, and position context |
| `get_collaterals` | Accepted collateral types across all chains |
| `get_analytics` | Historical time-series, FPS trades, minter history, rate-change timeline (`type` selector) |
| `get_knowledge` | Docs & reference: FAQ, guides, token addresses, links (`topic` selector) |
| `get_compliance` | Legal & regulatory posture — Swiss FINMA + EU MiCA classifications, legal opinions, MiCA white paper, ESMA register, security audits, bug bounty |
| `get_news` | Press articles, videos, use cases, ecosystem partners |
| `get_insurance_products` | ZCHF-related third-party insurance products such as OpenCover ZCHF depeg cover |
| `get_merch` | Merch store products, prices, availability |
| `get_risk` | Independent third-party risk ratings — Pharos stablecoin-safety report card + Xerberus composite scores (`source` selector) |
| `get_dune_stats` | Dune Analytics — holder counts, minting volume, savings TVL over time |
| `query_ponder` | Raw **read-only** GraphQL escape hatch against `ponder.frankencoin.com` |

Parameter details live in each tool's MCP `inputSchema` (via `tools/list`) and in `GET /api`.

---

## Data sources

All aggregated server-side — callers never talk to these directly:

| Source | Provides | Key |
|--------|----------|-----|
| [api.frankencoin.com](https://api.frankencoin.com) | Supply, TVL, FPS, savings rates, collaterals, challenges, prices | — |
| [ponder.frankencoin.com](https://ponder.frankencoin.com) | On-chain indexed data — positions, trades, minters, analytics | — |
| [CoinGecko](https://coingecko.com) | Market prices, 24h changes, CHF-stablecoin comparison | optional |
| [Dune Analytics](https://dune.com/frankencoin) | Holder counts, minting volume, savings TVL history | optional |
| [Pharos](https://pharos.watch) | Stablecoin-safety report card for ZCHF (`get_risk`) | optional |
| [Xerberus](https://xerberus.io) | Composite on-chain risk scores (`get_risk`) | optional |
| [GitHub repos](https://github.com/Frankencoin-ZCHF) | Documentation and website content (links, media, token addresses) | — |
| [merch.frankencoin.com](https://merch.frankencoin.com) | Merch products (Shopify) | — |
| Ethereum RPC | CHFAU on-chain supply | — |

When an optional key is absent, the affected tool (`get_market_data`, `get_dune_stats`, `get_risk`) returns **partial data plus a `note`** rather than failing.

---

## Self-hosting

No build step. Node ≥ 20, that's it.

```bash
git clone https://github.com/Frankencoin-ZCHF/frankencoin-mcp.git
cd frankencoin-mcp
npm install

node src/index.js --http     # HTTP mode (default port 3000)
node src/index.js            # stdio mode (for local MCP clients)
npm test                     # run the test suite
```

Health check: `curl http://localhost:3000/health`

### Environment variables

**Nothing is required to boot.** Every variable is optional; missing secrets only degrade the tools that depend on them.

| Variable | Default | Effect |
|----------|---------|--------|
| `PORT` | `3000` | HTTP port |
| `COINGECKO_API_KEY` | — | Enables full market/macro data (else those fields degrade) |
| `DUNE_API_KEY` | — | Enables `get_dune_stats` (else it returns a soft note) |
| `PHAROS_API_KEY` | — | Enables the Pharos section of `get_risk` (else it returns a soft note) |
| `XERBERUS_API_KEY` | — | Enables the Xerberus section of `get_risk` (else it returns a soft note) |
| `XERBERUS_USER_EMAIL` | — | Sent with `XERBERUS_API_KEY` (Xerberus requires an identifying email header) |
| `PUBLIC_URL` | `https://mcp.frankencoin.com` | Canonical origin used in `/llms.txt` and `/api` |
| `RATE_LIMIT_MAX` | `120` | Requests per IP per minute |
| `TRUST_PROXY_HOPS` | `1` | Trusted proxy hops for client-IP derivation |

See [`src/config.js`](src/config.js) for the full list (cache, timeouts, session and query_ponder limits).

---

## Architecture

Node.js ESM, no build step, no database — stateless between restarts and safe to restart anytime. Strictly layered, with **one** place that performs network I/O:

```
src/
  index.js            entrypoint — stdio vs --http, signals
  config.js           env read once, frozen; nothing required to boot
  cli.js              terminal client
  cache.js            in-memory TTL cache: single-flight + LRU bound
  lib/                pure utilities (number encoding, envelopes, errors, concurrency)
  upstream/           the ONLY layer that calls fetch() — one client per source
  services/           per-domain logic: compose upstreams, transform, shape output
  tools/              registry (zod-validated tool defs) + one dispatch path
  server/             http router, MCP registration, sessions, rate limiting, llms.txt
test/                 node:test suites (offline / hermetic)
```

**Why it's fast:** caching sits at the upstream boundary, so a single `/prices/list` fetch is shared across every tool that needs it, and concurrent identical fetches are coalesced (single-flight). Warm responses are ~1–2 ms.

### Adding a tool

1. Add the definition (name, description, zod `input`, `params`, `handler`) to `src/tools/registry.js`.
2. Implement its logic in the relevant `src/services/*.js`, using an `src/upstream/*.js` client for any network call.

That's it — MCP, REST, `/health`, `/api`, and `/llms.txt` all pick it up automatically from the registry.

---

## Security

Public, unauthenticated, read-only — hardened accordingly:

- **`query_ponder`** is AST-validated: read-only only (no mutations/subscriptions), no introspection or batched queries, with depth/field/alias/length and `limit` caps and a result-size cap.
- **Rate limiting** derives the client IP from the trusted proxy hop (never the attacker-controllable left-most `X-Forwarded-For`).
- Request-body caps (413), slowloris timeouts, session caps with idle/absolute expiry, prototype-pollution rejection, and a single error mapper that never leaks stack traces, upstream URLs, secrets, or file paths.
- Security headers and a strict CORS policy on every response.

Threat model and controls: [`docs/rebuild/SECURITY.md`](docs/rebuild/SECURITY.md).

---

## Deployment

Runs on [Railway](https://railway.app) and **auto-deploys from `main`** via nixpacks — no build phase, no dashboard configuration, no required env vars. `railway.toml` sets `startCommand = node src/index.js --http` and health-checks `/health`.

---

## License

MIT — [Frankencoin Association](https://frankencoin.com)
