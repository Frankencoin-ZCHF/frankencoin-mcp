# Frankencoin MCP Server — Reverse-Engineering Specification

> **Purpose.** Exhaustive, factual description of the *current* Frankencoin (ZCHF) MCP server so it can be re-implemented from scratch with identical externally-observable behavior. This documents reality, not desired state. No redesign proposals.
>
> **Server version:** `2.0.0` (from `package.json`). **Runtime:** Node.js ESM (`"type": "module"`), no build step, no TypeScript. **Deps:** `@modelcontextprotocol/sdk ^1.10.2`, `zod ^3.24.2` only.
>
> **Package `bin`:** `frankencoin-mcp` → `./src/index.js`; `frankencoin` → `./src/cli.js`.

---

## 0. File inventory

| File | Lines | Purpose |
|------|------:|---------|
| `src/index.js` | 613 | Entry point. stdio + HTTP transports, MCP streamable/SSE, REST `/api/<tool>`, `/health`, `/webhooks/*` routing, per-IP rate limiter, session management, tool dispatch switch, graceful shutdown. |
| `src/tools.js` | 289 | The 17 MCP tool definitions (13 data + 4 webhook): `name`, `description`, JSON-Schema `inputSchema`. (Imports `zod` but does not use it.) |
| `src/api.js` | 26 | Barrel: re-exports the 13 data handlers from `api/*.js`. |
| `src/cli.js` | 321 | Standalone `frankencoin` CLI wrapping the 13 data handlers with human/`--json` output. No webhook commands. |
| `src/api/helpers.js` | 179 | Constants (base URLs, chain names, CoinGecko IDs, Dune query IDs), API-key loading, fetch helpers (`apiFetch`, `ponderQuery`, `cgFetch`, `duneExecute`, `ethCall`, `githubFile`, `githubJson`), number utils (`fromWei`, `bpsToPercent`, `ppmToPercent`). |
| `src/api/snapshot.js` | 81 | `getProtocolSnapshot()`. |
| `src/api/market.js` | 154 | `getMarketData()`. |
| `src/api/savings.js` | 81 | `getSavings()`. |
| `src/api/governance.js` | 115 | `getGovernance()` + private `getRateProposals/getMinters/getEquityTrades/getHolderStats`. |
| `src/api/positions.js` | 249 | `getPositions()`, `getChallenges()`, `getCollaterals()`. |
| `src/api/analytics.js` | 201 | `getAnalytics()`, `getDuneStats()`, `runPonderQuery()`. |
| `src/api/content.js` | 273 | `getKnowledge()`, `getNews()`, `getMerch()`. |
| `src/webhooks/index.js` | 9 | Webhook barrel export. **BEING REMOVED.** |
| `src/webhooks/events.js` | 160 | Event types, thresholds, filter applicability, payload builder, filter matcher. **BEING REMOVED.** |
| `src/webhooks/poller.js` | 540 | 60s poller: diffs Ponder/API/CoinGecko state → emits 14 event types. **BEING REMOVED.** |
| `src/webhooks/subscriptions.js` | 363 | File-backed subscription store, caps, TTL, HMAC/token hashing. **BEING REMOVED.** |
| `src/webhooks/delivery.js` | 189 | HMAC-SHA256 signing, HTTP POST delivery, retry/backoff, DNS-pinned client. **BEING REMOVED.** |
| `src/webhooks/routes.js` | 191 | `/webhooks/*` HTTP handlers. **BEING REMOVED.** |
| `src/webhooks/auth.js` | 44 | `WEBHOOK_ADMIN_TOKEN` constant-time check helpers. **BEING REMOVED.** |
| `src/webhooks/urlSafety.js` | 202 | SSRF-guard: URL parse + private/reserved IP blocking + DNS pin. **BEING REMOVED.** |
| `src/webhooks/tests/*.test.js` | (5 files) | `node --test` unit tests for the webhook subsystem. **BEING REMOVED.** |

**Total src (excl. tests): ~4,280 lines.**

---

## 1. Interfaces / Transports

Mode is selected by CLI flag: `node src/index.js` = **stdio**; `node src/index.js --http` = **HTTP** (`useHttp = process.argv.includes("--http")`).

### 1.1 stdio mode (default)

- Instantiates **one** `McpServer` via `createServer()` and connects a single `StdioServerTransport`.
- Logs `Frankencoin MCP server running on stdio` to **stderr**.
- Webhook tools are present but throw `"Webhooks only available in HTTP mode"` (because `webhookStore` is only set in HTTP mode; in stdio it stays `null`).
- No HTTP server, no rate limiting, no poller.

### 1.2 HTTP mode (`--http`)

Single `http.createServer` on `PORT` (default `3000`). All requests pass through, in order:

1. **CORS headers** set on *every* response (see §6.6).
2. `OPTIONS` → `204` immediately (empty body).
3. **URL parse** guard: `new URL(req.url, "http://localhost:PORT")`; on throw → `400 {"error":"Invalid request URL"}`.
4. **Rate limiting** (see §4.6) — applied to *all* paths including health.
5. Path routing (below).

Startup logs (stderr) list all endpoints; then `startPoller(webhookStore, SERVER_VERSION)` is called. `webhookStore = new SubscriptionStore()` is created *before* `listen`.

#### Route table (HTTP mode)

| Path | Method(s) | Purpose |
|------|-----------|---------|
| `/` or `/health` | any (GET typical) | Health + capability manifest (§1.3). |
| `/api` or `/api/` | any | REST index / self-describing manifest (§1.4). |
| `/api/<tool>` | GET / POST / PUT | REST tool invocation (§1.5). |
| `/mcp` | POST / GET / DELETE | MCP Streamable HTTP (§1.6). |
| `/sse` | GET | Legacy SSE stream open (§1.7). |
| `/messages?sessionId=` | POST | Legacy SSE message post (§1.7). |
| `/webhooks/*` | GET/POST/DELETE | Webhook subsystem (§8). **BEING REMOVED.** |
| anything else | any | `404 {"error":"Not found","endpoints":["/mcp","/api","/sse","/health"]}` |

### 1.3 `GET /health` (and `/`)

`200 application/json`, pretty-printed (2-space). Body:

```json
{
  "status": "ok",
  "server": "frankencoin-mcp",
  "version": "2.0.0",
  "description": "Frankencoin (ZCHF) protocol data server — 17 tools (13 data + 4 webhook)",
  "interfaces": { "mcp": "...", "rest": "...", "sse": "...", "webhooks": "..." },
  "tools": [ { "name": "...", "description": "..." }, ... ],   // all 17 from TOOLS
  "activeSessions": <sessions.size>,
  "docs": "https://github.com/Frankencoin-ZCHF/frankencoin-mcp"
}
```

### 1.4 `GET /api` (REST index)

`200`, pretty JSON. A self-describing manifest: `description`, `usage`, `examples[]` (hard-coded curl-style strings), and `tools[]` where each entry is `{ name, description, params:[{name,type,required,description}], url:"GET /api/<name>" }` derived from `TOOLS`.

### 1.5 REST — `/api/<tool>`

`toolName = pathname.slice(5)`. Lookup in `TOOLS`.

- **Unknown tool** → `404 {"ok":false,"error":"Unknown tool: <name>","available":[...all tool names]}`.
- **Webhook-management tools** (`subscribe_events`, `unsubscribe_events`, `list_subscriptions`, `get_webhook_status`) accessed with a method other than POST/PUT → `405`, `Allow: POST, PUT`, `{"ok":false,"tool","error":"Webhook management tools require POST with token in body or Authorization/X-Webhook-Admin-Token header"}`. (Rationale in code: admin tokens must not travel in query strings.)
- **Param parsing:**
  - `POST`/`PUT`: read body (streamed, capped at `MAX_BODY_BYTES = 64 KB`; overflow → `req.destroy()` + reject). Non-empty body → `JSON.parse`. Parse error → `400 "Invalid JSON body"`; over-size → `413 "Request body too large (max 64 KB)"`.
  - `GET` (and other): iterate `url.searchParams`; **coerce by declared schema type** — `number` → `Number(v)`, `boolean` → `v==="true" || v==="1"`, else string.
- **Token injection for webhook tools:** if `!params.admin_token`, fill from `Authorization: Bearer <t>` else `X-Webhook-Admin-Token` header. If `!params.management_token`, fill from `X-Webhook-Management-Token` header.
- **Dispatch:** `await dispatchTool(toolName, params)`.
  - Success → `200 {"ok":true,"tool":<name>,"result":<obj>}` pretty JSON; logs `[/api/<tool>] ok` to stderr.
  - Error → status chosen by message: contains `"required"` → `400`; exactly `"unauthorized"` → `401`; else `500`. Body `{"ok":false,"tool","error":<message>}`. Logs `[/api/<tool>] error: <msg>`.

**Observations for rewrite:** REST error mapping is string-sniffing on `e.message` (fragile). Response `Content-Type` is always `application/json` even for errors. GET success/error bodies are pretty-printed; error bodies are *not* pretty-printed (inconsistent). No per-tool schema validation beyond type coercion — extra/unknown params pass straight through to handlers.

### 1.6 MCP Streamable HTTP — `/mcp`

Session store: `sessions = Map<sessionId, {server, transport}>`. One `McpServer` + `StreamableHTTPServerTransport` per session (per CLAUDE.md: intentional, not a singleton).

- **POST with existing `mcp-session-id`** in `sessions` → forward to that transport's `handleRequest`.
- **POST with `mcp-session-id` not in `sessions`** → `404 {jsonrpc:"2.0",error:{code:-32001,message:"Session not found — please re-initialize"},id:null}`.
- **POST without session id (new init):** guarded by `initLockPromise` (a single in-flight init lock). If a lock is pending, await it; if sessions already exist afterward → `503` + `Retry-After: 1` + `{...code:-32000,"Server initializing — please retry initialize"}`. Otherwise create a new transport with `sessionIdGenerator: crypto.randomUUID`; `onsessioninitialized` stores it and logs `[session] new: <id>`; `onclose` deletes it and logs `[session] closed`. Connect a fresh `createServer()`; `handleRequest`; resolve lock; `finally initLockPromise = null`.
- **GET** (SSE notification stream) requires valid `mcp-session-id`, else `400 {"error":"Missing or invalid mcp-session-id"}`; otherwise forwards to transport.
- **DELETE** with known session → forward + delete; unknown/missing → `200` empty.
- **Other methods** → `405 {"error":"Method not allowed"}`.
- Catch-all: logs `[/mcp error]`; if headers unsent → `500 {"error":<msg>}`.

**Observation for rewrite:** the `initLockPromise` single-flight means concurrent first-time initializes serialize; a race where `sessions.size > 0` yields `503` to subsequent inits.

### 1.7 Legacy SSE — `/sse` + `/messages`

Separate store `sseSessions = Map<sseId,{server,transport}>`.

- `GET /sse` (non-GET → `405` empty): mint `sseId = crypto.randomUUID()`; `new SSEServerTransport("/messages?sessionId=<sseId>", res)`; fresh `createServer()`; store; `onclose` deletes; `connect`. Stream stays open.
- `POST /messages?sessionId=<id>` (non-POST → `405` empty): look up `sseId`; unknown/missing → `400 {"error":"Unknown sessionId — connect via GET /sse first"}`; else `transport.handlePostMessage(req, res)`.

### 1.8 MCP tool registration (both transports)

`createServer()` builds an `McpServer({name:"frankencoin", version:SERVER_VERSION})` and for each of the 17 `TOOLS`:
- Converts JSON-Schema `properties` → Zod raw shape via `jsonPropsToZodShape`: `number→z.number()`, `boolean→z.boolean()`, everything else → `z.string()`; adds `.describe()` if `description` present; `.optional()` unless in `required`.
- Registers `server.tool(name, description, zodShape, handler)`. Handler calls `dispatchTool` and wraps result via `ok()` = `{content:[{type:"text",text:JSON.stringify(data,null,2)}]}`, or on throw via `err()` = `{content:[{type:"text",text:"Error: <msg>"}],isError:true}`.

**So every MCP tool result is a single text block containing pretty-printed JSON** (identical object to the REST `result` field).

---

## 2. Tools

Dispatch happens in `dispatchTool(toolName, args)` (`index.js`). Argument normalization/clamping happens **in the dispatch switch**, not in the handlers — the rewrite must replicate the clamps here.

> **Units convention below:** `*Chf`/`*Zchf` = human float CHF/ZCHF (post-`fromWei`), `*Percent` = percent number (e.g. `3.75`), timestamps = ISO-8601 strings, addresses = lowercase-or-checksummed as returned upstream.

### Tool 1 — `get_protocol_snapshot`

- **Description:** *"Full live state of the Frankencoin (ZCHF) protocol in one call. Returns: total supply + per-chain breakdown, TVL (CHF/USD), FPS price/supply/market cap/reserve/earnings, savings lead rate + base rate + pending proposals, and active challenge count. Best starting point for any protocol question."*
- **inputSchema:** `{}` (no params).
- **Handler:** `api.getProtocolSnapshot()`.
- **Upstream (parallel `Promise.all`):** `apiFetch("/ecosystem/frankencoin/info")`, `apiFetch("/ecosystem/fps/info")`, `getSavings()` (→ 2 REST calls), `getChallenges({limit:5})` (→ REST + Ponder + optional CoinGecko).
- **Return shape:**
  ```
  {
    zchf: {
      name, symbol,                       // from info.erc20
      totalSupply,                        // info.token.supply (raw as provided by API)
      priceUsd,                           // info.token.usd
      tvl: { chf, usd },                  // info.tvl.chf / .usd
      chains: [ {                         // Object.entries(info.chains)
        chainId (Number), chainName (CHAIN_NAMES lookup),
        address, supply,                  // c.address, c.supply
        sharePercent,                     // (c.supply/info.token.supply*100).toFixed(1) as Number, or null
        mintEvents, burnEvents,           // c.counter.mint / .burn
        updated                           // ISO from c.updated*1000
      } ]
    },
    fps: {
      name, symbol,                       // fpsData.erc20
      address,                            // fpsData.chains[1].address
      priceChf,                           // info.fps.price
      priceUsd,                           // fpsData.token.price
      totalSupply,                        // info.fps.totalSupply
      marketCapChf,                       // info.fps.marketCap
      marketCapUsd,                       // fpsData.token.marketCap
      earnings: { profitChf, lossChf, netChf },   // fpsData.earnings.profit/.loss; net = profit-loss
      reserve: { totalChf, equityChf, minterReserveChf } // fpsData.reserve.balance/.equity/.minter
    },
    savings: {
      leadRatePercent,                    // approved rate where chainId==1 && rateBps>10000 → ratePercent, else null
      baseRatePercent,                    // approved rate where chainId==1 && rateBps===10000, else null
      pendingRateChanges,                 // savings.rates.proposed.length
      totalDepositedChf                   // sum of savings.stats[].balanceChf
    },
    challenges: {
      total, active,                      // from getChallenges
      recent                              // first 3 of challenges where status !== "Success"
    },
    updatedAt                             // new Date().toISOString()
  }
  ```
  **Note:** lead/base rate selection uses a magic threshold: rate stored in bps×10 where `10000` = 1.0% is the "base" module and anything `>10000` is the savings/lead module (per CLAUDE.md two-module design).

### Tool 2 — `get_market_data`

- **Description:** *"Live market data: ZCHF peg health (price vs CHF, deviation, status), FPS price, all ecosystem token prices (collateral + ZCHF + FPS), CHF stablecoin comparison (ZCHF vs VCHF vs CHFAU — peg, market cap, volume, supply), macro context (BTC, ETH prices + 24h changes), and accepted collateral token prices with 24h changes. One call for everything price/market related."*
- **inputSchema:** `{}`.
- **Handler:** `api.getMarketData()`. **Requires `CG_KEY`** — throws `"CoinGecko API key not configured on server"` up front if absent (hard-fails the whole tool).
- **Upstream (parallel):**
  - CoinGecko `/simple/price?ids=frankencoin&vs_currencies=usd,chf&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true`
  - CoinGecko `/simple/price?ids=bitcoin,ethereum&...` (same flags)
  - CoinGecko `/simple/price?ids=<all collateral cg ids>&vs_currencies=usd,chf&include_24hr_change=true&include_market_cap=true`
  - REST `apiFetch("/prices/list")`
  - CoinGecko `/global` (`.catch(()=>null)`)
  - CoinGecko `/coins/markets?vs_currency=chf&ids=frankencoin,vnx-swiss-franc&order=market_cap_desc&sparkline=false&price_change_percentage=24h`
  - `ethCall(CHFAU_CONTRACT, "0x18160ddd")` = `totalSupply()` on AllUnity CHFAU (`.catch(()=>null)`)
- **Return shape:**
  ```
  {
    zchf: { priceUsd, priceChf, change24hPercent, volume24hUsd, marketCapUsd,
            pegDeviationPercent,           // (priceChf-1)*100, 4dp
            pegStatus },                   // |dev|<0.5 healthy / <1.0 warning / else critical / null→unknown
    fps: { priceChf, priceUsd, note:"FPS is not listed on CoinGecko — price sourced from Frankencoin API" },
    prices: [ {                            // mapped from /prices/list
      chainId, address, name, symbol, priceUsd, priceChf, source, updatedAt } ],
    collateral: [ {                        // Object.entries(COINGECKO_IDS), sorted by marketCapUsd desc
      symbol, name, address, priceUsd, priceChf, change24hPercent (2dp), marketCapUsd (rounded) } ],
    chfStablecoins: [
      { name:"Frankencoin", symbol:"ZCHF", type:"CDP / overcollateralised", issuer:"Frankencoin Association",
        priceChf, pegDeviationPercent (4dp), pegStatus, marketCapChf, volume24hChf, change24hPercent (4dp), circulatingSupply },
      { name:"VNX Swiss Franc", symbol:"VCHF", type:"Fiat-backed", issuer:"VNX", ...same fields },
      { name:"AllUnity CHF", symbol:"CHFAU", type:"Fiat-backed", issuer:"AllUnity (DWS + Flow Traders + Galaxy)",
        priceChf:null, pegDeviationPercent:null, pegStatus:"unknown", marketCapChf:null, volume24hChf:null,
        change24hPercent:null, circulatingSupply:<from on-chain totalSupply/1e6, 6 decimals>,
        contract:CHFAU_CONTRACT, note:"No CoinGecko price feed yet — supply from on-chain (Ethereum, 6 decimals)" }
    ],
    macro: {
      bitcoin:  { priceUsd, priceChf, change24hPercent(2dp), volume24hUsd, marketCapUsd(rounded) },
      ethereum: { ...same }
    },
    defiTotalMarketCapUsd,                 // globalData.data.total_market_cap.usd rounded, or null
    updatedAt
  }
  ```
  ZCHF price precedence: `fcPrices` entry with `symbol==="ZCHF"` `.price.chf` first, else CoinGecko `frankencoin.chf`. `chfStablecoins` ZCHF/VCHF pull from the `/coins/markets` array (`current_price`, `market_cap`, `total_volume`, `price_change_percentage_24h`, `circulating_supply`).

### Tool 3 — `get_savings`

- **Description:** *"Complete savings picture: current approved rates per chain/module, any pending rate proposals, plus per-module stats (total deposited, interest paid, withdrawals, event counts). Combines rate governance state with TVL/flow data in one call."*
- **inputSchema:** `{}`.
- **Handler:** `api.getSavings()`.
- **Upstream (parallel REST):** `/savings/leadrate/info`, `/savings/core/info`.
- **Return shape:**
  ```
  {
    rates: {
      approved: [ { chainId, chainName, module, ratePercent (bpsToPercent), rateBps (raw approvedRate),
                    appliedAt (ISO from m.created*1000), voteCount (m.count) } ],   // from rateData.rate[chain][module]
      proposed: [ { chainId, chainName, module, proposedRatePercent, proposedRateBps (m.nextRate),
                    proposer, effectiveAt (m.nextChange*1000), proposedAt (m.created*1000) } ] // from rateData.proposed
    },
    stats: [ { chainId, chainName, module,
               balanceChf (fromWei m.balance), totalInterestPaidChf (m.interest),
               totalSavedChf (m.save), totalWithdrawnChf (m.withdraw),
               ratePercent (bpsToPercent m.rate), updatedAt (m.updated*1000),
               events: { interestPayments, rateChanges, deposits, withdrawals } } ],  // from coreData.status[chain][module]
    summary: {
      totalDepositedChf,                   // sum stats[].balanceChf
      totalInterestPaidChf,                // sum stats[].totalInterestPaidChf
      pendingRateChanges                   // proposed.length
    }
  }
  ```

### Tool 4 — `get_governance`

- **Description:** *"Governance activity: rate proposals (pending/past), minter applications (pending/denied/all), FPS equity trades (buy/sell), and FPS/ZCHF holder stats from Dune. Use 'type' to select what governance data to return."*
- **inputSchema:**
  - `type` (string): `'all'`(default) | `'rate_proposals'` | `'minters'` | `'equity_trades'` | `'holders'`.
  - `status` (string): for minters `active`/`denied`/`all`(default); for rate_proposals `pending`/`approved`/`all`(default).
  - `limit` (number): per-section max, default 20, **clamped ≤100** (`Math.min(args.limit ?? 20, 100)` in dispatch).
- **Handler:** `api.getGovernance({type, status, limit})`.
- **Upstream:** conditional per `type` (`all` runs everything):
  - `rate_proposals` → Ponder `leadrateRateChangeds(limit:≤100, orderBy:"created", orderDirection:"desc"){items{chainId module approvedRate created blockheight txHash}}`.
  - `minters` → Ponder `frankencoinMinters(limit:≤100){items{chainId txHash minter applicationPeriod applicationFee applyMessage applyDate suggestor denyMessage denyDate denyTxHash vetor}}`.
  - `equity_trades` → Ponder `equityTrades(limit:≤100, orderBy:"created", orderDirection:"desc"){items{kind count trader amount shares price created txHash}}`.
  - `holders` → Dune `zchfHolders` (6712642) + `fpsHolders` (6712643) via `Promise.allSettled`; if `!DUNE_KEY` returns `{note:"Dune API key not configured — holder stats unavailable"}`.
- **Return shape (keys present depend on `type`):**
  ```
  {
    rateProposals: [ { date (YYYY-MM-DD), chainId, chainName, ratePercent (bpsToPercent), module, txHash, status:"approved" } ],
    // NOTE: pending proposals NOT included here — code comment says they come from get_savings. status filter "approved"/other both return all.
    minters: [ { address, chainId, isActive (!denyDate), applicationFeeChf (fromWei), appliedAt, deniedAt,
                 suggestor, applyMessage, denyMessage, vetor, txHash, applicationPeriodSeconds } ],
                 // status==="active" → isActive true only; "denied" → isActive false only.
    equityTrades: [ { count (Number), kind, trader, sharesTraded (fromWei shares), priceChf (fromWei price),
                      amountChf (fromWei amount), timestamp (created*1000), txHash } ],
    holders: { zchf: <first Dune row or null>, fps: <first Dune row or null> }   // or {note:...}
  }
  ```

### Tool 5 — `get_positions`

- **Description:** *"ZCHF minting positions. By default returns address list + count (lightweight). Set detail=true for full on-chain data: collateral type/balance, minted amount, available capacity, liquidation price, collateral ratio, risk premium, expiry, cooldown, and live market prices."*
- **inputSchema:**
  - `detail` (boolean, default false).
  - `limit` (number): "default 50 for list, 20 for detail, max 100". Dispatch passes `limit != null ? Math.min(limit,100) : undefined`; handler defaults (50 list / 20 detail) apply when undefined.
  - `active_only` (boolean) → passed as `activeOnly`.
  - `collateral` (string) — token address filter, only meaningful with `detail=true`.
- **Handler:** `api.getPositions({detail, limit, activeOnly, collateral})`.
- **Lightweight branch (`detail=false`):** REST `apiFetch("/positions/open")`. Returns:
  ```
  { total: data.num, returned: min(limit??50, addresses.length),
    addresses: data.addresses.slice(0, limit??50),
    note: "Set detail=true for full position data including collateral, amounts, and pricing." }
  ```
- **Detail branch (`detail=true`):** `effectiveLimit = min(limit??20,100)`, `effectiveActiveOnly = activeOnly ?? true`.
  - GraphQL `where` clause built by string interpolation: active-only → `{closed:false, denied:false[, collateral:"<addr>"]}`; else `[{collateral:"<addr>"}]` if collateral given.
  - **Upstream (parallel):** Ponder `mintingHubV2PositionV2s(limit, where){items{position owner collateral collateralSymbol collateralBalance collateralDecimals minted availableForMinting price cooldown expiration start closed denied isOriginal isClone minimumCollateral riskPremiumPPM reserveContribution challengePeriod} pageInfo{hasNextPage endCursor}}`; REST `/prices/list`; REST `/ecosystem/collateral/list`.
  - Then optional CoinGecko `/simple/price?ids=<cgIds>&vs_currencies=usd,chf&include_24hr_change=true&include_market_cap=true` for the involved collaterals — only if `CG_KEY` present; wrapped in try/catch (non-fatal, `cgData={}`).
  - **Return shape:**
    ```
    { total: items.length,
      positions: [ {
        address (p.position), owner,
        status: closed?"closed":denied?"denied":"active",
        isOriginal, isClone,
        collateral: {
          address, symbol, decimals,     // decimals: authoritative from collateral/list, else p.collateralDecimals, else 18
          balance (fromWei collateralBalance, decimals),
          minimumRequired (fromWei minimumCollateral, decimals),
          priceChf, priceUsd,            // from /prices/list entry
          change24hPercent (cg.usd_24h_change.toFixed(2) as string, or null),
          marketCapUsd (rounded, or null),
          valueChf (balance*priceChf, 2dp, or null)
        },
        minted (fromWei),
        availableForMinting (fromWei),
        collateralRatioPercent,          // null if no price; "N/A" if minted==0; else (value/minted*100).toFixed(1) as Number
        liquidationPriceZchf,            // fromWei(p.price, 36 - decimals)
        riskPremiumPercent (ppmToPercent riskPremiumPPM),
        reserveContributionPercent (ppmToPercent reserveContribution),
        challengePeriodSeconds (Number),
        cooldownUntil (ISO or null), expiresAt (ISO or null), startedAt (ISO or null)
      } ],
      pageInfo: { hasNextPage, endCursor }
    }
    ```
  - **Key encoding:** liquidation price uses `36 - decimals` decimals (Ponder price scaling). `change24hPercent` is a **string** here (`.toFixed(2)`), not a number.

### Tool 6 — `get_challenges`

- **Description:** *"Liquidation challenges against collateral positions. Returns challenge status, size, bids, timing, collateral details, liquidation price, and position context."*
- **inputSchema:** `limit` (number, default 20, dispatch-clamped ≤100), `active_only` (boolean, default false).
- **Handler:** `api.getChallenges({limit, activeOnly})`.
- **Upstream:**
  - Parallel REST `/challenges/list` + `/prices/list`.
  - `activeOnly` → drop `status==="Success"`. `sliced = list.slice(0, limit)`.
  - For each **unique** challenged position address, a Ponder query fetching both V2 and V1 in one request: `v2: mintingHubV2PositionV2s(where:{position:"<addr>"}){items{position collateral collateralSymbol collateralDecimals collateralBalance minted price riskPremiumPPM owner}}` and `v1: mintingHubV1PositionV1s(where:{position:"<addr>"}){items{... annualInterestPPM ...}}`. V2 preferred; if only V1, `v1.riskPremiumPPM = v1.annualInterestPPM`. Each wrapped in try/catch (non-fatal). Executed in parallel via `Promise.all`.
  - Optional CoinGecko enrichment (same pattern; only if `CG_KEY`).
- **Return shape:**
  ```
  { total: data.num,
    active: (data.list filter status!=="Success").length,   // computed over FULL list, not sliced
    challenges: [ {
      id (c.id || "<position>-challenge-<number>"), position, number (Number), challenger, status, version,
      startedAt (c.start*1000), expiresAt ((start+duration)*1000), isExpired ((start+duration)<now),
      durationSeconds, bids (Number), txHash,
      collateral: { address, symbol, decimals, priceChf, priceUsd, change24hPercent(string 2dp|null), marketCapUsd } | null,
      size (fromWei c.size, decimals), filledSize (fromWei c.filledSize, decimals),
      acquiredCollateral (fromWei c.acquiredCollateral, decimals),
      fillPercent (filled/size*100, 1dp; 0 if size==0),
      liquidationPriceZchf (fromWei c.liqPrice, 36-decimals),
      marketVsLiqPremiumPercent ((priceChf-liq)/liq*100, 2dp | null),
      challengeValueZchf (size*liq, 2dp | null),
      positionOwner, positionMintedZchf (fromWei), positionCollateralBalance (fromWei, decimals),
      positionRiskPremiumPercent (ppmToPercent)
    } ]
  }
  ```
  Default `collateralDecimals` when no position found: 18.

### Tool 7 — `get_collaterals`

- **Description:** *"List all accepted collateral types in the Frankencoin protocol — token names, symbols, addresses, decimals, and which chain they're on."*
- **inputSchema:** `{}`.
- **Handler:** `api.getCollaterals()` → REST `/ecosystem/collateral/list`.
- **Return:** an **array** (not wrapped): `[{ chainId, chainName (c.chainName || "Chain <id>"), address, name, symbol, decimals }]`.

### Tool 8 — `get_analytics`

- **Description:** *"Historical protocol analytics. Use 'type' to select: 'time_series' (daily supply, equity, savings, FPS price, rates, earnings — default), 'trades' (FPS equity buy/sell trades), 'minters' (minter application history), 'rate_history' (governance rate change timeline)."*
- **inputSchema:** `type` (string, default `time_series`), `days` (number, default 90, dispatch-clamped ≤365), `limit` (number, default 20, clamped ≤100).
- **Handler:** `api.getAnalytics({type, days, limit})`. Switch on `type`; unknown type → `{error:"Unknown analytics type: ... Use: time_series, trades, minters, rate_history."}`.
- **`time_series`** — parallel Ponder:
  - `analyticDailyLogs(limit:min(days,365), orderBy:"timestamp", orderDirection:"desc"){items{date totalSupply totalEquity totalSavings fpsTotalSupply fpsPrice currentLeadRate annualV1BorrowRate annualV2BorrowRate projectedInterests annualNetEarnings realizedNetEarnings earningsPerFPS totalMintedV1 totalMintedV2 totalInflow totalOutflow totalTradeFee}}`
  - `leadrateRateChangeds(limit:100, orderBy:"created", orderDirection:"desc"){items{chainId module approvedRate created blockheight txHash}}`
  - Return:
    ```
    { note: { savingsRate, v1BorrowRate, v2BorrowRate (explanatory strings), dataRange:"<oldest>→<newest>", totalDays },
      daily: [ { date,
        supply:{ total, mintedV1, mintedV2 },                       // all fromWei
        fps:{ supply, priceChf, marketCapChf (supply*price), earningsPerFPS },  // all fromWei
        rates:{ savingsRatePercent (fromWei*100), v1BorrowRatePercent, v2BorrowRatePercent },
        protocol:{ equity, savings, projectedAnnualInterestIncome, annualNetEarnings, realizedNetEarnings,
                   cumulativeInflow, cumulativeOutflow, cumulativeTradeFees }   // all fromWei
      } ],
      rateHistory: { ethereum: [ ...chainId==1, sorted asc by date ], all: [ ...all rate changes ] }
    }
    ```
    (rateHistory rows: `{date(YYYY-MM-DD), chainId, chainName, ratePercent (bpsToPercent), module, txHash}`.)
- **`trades`** — Ponder `equityTrades(limit:≤100,...)`. Returns `{trades:[{count,kind,trader,sharesTraded,priceChf,amountChf,timestamp,txHash}]}` (same mapping as governance equity_trades).
- **`minters`** — Ponder `frankencoinMinters(limit:≤100)`. Returns `{minters:[...same shape as governance minters]}`.
- **`rate_history`** — Ponder `leadrateRateChangeds(limit:100,...)`. Returns `{rateHistory:{ethereum:[...],all:[...]}}`.

  **Note:** `days` does **not** actually filter `rate_history`/rateHistory output — always `limit:100` in query and no date cutoff applied.

### Tool 9 — `get_knowledge`

- **Description:** *"All explanatory and reference content about Frankencoin. Use 'topic' to select: 'overview' (default...), 'faq', 'savings', 'governance', 'minting', 'opening_positions', 'auctions', 'risks', 'reserve', 'pool_shares' (FPS explanation), 'api' (API docs), 'compliance' (links + legal), 'token_addresses' (contract addresses all chains), 'links' (all key URLs + exchanges), 'what_is' (same as overview)."*
- **inputSchema:** `topic` (string, default `overview`).
- **Handler:** `api.getKnowledge({topic})`. Three code paths:
  - `topic==="token_addresses"` → `getTokenAddresses()` (GitHub JSON `Frankencoin-ZCHF/frankencoin-site` → `src/content/en/token.json`). Returns `{topic, zchf:{name,symbol,description,chains:[{name,address,explorer}]}, fps:{name,symbol,description,chain:"Ethereum",address,explorer}, svzchf:{...chains}, note}`. FPS falls back to hard-coded `0x1bA26788dfDe592fec8bcB0Eaff472a42BE341B2`.
  - `topic==="links"` **or** `topic==="compliance"` → `getLinks()` (three GitHub JSON fetches: `src/content/en/shared/footer.json`, `src/content/en/exchanges.json`, `src/content/en/use-cases.json`). Returns a large object: `{topic:"links", app:{...7 app URLs}, website, community:{twitter,telegram,linkedin,youtube,forum,events,merch} (scraped from footer community column), developers:{docs,api,whitepaper,github}, analytics:{defillama,coingecko,dune}, brand:{logos,guidelines}, footer:<per-column link map>, exchanges:[{name,type,url,description}], useCaseHighlights:[{title,partner,category,url}], note}`.
  - Any `DOC_FILES` topic → GitHub markdown from **`Frankencoin-ZCHF/gitbook`** repo. `DOC_FILES` map: `overview/what_is→README.md`, `savings→savings.md`, `pool_shares→pool-shares.md`, `governance→governance.md`, `reserve→reserve.md`, `risks→risks.md`, `faq→faq.md`, `minting→positions/README.md`, `opening_positions→positions/open.md`, `auctions→positions/auctions.md`, `api→api-docs/README.md`. Returns `{topic, file, source (github blob url), docsUrl (docs.frankencoin.com/...), content (raw markdown), availableTopics:[...15]}`.
  - Unknown topic → `{error:"Unknown topic: ...", availableTopics:[...15]}`.

### Tool 10 — `get_news`

- **Description:** *"Frankencoin media coverage: press articles (titles, sources, dates, URLs), videos, real-world use cases, and ecosystem partners. Sourced live from the Frankencoin website repository."*
- **inputSchema:** `{}`.
- **Handler:** `api.getNews()`. Parallel GitHub JSON from `frankencoin-site`: `src/content/shared/media.json`, `src/content/en/use-cases.json`, `src/content/en/ecosystem.json`.
- **Return:**
  ```
  { media: {
      articles: [ { url, title, description, siteName, publishedDate, image } ],  // url list + articleMetadata[url]
      videos:   [ { url, title, description, author, publishedDate } ]            // videos list + videoMetadata[url]
    },
    useCases:  [ { title, partner, category, description, url } ],   // use-cases.json cases[]
    ecosystem: [ { name, category (t.category||t.badge), description, url (t.href) } ], // ecosystem.json tabs[]
    note: "Content sourced live from the Frankencoin website repository." }
  ```

### Tool 11 — `get_merch`

- **Description:** *"Frankencoin merch store products (merch.frankencoin.com) — titles, prices, variants, availability, images, and direct product URLs. Live data."*
- **inputSchema:** `{}`.
- **Handler:** `api.getMerch()`. **Direct `fetch`** (not a helper) to `https://merch.frankencoin.com/products.json?limit=250` with `AbortSignal.timeout(10000)`. Shopify products feed.
- **Return:**
  ```
  { storeUrl:"https://merch.frankencoin.com", totalProducts,
    products: [ { title, handle, url (products/<handle>), description (body_html stripped of tags),
                  type (product_type), tags[], images:[src...], options:[{name,values}],
                  variants:[{title,price,compareAtPrice,available,sku}],
                  minPrice (toFixed 2), maxPrice (toFixed 2), available (any variant available) } ],
    note: "Live from merch.frankencoin.com — prices in USD." }
  ```

### Tool 12 — `get_dune_stats`

- **Description:** *"On-chain analytics from Dune Analytics — ZCHF holder count, FPS holder count, historical minting volume, and savings TVL over time. Data may be slightly delayed vs real-time."*
- **inputSchema:** `{}`.
- **Handler:** `api.getDuneStats()`. **Requires `DUNE_KEY`** — throws `"Dune API key not configured on server"` if absent.
- **Upstream:** `Promise.allSettled` over `duneExecute` of query IDs `zchfHolders(6712642)`, `fpsHolders(6712643)`, `mintingVolume(6712644)`, `savingsTvl(6712646)`.
- **Return:** `{ holders:{ zchf:<first row|null>, fps:<first row|null> }, minting:<first 30 rows|null>, savingsTvl:<first 30 rows|null>, note:"Data from Dune Analytics — may be slightly delayed vs on-chain" }`.

### Tool 13 — `query_ponder`

- **Description:** *"Execute a raw GraphQL query against the Frankencoin on-chain indexer at ponder.frankencoin.com. Use for advanced queries not covered by other tools. Available entities: mintingHubV2PositionV2s, mintingHubV1PositionV1s, mintingHubV2ChallengeV2s, mintingHubV1ChallengeV1s, equityTrades, analyticDailyLogs, savingsActivity, savingsMappings, frankencoinMinters, eRC20Balances, eRC20TotalSupplys, leadrateRateChangeds, frankencoinProfitLosss, equityTradeCharts."*
- **inputSchema:** `query` (string, **required**).
- **Dispatch:** if `!args.query` → throw `"query parameter required"` (maps to REST `400`). Handler `api.runPonderQuery(query)` → `ponderQuery(query)` → returns raw `json.data` from Ponder. **Passes the user's query verbatim** to the GraphQL endpoint (no allowlist/validation).

---

### Webhook tools (Tools 14–17) — **BEING REMOVED — for reference only**

These are registered in `TOOLS` and dispatched but require HTTP mode (`webhookStore` non-null). See §8 for the full webhook subsystem.

**Tool 14 — `subscribe_events`** — desc lists supported events (mint, burn, large_transfer, challenge_start, challenge_bid, challenge_end, depeg, depeg_resolved, fps_large_trade, minter_proposed, minter_approved, position_proposed, rate_change, supply_change). Required: `url`, `secret`, `events`. Optional: `min_amount`, `chain_id`, `address`. Dispatch splits comma-string events, builds `filters`, calls `webhookStore.create(...)`; on `!result.ok` throws `result.error`. **Note: public — no admin token required** (rate-limited + SSRF-guarded).

**Tool 15 — `unsubscribe_events`** — Required: `subscription_id`. Optional: `management_token`, `admin_token`. Authorized if valid admin token **or** matching per-subscription management token; else throws `"unauthorized"`.

**Tool 16 — `list_subscriptions`** — Required: `admin_token`. Calls `requireWebhookAdminToken` (throws if `WEBHOOK_ADMIN_TOKEN` unset/<32 chars, or mismatch). Optional `url` filter.

**Tool 17 — `get_webhook_status`** — Required: `admin_token`. Returns poller state, subscription counts by event, delivery stats + pending retries.

---

## 3. Upstream data sources

All fetches use the built-in global `fetch`. Base URLs and helpers in `src/api/helpers.js`.

| # | Source | Base URL | Auth | Timeout | Consumed by |
|---|--------|----------|------|---------|-------------|
| 1 | **Frankencoin REST** | `https://api.frankencoin.com` | none | 10 s (`apiFetch`) | snapshot, market, savings, positions, challenges, collaterals, poller |
| 2 | **Ponder GraphQL** | `https://ponder.frankencoin.com` (POST `{query}`) | none | 15 s (`ponderQuery`) | governance, positions, challenges, analytics, query_ponder, poller |
| 3 | **CoinGecko Pro** | `https://pro-api.coingecko.com/api/v3` | header `x-cg-pro-api-key: <CG_KEY>` | 10 s (`cgFetch`) | market (**required**), positions (optional), challenges (optional), poller (depeg) |
| 4 | **Dune Analytics** | `https://api.dune.com/api/v1` | header `x-dune-api-key: <DUNE_KEY>` | 10 s per HTTP call; polls up to 12×2.5 s | get_dune_stats (**required**), governance holders (optional) |
| 5 | **Ethereum RPC** | `https://eth.llamarpc.com` (POST `eth_call`) | none | 8 s (`ethCall`) | market (CHFAU `totalSupply()`) |
| 6 | **GitHub Contents API** | `https://api.github.com/repos/<repo>/contents/<path>` | none (unauthenticated; `User-Agent: frankencoin-mcp`) | 10 s (`githubFile`) | knowledge, news |
| 7 | **Merch (Shopify)** | `https://merch.frankencoin.com/products.json?limit=250` | none | 10 s (direct fetch) | get_merch |

### 3.1 Frankencoin REST endpoints used

| Endpoint | Function |
|----------|----------|
| `/ecosystem/frankencoin/info` | snapshot, poller |
| `/ecosystem/fps/info` | snapshot |
| `/prices/list` | market, positions(detail), challenges |
| `/savings/leadrate/info` | savings |
| `/savings/core/info` | savings |
| `/ecosystem/collateral/list` | collaterals, positions(detail) |
| `/challenges/list` | challenges |
| `/positions/open` | positions(list) |

### 3.2 GitHub repos + files

- **`Frankencoin-ZCHF/gitbook`** (`DOCS_REPO`): markdown docs — `README.md`, `savings.md`, `pool-shares.md`, `governance.md`, `reserve.md`, `risks.md`, `faq.md`, `positions/README.md`, `positions/open.md`, `positions/auctions.md`, `api-docs/README.md`.
- **`Frankencoin-ZCHF/frankencoin-site`** (`SITE_REPO`): JSON content — `src/content/en/token.json`, `src/content/en/shared/footer.json`, `src/content/en/exchanges.json`, `src/content/en/use-cases.json`, `src/content/shared/media.json`, `src/content/en/ecosystem.json`.

### 3.3 Ponder GraphQL — entities & selected fields

- `mintingHubV2PositionV2s` — `position owner collateral collateralSymbol collateralBalance collateralDecimals minted availableForMinting price cooldown expiration start closed denied isOriginal isClone minimumCollateral riskPremiumPPM reserveContribution challengePeriod` (+ `pageInfo{hasNextPage endCursor}`). Poller subset: `position owner collateral collateralSymbol minted start closed denied`.
- `mintingHubV1PositionV1s` — `position collateral collateralSymbol collateralDecimals collateralBalance minted price annualInterestPPM owner`.
- `mintingHubV2ChallengeV2s` (poller only) — `position number challenger status bids size filledSize acquiredCollateral liqPrice start duration txHash`.
- `equityTrades` — `kind count trader amount shares price created txHash`.
- `analyticDailyLogs` — `date totalSupply totalEquity totalSavings fpsTotalSupply fpsPrice currentLeadRate annualV1BorrowRate annualV2BorrowRate projectedInterests annualNetEarnings realizedNetEarnings earningsPerFPS totalMintedV1 totalMintedV2 totalInflow totalOutflow totalTradeFee`.
- `frankencoinMinters` — `chainId txHash minter applicationPeriod applicationFee applyMessage applyDate suggestor denyMessage denyDate denyTxHash vetor`.
- `leadrateRateChangeds` — `chainId module approvedRate created blockheight txHash`.
- (query_ponder advertises but code doesn't itself query: `mintingHubV1ChallengeV1s`, `savingsActivity`, `savingsMappings`, `eRC20Balances`, `eRC20TotalSupplys`, `frankencoinProfitLosss`, `equityTradeCharts`.)

Pagination: list queries return `{items:[...], pageInfo:{hasNextPage, endCursor}}`. Ponder entities have **no `id` field** — use entity primary key.

### 3.4 Dune query IDs

`zchfHolders:6712642, fpsHolders:6712643, mintingVolume:6712644, savingsDeposits:6712645, savingsTvl:6712646, liquidations:6712649, positionsOpened:6712650, crossChainSupply:6712648`. (Only `zchfHolders`, `fpsHolders`, `mintingVolume`, `savingsTvl` actually invoked.)

`duneExecute(queryId)` flow: POST `/query/<id>/execute` with body `{performance:"medium"}` → get `execution_id` → poll `/execution/<id>/results` up to **12 times, 2.5 s apart** (≈30 s wall) until `QUERY_STATE_COMPLETED` (returns `result.rows`) or `QUERY_STATE_FAILED` (throws) → else `"Dune query timed out"`.

### 3.5 CoinGecko token ID map (`COINGECKO_IDS`)

Maps 14 Ethereum collateral contract addresses → CoinGecko IDs (WETH→`weth`, LsETH→`liquid-staked-ethereum`, WBTC→`wrapped-bitcoin`, UNI→`uniswap`, GNO→`gnosis`, wstETH→`wrapped-steth`, cbBTC→`coinbase-wrapped-btc`, CRV→`curve-dao-token`, PAXG→`pax-gold`, XAUt→`tether-gold`, VNX Franc→`vnx-franc`, SP500→`spdr-sp-500-etf-ondo`, AAPL→`apple-tokenized-stock-defichain`). **FPS is deliberately absent** (not on CoinGecko).

### 3.6 Secret handling & absence behavior

- **`CG_KEY`** = `process.env.COINGECKO_API_KEY` || file `~/.config/coingecko/api_key` (trimmed). `CG_BASE = https://pro-api.coingecko.com/api/v3`.
  - `cgFetch` throws `"CoinGecko API key not configured on server"` if unset.
  - **`get_market_data` hard-fails** without it. **positions(detail)/challenges** skip enrichment gracefully (try/catch → `{}`). **Poller** depeg batch fails softly (counted as consecutive CG error).
- **`DUNE_KEY`** = `process.env.DUNE_API_KEY` || file `~/.config/dune/api_key`.
  - `duneExecute` throws `"Dune API key not configured on server"` if unset.
  - **`get_dune_stats` hard-fails** without it. **governance holders** returns a soft `{note:...}`.
- Keys are **never** echoed into any tool output.

**Observations for rewrite:** file-based key fallback reads from the *server user's* home dir (`os.homedir()`), a deploy-environment coupling. No caching layer of any kind — every tool call re-fetches all upstreams. Dune's synchronous execute-then-poll (up to ~30 s) makes `get_dune_stats`/`get_governance?type=holders` very slow and blocks the request. CoinGecko Pro base is hard-coded even though a free key would need a different host.

---

## 4. Data transforms & encoding

### 4.1 Number helpers (`helpers.js`)

- `fromWei(val, decimals=18)` → `val` falsy/`"0"` → `0`; else `Number(BigInt(val)) / 10**decimals`. **Precision caveat:** `Number(BigInt(...))` can lose precision for very large values before dividing.
- `bpsToPercent(bps)` → `bps / 10000`. (Rates stored as basis-points×10, so `37500 → 3.75`.)
- `ppmToPercent(ppm)` → `ppm / 10000`. (Risk premiums/interest in PPM; `10000 ppm → 1.0` — i.e. treated as bps-scale, **not** literal ppm/1e6.)

### 4.2 Decimals handling

- Token amounts default 18 decimals.
- Positions/challenges use **authoritative decimals from `/ecosystem/collateral/list`**, falling back to the Ponder entity's `collateralDecimals`, then 18 (position entity can be stale per code comment).
- **Liquidation price** decoded with `36 - decimals` (Ponder stores price scaled to 36 total decimals).
- CHFAU on-chain `totalSupply()` divided by `1e6` (6 decimals).

### 4.3 Peg calculation

- `pegDeviationPercent = (priceChf - 1) * 100`.
- `pegStatus`: `|dev| < 0.5%` → `healthy`; `< 1.0%` → `warning`; else `critical`; null price → `unknown`. (Implemented twice: helper `pegStatus()` for stablecoin table, and inline for the top-level `zchf` block.)

### 4.4 Two savings modules & max-rate selection

- Ethereum has two rate modules: the **savings/lead rate** module (rate `> 10000` bps×10, ≈3.75%) and the **base/pending rate** module (`=== 10000`, ≈1%).
- Snapshot picks lead vs base by that `rateBps` threshold on `chainId===1`. Per CLAUDE.md, "the" savings rate should be the max (savings module).

### 4.5 Per-chain aggregation

- Snapshot `chains[]`: `sharePercent = supply/totalSupply*100` (1dp).
- Poller `supply_change`: tracks per-chain supply and a synthetic **"All Chains"** total (`chain_id:null`), emitting when |Δ| ≥ 10 000.

### 4.6 Rate limiting (HTTP mode only, in-memory per-IP)

- Config (env): `RATE_LIMIT_WINDOW_MS` (default 60000), `RATE_LIMIT_MAX` (general, default 120), `RATE_LIMIT_WEBHOOK_MAX` (default 10). `MAX_BODY_BYTES` = 64 KB (hard-coded).
- Client IP: first `X-Forwarded-For` entry if present, else `req.socket.remoteAddress`, else `"unknown"`.
- Buckets `Map<ipKey,{count,resetAt}>`; window rolls when `resetAt < now`. Webhook mutations/management tools use a **separate bucket key** (`ip + ":wh"`) and the tighter limit.
- Which requests are "webhook-mutation" rate class: `POST`/`DELETE` under `/webhooks/`, **or** a REST call to a webhook-management tool.
- Response headers on every request: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (unix seconds). Over limit → `429` + `Retry-After` (seconds) + `{"ok":false,"error":"Rate limit exceeded. Please slow down."}`.
- Stale buckets pruned every 5 min via `setInterval(...).unref()`.

### 4.7 Caching

- **There is no caching anywhere.** No in-memory TTL cache, no ETag reuse, no memoization. Every tool invocation performs all its upstream fetches fresh. (The only stateful in-memory maps are the rate-limit buckets, MCP/SSE session maps, and the webhook poller/subscription state.)

**Observations for rewrite:** absence of caching + synchronous Dune polling means some tools are slow and every hit is amplified to many upstream calls. Rate limiter is per-process (won't hold across multiple instances). `X-Forwarded-For` is trusted unconditionally (spoofable if not strictly behind a trusted proxy).

---

## 5. Config / environment variables

| Var | Default | Read in | Effect |
|-----|---------|---------|--------|
| `PORT` | `3000` | index.js | HTTP listen port. |
| `COINGECKO_API_KEY` | (file `~/.config/coingecko/api_key`) | helpers.js | CoinGecko Pro auth. Absent → market_data fails; enrichment/poller-depeg degrade. |
| `DUNE_API_KEY` | (file `~/.config/dune/api_key`) | helpers.js | Dune auth. Absent → dune_stats fails; governance holders soft-noted. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | index.js | Rate-limit window. |
| `RATE_LIMIT_MAX` | `120` | index.js | General req/window/IP. |
| `RATE_LIMIT_WEBHOOK_MAX` | `10` | index.js | Webhook-mutation req/window/IP. |
| `NO_COLOR` | (unset) | cli.js | Disables ANSI colours (also off when stdout not TTY). |
| **`WEBHOOK_ADMIN_TOKEN`** | (unset) | webhooks/auth.js | Admin token for webhook management. Must be **≥32 chars** or management is 503/unavailable. **BEING REMOVED.** |
| **`WEBHOOK_DATA_DIR`** | `/data` then `./data` | webhooks/subscriptions.js | Subscription persistence dir (first writable of `[WEBHOOK_DATA_DIR, /data, cwd/data]`). **BEING REMOVED.** |
| **`WEBHOOK_ALLOWED_HOSTS`** | (empty) | webhooks/urlSafety.js | Comma-separated exact hostnames exempt from SSRF blocking. **BEING REMOVED.** |
| **`WEBHOOK_ALLOW_INSECURE_LOCALHOST`** | (unset) | webhooks/urlSafety.js | If `"true"`, allow `http://` to localhost/127.0.0.1/::1 (dev). **BEING REMOVED.** |

There is **no** `.env` loader (no dotenv); env comes from the process environment. No auth on data tools/transports (public read-only, per CLAUDE.md).

---

## 6. Cross-cutting behavior

### 6.1 Error handling
- **Handlers** throw `Error` on upstream non-2xx (`Frankencoin API error <status>: <path>`, `Ponder error <status>`, `CoinGecko error <status>`, `ETH RPC error: <status>`, `GitHub <status>: <repo>/<path>`, `Merch store error <status>`). Ponder GraphQL-level errors throw `json.errors[0].message`.
- **Optional enrichment** (CoinGecko in positions/challenges; per-position lookups in challenges) is wrapped in try/catch — non-fatal, degrades to nulls.
- **MCP layer**: handler throw → `{content:[{text:"Error: <msg>"}],isError:true}`. **REST layer**: maps message substrings to 400/401/500.
- `Promise.allSettled` used for multi-Dune fan-out (governance holders, dune_stats), CoinGecko `/global`, CHFAU eth_call — partial failures yield `null` fields rather than whole-tool failure.

### 6.2 Timeouts (upstream)
Every helper sets `AbortSignal.timeout(...)`: `apiFetch` 10 s, `ponderQuery` 15 s, `cgFetch` 10 s, `duneExecute` 10 s/call, `ethCall` 8 s, `githubFile` 10 s, merch direct fetch 10 s. **Webhook delivery** uses a 5 s socket timeout (see §8).

### 6.3 Retry logic
- **No retries on inbound tool upstream fetches** (a timeout/error just fails or degrades).
- Dune has a poll loop (not a retry — waiting for async execution).
- **Webhook delivery** retries with backoff `[10s, 30s, 90s]` (see §8). **BEING REMOVED.**

### 6.4 Logging
- All logs go to **stderr** via `console.error` (and a few `console.log`/`console.warn` in webhooks). stdout is reserved for the stdio MCP transport / CLI output. Notable lines: `[session] new/closed`, `[/api/<tool>] ok|error`, `[/mcp error]`, poller/webhook `[poller]`/`[webhook…]` lines.

### 6.5 Graceful shutdown (HTTP mode)
- `SIGTERM`/`SIGINT` → `gracefulShutdown`: `stopPoller()`, `httpServer.close()` (then `webhookStore.destroy()` and `process.exit(0)`), plus a **10 s force-exit** `setTimeout(...).unref()` → `exit(1)` if in-flight requests hang.

### 6.6 CORS
- On every HTTP response: `Access-Control-Allow-Origin: *`, `Allow-Methods: GET, POST, DELETE, OPTIONS`, `Allow-Headers: Content-Type, Accept, mcp-session-id, Authorization, X-Webhook-Admin-Token`, `Expose-Headers: mcp-session-id`. `OPTIONS` → `204`.

### 6.7 Content types
- REST/health/webhooks respond `application/json`. Success REST + health + webhook bodies are **pretty-printed** (2-space); REST *error* bodies are compact. MCP tool payloads are pretty-printed JSON inside a text content block.

### 6.8 CLI (`src/cli.js`) — `frankencoin` bin
- Independent of the server; imports `api.js` directly (data tools only — no webhook commands).
- Commands (13): `snapshot, market, savings, governance, positions, challenges, collaterals, analytics, knowledge, news, merch, dune, ponder`.
- Flag parser: `--key value` or boolean `--key`; positionals in `_`. Global `--json` prints raw `JSON.stringify(...,2)`; `--help` prints general or per-command help. Colour via ANSI unless `NO_COLOR`/non-TTY. Human formatters `fmtNum`, `fmtM` (millions). Errors → red message + `exit(1)`. `ponder` takes the GraphQL string as the first positional (required).

---

## 7. Observations for rewrite (consolidated, factual)

- **No caching** anywhere → high upstream amplification; slow tools (`get_dune_stats`, `get_governance?type=holders`, `get_market_data`).
- **Dune** blocks up to ~30 s synchronously.
- **REST error status** derived by string-matching `e.message` (`"required"`→400, `"unauthorized"`→401).
- **`query_ponder`** forwards arbitrary GraphQL to the indexer with no validation (indexer is public read-only, but no depth/complexity limits from this server).
- **`change24hPercent`** is inconsistently typed: a **string** (`toFixed(2)`) in positions/challenges collateral, a **number** elsewhere.
- **`get_collaterals`** returns a bare array; every other tool returns an object — inconsistent envelope.
- **Rate limiter & sessions** are per-process (no shared store) → not horizontally scalable as-is.
- **`X-Forwarded-For`** trusted unconditionally.
- **Precision**: `fromWei` goes through `Number(BigInt)` before dividing — lossy for very large raw values.
- **`days` param** does not actually window `rate_history`/rateHistory (always `limit:100`).
- **Two `pegStatus` implementations** (helper + inline) that must stay in sync.
- **API keys** can be sourced from files in the server user's home dir — environment coupling.
- **Health/root** advertises "17 tools (13 data + 4 webhook)"; rewrite dropping webhooks should reduce to 13.

---

## 8. Webhook subsystem — **BEING REMOVED — for reference only**

> This entire section documents functionality slated for deletion in the rewrite. Recorded so nothing is lost. Files: `src/webhooks/*` + `src/webhooks/tests/*`.

### 8.1 Overview
An in-process event system that (in HTTP mode) polls upstreams every 60 s, diffs state, and delivers detected events to subscriber webhook URLs via signed HTTP POST. Subscriptions persist to disk. Started from `index.js` after `listen` (`startPoller`), stopped on shutdown; store `destroy()`ed on shutdown.

### 8.2 HTTP routes (`/webhooks/*`, handled by `routes.js`)

| Path | Method | Auth | Behavior |
|------|--------|------|----------|
| `/webhooks/events` | GET | public | `{ok:true, event_types:[{event_type, applicable_filters:{min_amount,chain_id,address}, default_threshold}]}`. |
| `/webhooks/subscribe` | POST | **public** | Body `{url, secret, events(str/array), filters}`. Creates subscription. Returns `store.create` result with `status` (201/400/429). |
| `/webhooks/subscriptions/:id` | DELETE | admin **or** management-token | Deletes; 401 if unauthorized, 404 if missing. |
| `/webhooks/subscriptions/:id/test` | POST | admin **or** management-token | Sends a synthetic `test` event (single-shot, no retries); returns `{ok, delivered, status_code, response_time_ms, error?}`. |
| `/webhooks/subscriptions` | GET | admin only | Lists subscriptions (optional `?url=` filter). |
| `/webhooks/status` | GET | admin only | Poller + subscription + delivery stats. |
| (other) | any | — | 404 with `available[]` list. |

Admin auth (`auth.js`): `WEBHOOK_ADMIN_TOKEN` (must be ≥32 chars, else `503 "webhook management is unavailable"`); accepted via `Authorization: Bearer` or `X-Webhook-Admin-Token`; constant-time compare. Management token accepted via `X-Webhook-Management-Token` or bearer.

The same four operations are also exposed as **MCP/REST tools** (14–17); those tools require POST/PUT over REST and inject tokens from headers/body (§1.5).

### 8.3 Event types (14) & thresholds (`events.js`)
`mint, burn, large_transfer, challenge_start, challenge_bid, challenge_end, depeg, depeg_resolved, fps_large_trade, minter_proposed, minter_approved, position_proposed, rate_change, supply_change`. (Plus a synthetic `test` event used only by the test endpoint.)

Default thresholds: `mint:0, burn:0, large_transfer:0 (deferred), fps_large_trade:1000, supply_change:10000`.

Filter applicability:
- `min_amount`: mint, burn, large_transfer, fps_large_trade, supply_change.
- `chain_id`: all except depeg/depeg_resolved.
- `address`: mint, burn, challenge_start/bid/end, fps_large_trade, minter_proposed/approved, position_proposed.

`buildEvent(type,data,source,version)` → `{id:"evt_"+8-byte-hex, event_type, timestamp(ISO), data, source, server_version}`. `matchesFilters` applies min_amount (`< → drop`), chain_id (exact), address (case-insensitive membership) only where applicable.

### 8.4 Poller (`poller.js`)
- `POLL_INTERVAL = 60 s`; first poll establishes a **baseline** (captures state, emits nothing). `isPolling`/`shutdownRequested` guards prevent overlap.
- Three parallel batches via `Promise.allSettled`, each tracking `consecutive*Errors`:
  1. **Ponder** — one combined query (`positions` limit100, `challenges` limit50, `trades` limit20, `minters` limit50, `rates` limit20). Diffs:
     - Positions: new position with `minted==0 && start>now && !closed && !denied` → `position_proposed`; new with `minted>0` → `mint`; `minted>prev` → `mint`(delta); `minted<prev` → `burn`(delta). All assumed **chain 1** (V2 positions have no chainId; `tx_hash` always null).
     - Challenges (key `position_number`): new → `challenge_start`; `bids` increased → `challenge_bid` (bidder/amount null — not exposed by Ponder); status transition to `Success`/`Averted` → `challenge_end`.
     - Trades: by `count` high-water-mark; new trades with `amount ≥ 1000` → `fps_large_trade`.
     - Minters: new & not denied → `minter_proposed`; past `applyDate+applicationPeriod` & not denied & not already emitted → `minter_approved` (tracked in `approvedEmitted`).
     - Rates: `created > lastRateCreated` → `rate_change` (old/new percent = approvedRate/10000).
  2. **API** — `/ecosystem/frankencoin/info`; per-chain supply diff + synthetic all-chains total; emit `supply_change` when |Δ| ≥ 10 000.
  3. **CoinGecko** — `/simple/price?ids=frankencoin&vs_currencies=chf`; depeg state machine: trigger `depeg` when `|price-1| > 0.005` (0.5%); `depeg_resolved` when back within `0.003` (0.3%).
- `getPollerStatus()` → `{running, initialized, lastPollAt, consecutiveErrors:{ponder,coingecko,api}}`.

### 8.5 Subscription store (`subscriptions.js`)
- File-backed at first writable of `[WEBHOOK_DATA_DIR, /data, cwd/data]` → `subscriptions.json` (atomic write via `.tmp` + rename); if none writable → in-memory only (warns).
- Caps: `MAX_SUBSCRIPTIONS=100`, `MAX_PER_URL=5`, `TTL_MS=7 days`, `MAX_CONSECUTIVE_FAILURES=10` (auto-delete). Expiry swept every 60 s (unref timer) + on access.
- `create({url,secret,events,filters})`: SSRF-validate URL (sync), require `secret` ≥32 chars, non-empty events (`["*"]` expands to all types), validate each event type, enforce caps. Stores `secretHash`(sha256) **and `secretRaw`** (needed for HMAC signing) + `managementTokenHash`(sha256 of `whsec_`+24-byte-hex). Returns public view **including the one-time management token**.
- Public view (`_toPublic`) hides secrets: `{id,url,events,filters,created_at,expires_at,delivery_stats:{total_delivered,total_failed,last_delivered_at,last_status_code,consecutive_failures}}`.
- `getMatching(type,data)` selects subs whose events include type (or `*`) and pass filters. `recordSuccess/recordFailure` update stats; failure ≥10 consecutive auto-deletes. `getDeliveryStats`, `getEventCounts`.

### 8.6 Delivery (`delivery.js`)
- Per event → `resolveSafeWebhookTarget(url)` (re-validates + DNS-pins a safe address). Body = `JSON.stringify(event)`. HMAC-SHA256 hex over body with `secretRaw`.
- Headers: `Content-Type`, `User-Agent: frankencoin-mcp/<ver>`, `X-Frankencoin-Signature: sha256=<hmac>`, `X-Frankencoin-Event`, `X-Frankencoin-Delivery` (event id), `X-Frankencoin-Timestamp` (unix s).
- Uses raw `node:http`/`https` with `agent:false`, 5 s socket timeout, DNS `lookup` pinned to the pre-resolved safe address (anti-rebinding). **Redirects not followed.** 2xx = success; else retry.
- Retries `[10s,30s,90s]` (test deliveries: single-shot, `maxRetries=0`). `pendingRetries` counter for status. Exhausted → `recordFailure` + dead-letter log line. `dispatchToSubscribers` fans out in parallel, fire-and-forget.

### 8.7 URL safety / SSRF guard (`urlSafety.js`)
- `parseWebhookUrl`: ≤2048 chars, must be `https:` (or http+localhost if `WEBHOOK_ALLOW_INSECURE_LOCALHOST=true`), no credentials, hostname required.
- Blocks hostnames: `localhost`, `ip6-localhost/loopback`, suffixes `.local .localhost .localdomain .home.arpa .internal .intranet .lan .corp .consul`.
- Blocks IPs: IPv4 `0/8, 10/8, 127/8, 169.254/16, 172.16-31, 192.168/16, 100.64-127 (CGNAT), ≥224`; IPv6 `::, ::1, fc00::/7, fe80::/10, ff00::/8`, and IPv4-mapped equivalents.
- Exceptions: exact hostnames in `WEBHOOK_ALLOWED_HOSTS`; `*.ts.net` (Tailscale Funnel) allowed to resolve to CGNAT by hostname. Pre-delivery `dns.lookup(all,verbatim)` re-checks every resolved address and pins the first safe one.

### 8.8 Tests
`src/webhooks/tests/{delivery,events,poller,routes,subscriptions}.test.js` — `node --test` unit tests (`npm test` runs them). The only automated tests in the repo; all cover the to-be-removed subsystem.

---

*End of specification.*
