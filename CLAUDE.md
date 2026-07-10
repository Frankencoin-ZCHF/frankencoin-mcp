# CLAUDE.md — Frankencoin MCP Server

## Project overview

The Frankencoin MCP server — a Model Context Protocol server that exposes real-time
Frankencoin (ZCHF) protocol data as read-only tools for AI assistants and developer
tools. Public, unauthenticated, stateless.

**Stack:** Node.js ESM (`"type": "module"`), `@modelcontextprotocol/sdk`, `zod`. No
build step, no TypeScript, no bundler — runs directly with `node`.
**Entrypoint:** `src/index.js`
**Surfaces:** MCP Streamable HTTP (`/mcp`), legacy SSE (`/sse`), plain REST (`/api/<tool>`), plus `/health` and `/llms.txt`.

> This is the v3 read-only rewrite. It is **layered**, not the old 3-file
> (`index.js`/`api.js`/`tools.js`) structure — those files no longer exist.

---

## Architecture

```
src/
  index.js              — bootstrap: stdio mode, or --http mode
  config.js             — read env ONCE, apply defaults, freeze. Nothing required to boot.
  cache.js              — in-memory TTL cache w/ single-flight + SWR + LRU bound
  cli.js                — `frankencoin` CLI: calls services directly (no server/MCP)

  lib/
    constants.js        — ALL upstream hosts (hard-coded), chain names, contract maps,
                          ponder entity allowlist, doc-file map. Pure data, no I/O.
    errors.js           — typed AppErrors + single mapError() (type → status + safe message)
    numbers.js          — fromWei / bpsToPercent / ppmToPercent / peg logic / date helpers
    envelope.js         — MCP + REST success/error envelopes
    concurrency.js      — Semaphore

  upstream/             — the ONLY layer that does network I/O
    client.js           — the one fetch wrapper: timeout, bounded retry, outbound
                          concurrency semaphore, response-size cap, typed errors
    frankencoin.js      — api.frankencoin.com (apiFetch)
    ponder.js           — ponder.frankencoin.com GraphQL
    ponderValidate.js   — query_ponder read-only validation (depth/field/alias caps, allowlist)
    coingecko.js dune.js eth.js github.js merch.js
    pharos.js xerberus.js — third-party risk providers

  services/             — business logic: compose upstream calls → clean domain objects
    snapshot.js market.js savings.js governance.js positions.js
    analytics.js content.js risk.js ponder.js

  server/
    mcp.js              — createMcpServer(): fresh McpServer per session, registers tools
    http.js             — node:http router: CORS, security headers, rate limit, body
                          caps, in-flight caps, routes, single error mapper
    sessions.js rateLimit.js llmsTxt.js

  tools/
    registry.js         — the tools array: each owns its zod input schema + REST param descriptor
    dispatch.js         — the ONE dispatch path shared by MCP + REST: lookup → zod → handler
```

### Data flow

`registry.js` (schema + handler) → `dispatch.js` (validate/coerce/clamp) →
`services/*` (compose) → `upstream/*` (fetch, cached) → `lib/*` (decode).
Both MCP (`server/mcp.js`) and REST (`server/http.js`) call the same `dispatchTool()`.

### Key design decisions

**One McpServer instance per session.** The SDK's `McpServer` is stateful and binds to
one transport. HTTP mode calls `createMcpServer()` per session, not once globally.
Intentional — do not refactor to a shared singleton.

**No auth.** Public read-only API. Do not add auth unless explicitly requested.

**No build step.** Keep it Node ESM. No TypeScript, no bundler.

**Degradable secrets.** Nothing is required to boot. A missing optional key makes its
upstream client throw `MissingSecretError` **without any network call**; the service
catches it and returns partial data + a soft `note`. It must never crash the server.

**Hosts are hard-coded in `lib/constants.js` and NOWHERE else.** Env supplies only
credentials, never destinations — no client-supplied value can influence an outbound
request. Secret-bearing requests use `redirect: "error"` so keys never travel cross-host.

**Caching at the upstream boundary.** A single `/prices/list` (or Pharos card, etc.)
fetch is shared across every tool that needs it. Non-authoritative — wiped on restart.

---

## Tools (15)

`get_protocol_snapshot`, `get_market_data`, `get_savings`, `get_governance`,
`get_positions`, `get_challenges`, `get_collaterals`, `get_analytics`,
`get_knowledge`, `get_compliance`, `get_news`, `get_merch`, `get_risk`,
`get_dune_stats`, `query_ponder`.

The canonical list lives in `src/tools/registry.js`; `/llms.txt`, `/api`, and `/health`
all derive from it — add a tool there and every surface updates automatically.

---

## Running

```bash
node src/index.js            # stdio mode (local Claude Desktop / Cursor / CLI)
node src/index.js --http     # HTTP mode (public deployment)
PORT=8080 node src/index.js --http
node src/cli.js snapshot     # CLI — direct service access, no server
npm test                     # 77 tests via `node --test`
```

Health check: `curl http://localhost:3000/health`

---

## Environment variables

**Nothing is required to boot.** Every variable is optional; a missing secret only
degrades the tool(s) that depend on it. Full list + defaults in `src/config.js`.

**Secrets** (degrade to a soft note when absent):

| Variable | Enables |
|----------|---------|
| `COINGECKO_API_KEY` | Full market/macro data in `get_market_data` |
| `DUNE_API_KEY` | `get_dune_stats` |
| `PHAROS_API_KEY` | Pharos section of `get_risk` |
| `XERBERUS_API_KEY` | Xerberus section of `get_risk` |
| `XERBERUS_USER_EMAIL` | Required identifying header sent with the Xerberus key |

**Other:** `PORT` (Railway injects it), `PUBLIC_URL` (canonical origin in manifests,
default `https://mcp.frankencoin.com`). Rate-limit / cache / session / timeout /
query_ponder tunables all have sane defaults — see `config.js`.

---

## Data sources

All hosts hard-coded in `lib/constants.js`. Callers never talk to these directly.

| Source | Provides | Key | Upstream module |
|--------|----------|-----|-----------------|
| api.frankencoin.com | Supply, TVL, FPS, savings rates, collaterals, challenges, prices | — | `frankencoin.js` (`apiFetch`) |
| ponder.frankencoin.com | On-chain indexed data — positions, trades, minters, analytics | — | `ponder.js` |
| CoinGecko Pro | Market prices, 24h changes, CHF-stablecoin comparison | optional | `coingecko.js` |
| Dune Analytics | Holder counts, minting volume, savings TVL history | optional | `dune.js` |
| Pharos | Stablecoin-safety report card for ZCHF (`get_risk`) | optional | `pharos.js` |
| Xerberus | Composite on-chain risk scores (`get_risk`) | optional | `xerberus.js` |
| GitHub repos | Docs + website content (knowledge, compliance, links, token addresses) | — | `github.js` |
| merch.frankencoin.com | Merch products (Shopify) | — | `merch.js` |
| Ethereum RPC | CHFAU on-chain supply | — | `eth.js` |

### GraphQL: `ponder.frankencoin.com`

POST `{ query: "..." }`. No auth. List queries support `limit`, `orderBy`,
`orderDirection`, `where`; results are `{ items: [...], pageInfo: { hasNextPage, endCursor } }`.

**Ponder entities do NOT have an `id` field** — use the entity-specific primary key
(`position`, `minter`, `date`, …). Querying `id` returns a validation error. The
`query_ponder` tool enforces a root-field **allowlist** (`PONDER_ENTITIES` in
`constants.js`) plus depth/field/alias/limit caps and rejects mutations/subscriptions.

### Number encoding (`lib/numbers.js`)

- Ponder token amounts are BigInt strings → `fromWei(val, decimals)` → float
- Savings rates: basis-points ×10 (37500 = 3.75%) → `bpsToPercent()`
- Risk premiums: PPM → `ppmToPercent()`
- Unix seconds → `isoFromUnix()` / `dateFromUnix()`

### Dual-denomination (CHF / USD)

Current-state monetary figures are `{ chf, usd }` pairs, and each such tool response
carries a top-level `fx: { chfUsd, source, note }` block. Helpers in `lib/numbers.js`:
- `moneyPair(chf, usd)` — package two authoritative amounts (both from a price feed)
- `money(chf, rate)` — derive USD from a CHF-only figure
- `moneyFromUsd(usd, rate)` — derive CHF from a USD-only figure (CoinGecko caps/volumes)

The rate comes from `services/fx.js` (`getChfUsdRate()` / `chfUsdRateFromPrices()`),
derived from the ZCHF price feed (`usd/chf` on `/prices/list`) so it tracks peg
deviation. It is the **current** rate only — `get_analytics` therefore keeps its
historical series in CHF and does NOT fabricate historical USD. `get_positions` /
`get_challenges` deal in token/collateral units and are left as-is.

---

## Adding a new tool

1. **Upstream** (if a new data source): add a client in `src/upstream/`, with its host
   as a constant in `lib/constants.js`. Follow the degradable-secret pattern
   (`MissingSecretError` before any network call) if it needs a key.
2. **Service:** add the business logic in `src/services/` composing upstream calls into
   a clean domain object.
3. **Registry:** add the tool to the array in `src/tools/registry.js` (name, description,
   zod `input` schema, `params` descriptor, `handler`).

That's it. MCP registration, REST routing, `/api`, `/llms.txt`, and dispatch all pick it
up from the registry. If it takes a secret, add it to `config.js` and this file's env table.

---

## Common gotchas

**Ponder responses over MCP are SSE-wrapped.** When testing `/mcp` with curl, bodies come as:
```
event: message
data: {"jsonrpc":"2.0","result":{...},"id":1}
```
Parse with `grep '^data:' | sed 's/^data: //'`. (The `/api/<tool>` REST surface returns plain JSON — easier for manual testing.)

**Savings modules on Ethereum:** two exist — the savings rate module (`0x27d9…`, ~3.75%)
and the base/pending rate module (`0x3bf3…`, ~1%). L2s have one each. When showing "the"
savings rate, use the max (savings module).

**Chain IDs** (`CHAIN_NAMES` in `constants.js`):
```
1=Ethereum, 10=Optimism, 100=Gnosis, 137=Polygon,
146=Sonic, 8453=Base, 42161=Arbitrum, 43114=Avalanche
```

**ZCHF contract addresses:**
- Ethereum: `0xb58e61c3098d85632df34eecfb899a1ed80921cb`
- All other chains: `0xd4dd9e2f021bb459d5a5f6c24c12fe09c5d45553`

**FPS contract:** Ethereum only — `0x1bA26788dfDe592fec8bcB0Eaff472a42BE341B2`

**Errors never leak.** Every response uses a typed error → fixed safe `clientMessage`.
No upstream URL, secret presence, stack, or raw upstream text ever reaches a response.
Log full detail to stderr only (`sanitizeForLog`).

---

## Testing

`npm test` runs the suite via `node --test` (unit + hermetic HTTP tests; the HTTP/dispatch
tests inject an offline fetch via `setFetchImpl` so nothing hits the network).

For manual end-to-end checks the REST surface is simplest:

```bash
node src/index.js --http &
curl -s http://localhost:3000/health
curl -s http://localhost:3000/api/get_protocol_snapshot
curl -s "http://localhost:3000/api/get_risk?source=all"
```

---

## Deployment

Target: `mcp.frankencoin.com`, deployed on **Railway** (auto-deploys from `main`;
nixpacks, no build step, no volume). Railway injects `PORT`.

Stateless between restarts — no database, no persistent state. Safe to restart any time.
`/health` returning `{status:"ok", ...15 tools}` is the deploy gate.
