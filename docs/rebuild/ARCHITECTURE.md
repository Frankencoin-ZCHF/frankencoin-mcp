# Frankencoin MCP Server — Rewrite Architecture

> **Status:** Design document for the from-scratch rewrite. Design only — no implementation code.
> **Scope:** Replaces `src/` in the same repo. Keeps the 13 data tools and the same external surface
> (MCP Streamable HTTP + legacy SSE, REST `/api/<tool>`, `/health`). Drops the entire webhook subsystem.
> **Non-negotiables honored:** Node.js ESM, **no build step**, runs via `node src/index.js`, fully stateless,
> zero required Railway config, secrets optional/degradable. Deps stay at `@modelcontextprotocol/sdk` + `zod`.

The three pillars of the rewrite are **efficiency** (an in-memory TTL cache + coalescing + bounded fan-out —
today there is *zero* caching and every call re-fetches all upstreams), **cleanliness** (one dispatch path
shared by MCP and REST; per-domain services; per-source upstream clients), and **security by design**
(a validated `query_ponder`, proxy-aware rate limiting, typed errors that never leak secrets).

---

## A. Module / file layout

Dependency direction is strictly **downward** (a file may import only from layers below it). No cycles.

```
src/
  index.js                 — Entrypoint. Parse `--http`; start stdio OR http; wire SIGTERM/SIGINT. ~40 lines.
  config.js                — Read env ONCE, apply defaults, Object.freeze, export `config`. Nothing required to boot.

  lib/                     — Pure, dependency-free helpers (no I/O, no upstream, no config except where noted).
    numbers.js             — fromWei, bpsToPercent, ppmToPercent, pegDeviation, pegStatus. THE single source for peg logic.
    envelope.js            — ok()/err() response shaping for REST + MCP text-content wrapping.
    errors.js              — Typed error classes + toClientMessage()/toHttpStatus(). No string-sniffing.
    concurrency.js         — mapLimit(items, n, fn): bounded parallel fan-out. Semaphore primitive.
    constants.js           — CHAIN_NAMES, COINGECKO_IDS, DUNE_QUERIES, CHFAU_CONTRACT, ZCHF/FPS addresses, DOC_FILES map.

  cache.js                 — In-memory TTL cache: get/getOrLoad, single-flight, LRU bound, optional SWR. (§B)

  upstream/                — One client per data source. ONLY layer that calls fetch(). Returns parsed JSON or throws typed errors.
    client.js              — fetchJson(url, {source, timeout, retries, method, body, headers}). Timeout+retry+concurrency cap+keep-alive. (§C)
    frankencoin.js         — apiFetch(path): REST api.frankencoin.com. Cached.
    ponder.js              — ponderQuery(query): GraphQL POST. Cached. Exposes validateGraphql() used by the ponder service. (§F)
    coingecko.js           — cgFetch(path): degradable (throws MissingSecretError if no key). Cached.
    dune.js                — duneExecute(queryId): execute+poll. Degradable. Cached (long TTL).
    eth.js                 — ethCall(to, data): JSON-RPC eth_call. Cached.
    github.js              — githubFile/githubJson(repo, path): unauth Contents API. Cached (very long TTL + SWR).
    merch.js               — merchProducts(): Shopify products.json. Cached.

  services/                — Per-domain business logic. Compose upstream clients, apply number transforms, shape output.
    snapshot.js            — getProtocolSnapshot()                          (Tool 1)
    market.js              — getMarketData()                                (Tool 2)
    savings.js             — getSavings()                                   (Tool 3)
    governance.js          — getGovernance({type,status,limit})             (Tool 4)
    positions.js           — getPositions(), getChallenges(), getCollaterals()  (Tools 5,6,7 — share upstreams)
    analytics.js           — getAnalytics({type,days,limit}), getDuneStats()    (Tools 8,12)
    content.js             — getKnowledge({topic}), getNews(), getMerch()   (Tools 9,10,11)
    ponder.js              — runPonderQuery(query): validate → ponderQuery  (Tool 13)

  tools/
    registry.js            — The 13 tool definitions: {name, description, input: <zod shape>, handler: <service fn>}.
    dispatch.js            — dispatchTool(name, rawArgs): lookup → zod validate/coerce/clamp → handler → data. ONE path.

  server/
    mcp.js                 — createMcpServer(): build McpServer, register 13 tools from registry, delegate to dispatch.js.
    http.js                — node:http server: CORS, security headers, URL guard, routing, body read, REST + /health + /api index.
    sessions.js            — MCP Streamable session Map + SSE session Map + init lock. Owns createMcpServer() lifecycle.
    rateLimit.js           — Proxy-aware per-IP token bucket. (§F)

  cli.js                   — `frankencoin` CLI. Imports services directly (no server, no webhooks). 13 commands.

test/                      — node:test suites, mirrors src/. (§H)
```

### Layering (import rules)

```
index.js → config, server/*, lib/errors
server/http.js → server/{sessions,rateLimit,mcp}, tools/dispatch, lib/{envelope,errors}, config
server/mcp.js → tools/{registry,dispatch}, lib/envelope
tools/dispatch.js → tools/registry, lib/{errors,envelope}
tools/registry.js → services/*, zod
services/* → upstream/*, lib/{numbers,errors,concurrency,constants}, cache, config
upstream/* → cache, config, lib/errors, lib/constants
cache.js, lib/* → (nothing above lib) 
cli.js → services/*, lib/numbers
```

**Rationale.** Services never touch `fetch` (that is upstream's job) and never touch transports. Transports never
touch upstreams. Caching lives at the upstream boundary so a single `/prices/list` fetch is shared by snapshot,
market, positions, and challenges. `dispatch.js` is the sole place clamps/validation happen, so MCP and REST are identical.

---

## B. Caching layer (`cache.js`) — the headline efficiency win

**Where:** caching is applied at the **upstream-client boundary**, keyed by the concrete request (URL / GraphQL
query / RPC call). Not at the service level — because the win comes from *cross-tool* sharing of the same upstream
fetch (e.g. four tools all pull `/prices/list`), and upstream keys are naturally parameter-stable. Services stay
pure and always see fresh-enough data.

### Data structure

A single module-level `Map<string, Entry>` with LRU eviction. Each entry:

```
Entry = {
  value,          // resolved JSON (undefined while first load in flight)
  expiresAt,      // ms epoch; fresh if now < expiresAt
  staleUntil,     // ms epoch; only for SWR sources — serve stale until here while revalidating
  inflight,       // Promise | null — single-flight guard
  lastUsed        // ms epoch — for LRU
}
```

### API

- `getOrLoad(key, ttlMs, loader, { swrMs = 0 } = {})` — the only method services/clients use.
  1. Fresh hit (`now < expiresAt`) → return `value`.
  2. In-flight (`inflight != null`) → **await the existing promise** (request coalescing / single-flight). Concurrent
     identical upstream calls collapse to one.
  3. SWR stale (`now < staleUntil`) → return stale `value` immediately **and** kick off a background revalidation
     (sets `inflight`, does not block the caller). Background failure keeps the stale value and logs to stderr.
  4. Miss/expired → set `inflight = loader()`; on success store `value/expiresAt/staleUntil`, clear `inflight`;
     on failure clear `inflight` and propagate (do **not** cache errors).
- `invalidate(key)`, `clear()` — used only by tests.

### Single-flight / coalescing
Step 2 above. Guarantees that N concurrent tool calls that each need `/prices/list` produce exactly **one** outbound
fetch. This is the biggest amplification fix beyond TTL itself.

### Bounds / memory
- `CACHE_MAX_ENTRIES` (default **500**). On insert past the cap, evict least-recently-used entries. Values are small
  JSON blobs; 500 entries is a few MB worst case. No time-based sweeper needed — LRU + natural expiry suffice, but a
  lazy purge of expired-and-not-SWR entries runs opportunistically on each `getOrLoad` miss to keep the map tidy.
- No serialization, no external store. **Redis explicitly out of scope.**

### Cache key strategy
`"<source>:<discriminator>"`:
- REST: `fc:/prices/list`
- Ponder: `ponder:<sha1(query)>` (query text hashed; hashing keeps keys short and avoids storing huge strings)
- CoinGecko: `cg:<path>` (path already includes the querystring)
- Dune: `dune:<queryId>`
- eth_call: `eth:<to>:<data>`
- GitHub: `gh:<repo>/<path>`
- Merch: `merch:products`

### Interaction with stateless Railway model
The cache is **per-process, in-memory, non-authoritative**. It is wiped on every restart/redeploy — acceptable because
it is a pure latency/amplification optimization, never a source of truth. Multiple replicas (if ever scaled) each keep
their own cache with no coordination required; worst case is a slightly higher cold-miss rate. This preserves "safe to
restart at any time." Cache TTLs are short enough (see table) that staleness after a warm process is bounded.

### TTL table (per source — justified)

| Source / logical data | Key prefix | TTL | SWR window | Justification |
|---|---|---|---|---|
| Frankencoin REST — protocol/fps info, savings, positions/open, challenges/list | `fc:` | **30 s** | — | Near-real-time protocol state; 30 s bounds staleness while collapsing bursts. |
| Frankencoin REST — `/prices/list` | `fc:` | **30 s** | — | Shared by 4 tools; short TTL keeps prices live, coalescing removes duplication. |
| Frankencoin REST — `/ecosystem/collateral/list` | `fc:` | **1 h** | 15 min | Accepted-collateral set changes rarely (governance action). Long TTL, SWR so it's never on the hot path. |
| Ponder GraphQL — positions/challenges/analytics/governance | `ponder:` | **45 s** | — | Indexer itself lags chain by seconds; 45 s is invisible to users, big amplification cut on fan-out. |
| Ponder GraphQL — `query_ponder` (user queries) | `ponder:` | **20 s** | — | Arbitrary user queries; short TTL still dedupes identical repeated queries without masking updates. |
| CoinGecko — simple/price (ZCHF, macro, collateral) | `cg:` | **60 s** | — | Rate-limited paid API; 60 s respects quota and is plenty fresh for a peg/market view. |
| CoinGecko — `/global`, `/coins/markets` | `cg:` | **120 s** | — | Macro/aggregate data moves slowly; protect quota harder. |
| Dune — query results | `dune:` | **30 min** | 30 min | Dune is delayed by design and each execute costs ~30 s wall + credits. Long TTL + SWR = never block a user. |
| Ethereum RPC — CHFAU `totalSupply()` | `eth:` | **5 min** | — | Supply changes infrequently; public RPC is best-effort. |
| GitHub content — docs (knowledge) | `gh:` | **6 h** | 6 h | Docs/markdown change rarely; also dodges GitHub's 60-req/hr **unauth** limit. SWR = instant serves. |
| GitHub content — site JSON (news, links, token addresses) | `gh:` | **6 h** | 6 h | Same as docs. |
| Merch — Shopify products | `merch:` | **30 min** | 15 min | Store catalog is not time-critical; 30 min is generous, SWR keeps it snappy. |

> **SWR vs hard TTL.** Default is **hard TTL** (simple, correct). SWR is enabled only for the long-TTL, slow, or
> quota-sensitive sources (collateral list, Dune, GitHub, Merch) where a user should never eat the refetch latency.
> Hot, fast, live sources (REST info, prices, Ponder, CoinGecko price) use hard TTL — freshness matters more there.

---

## C. Upstream client layer (`upstream/`)

### `client.js` — the one fetch wrapper
`fetchJson(url, { source, timeout, retries = 2, method = "GET", body, headers, expectJson = true })`:

- **Keep-alive / agent reuse.** At module load, install a shared undici dispatcher:
  `setGlobalDispatcher(new Agent({ keepAliveTimeout: 30_000, keepAliveMaxTimeout: 60_000, connections: 64 }))`.
  Node's global `fetch` then reuses TCP/TLS connections across all outbound calls. (`undici` ships inside Node — no
  new dependency.)
- **Timeout** via `AbortSignal.timeout(timeout)`, per-source (see below).
- **Concurrency cap.** A module-level semaphore (`lib/concurrency`) caps total in-flight outbound fetches at
  `UPSTREAM_MAX_CONCURRENCY` (default **8**). Prevents a single fan-out tool from opening dozens of sockets.
- **Bounded retry with backoff**, only for **idempotent** requests (GET, or POST that we mark idempotent: Ponder
  query, eth_call, Dune execute). Retry on: network error, timeout, `5xx`, `429`. **Never** retry `4xx` (except 429).
  Backoff `[250 ms, 1000 ms]` + up to 250 ms jitter; honor `Retry-After` on 429. Max 2 retries.
- **Response size cap.** Read the body through a size guard; abort if it exceeds `UPSTREAM_MAX_BYTES` (default
  **8 MB**) → `UpstreamError`. Prevents a hostile/huge upstream response from exhausting memory.
- **Typed errors** (see `lib/errors.js`): `TimeoutError`, `UpstreamError{source,status}`, `RateLimitError`,
  `MissingSecretError`, `NotFoundError`. Never throws raw fetch errors upward.

### Per-source timeouts (unchanged from today — proven values)

| Client | Timeout | Retries | Idempotent? | Cached |
|---|---|---|---|---|
| `frankencoin.apiFetch` | 10 s | 2 | yes (GET) | yes |
| `ponder.ponderQuery` | 15 s | 2 | yes (POST-query) | yes |
| `coingecko.cgFetch` | 10 s | 2 | yes (GET) | yes |
| `dune.duneExecute` | 10 s/HTTP call, ~30 s poll wall | execute 1 retry; poll loop unchanged | yes | yes (30 min) |
| `eth.ethCall` | 8 s | 2 | yes | yes |
| `github.githubFile` | 10 s | 2 | yes | yes |
| `merch.merchProducts` | 10 s | 2 | yes | yes |

### Graceful secret degradation
- **Secrets are read once in `config.js`** from `process.env` only. ⚠️ **Behavior change:** the file-based fallback
  (`~/.config/coingecko/api_key`, `~/.config/dune/api_key`) is **removed** — it coupled behavior to the deploy user's
  home dir and is a footgun on Railway. Env vars only.
- `coingecko.js` / `dune.js` check `config.coingeckoKey` / `config.duneKey`. If absent they throw
  `MissingSecretError(source)` **without ever touching the network**.
- **Services catch `MissingSecretError` and degrade** rather than 500:
  - `get_market_data` → returns Frankencoin-API-sourced fields (prices/list, FPS, CHFAU on-chain) and sets
    CoinGecko-derived fields (`macro`, `change24hPercent`, `marketCapUsd`, CHF-stablecoin comparison) to `null` with a
    top-level `note: "CoinGecko API key not configured — market/macro fields unavailable"`.
    ⚠️ **Behavior change:** today this tool hard-fails with an error; now it degrades to partial data.
  - `get_dune_stats` → returns `{ note: "Dune API key not configured — on-chain analytics unavailable", holders:null, minting:null, savingsTvl:null }`.
    ⚠️ **Behavior change:** today it throws; now it returns a soft note (matches how `get_governance?type=holders`
    already behaves, unifying the two).
  - `get_governance?type=holders` → unchanged soft `{note:...}`.
  - Optional enrichment (positions/challenges CoinGecko) → unchanged: caught, degrades to `null` fields.
- **Nothing is required to boot.** Missing keys only downgrade the two dependent tools.

---

## D. Tool layer — one dispatch path for MCP + REST

### `tools/registry.js`
An array of 13 definitions. Each tool's input schema is a **zod object** (not raw JSON-Schema), so validation,
coercion, defaults, **and clamps live with the tool definition** — the exact opposite of today, where clamps live in
the dispatch switch. Example shape (illustrative, not code to copy verbatim):

```
{
  name: "get_analytics",
  description: "...",                         // same text as today (preserves client-visible descriptions)
  input: z.object({
    type: z.enum(["time_series","trades","minters","rate_history"]).default("time_series"),
    days: z.coerce.number().int().min(1).max(365).default(90),   // clamp expressed here, not in dispatch
    limit: z.coerce.number().int().min(1).max(100).default(20),
  }).strict(),                               // reject unknown params (see security)
  handler: services.getAnalytics,
}
```

- `z.coerce.*` handles REST string→number/boolean coercion uniformly (replaces the ad-hoc `Number(v)` /
  `v==="true"||v==="1"` logic in the current REST layer).
- Clamps that today live in dispatch (`Math.min(limit,100)`, `days ≤ 365`, positions' `detail`-dependent default) move
  into the schema. Where a default depends on another field (positions: `limit` default 50 for list / 20 for detail),
  the schema leaves `limit` optional and the **service** applies the conditional default — documented in the service,
  not scattered.
- MCP `inputSchema` (JSON-Schema, required by the SDK for `tools/list`) is derived from the zod object via
  `zod-to-json-schema`… **but** to avoid a new dependency we instead hand-maintain a tiny `toJsonSchema(zodShape)`
  in `registry.js` covering the primitives we use (string/number/boolean/enum + description + required). The zod
  object remains the single source of truth for validation.

### `tools/dispatch.js`
```
dispatchTool(name, rawArgs) →
  1. def = registry.get(name)           // unknown → NotFoundError (REST 404 / MCP isError)
  2. args = def.input.parse(rawArgs)    // zod: coerce + default + clamp + reject-unknown → ValidationError on fail
  3. data = await def.handler(args)     // pure service call
  4. return data                        // raw domain object; envelope applied by the caller
```
This single function is called by **both** `server/mcp.js` (wraps `data` in `ok()` text content) and `server/http.js`
(wraps in REST envelope). No logic duplication.

### Consistent output envelope (`lib/envelope.js`)
- **REST success:** `{ ok: true, tool, result: <data> }`, pretty-printed (2-space) — **including errors**
  (⚠️ **behavior change:** today REST error bodies are compact; now all bodies are consistently pretty).
- **REST error:** `{ ok: false, tool, error: <safe message>, code: <machine code> }`.
- **MCP success:** `{ content: [{ type:"text", text: JSON.stringify(data, null, 2) }] }` (unchanged).
- **MCP error:** `{ content: [{ type:"text", text: "Error: <safe message>" }], isError: true }` (unchanged).
- **Every tool returns an object.** ⚠️ **Behavior change:** `get_collaterals` now returns
  `{ collaterals: [...], count: N }` instead of a bare array — unifying the envelope. (Documented in migration notes.)
- ⚠️ **Behavior change:** `change24hPercent` is a **number** everywhere (positions/challenges collateral currently
  emit a `.toFixed(2)` **string**). Rounding to 2 dp is preserved as a numeric value.

---

## E. Config (`config.js`)

Read `process.env` exactly once at module load, apply defaults, `Object.freeze(config)`, export. **Nothing is
required to boot.**

| Env var | Default | Effect |
|---|---|---|
| `PORT` | `3000` | HTTP listen port (HTTP mode). |
| `COINGECKO_API_KEY` | `undefined` | CoinGecko Pro auth. Absent → `get_market_data` degrades, enrichment skipped. |
| `DUNE_API_KEY` | `undefined` | Dune auth. Absent → `get_dune_stats` + governance holders degrade to notes. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window. |
| `RATE_LIMIT_MAX` | `120` | Max requests / window / client. |
| `TRUST_PROXY_HOPS` | `1` | Number of trusted reverse-proxy hops for client-IP extraction (Railway edge = 1). See §F. |
| `MAX_BODY_BYTES` | `65536` | Max inbound request body (REST/MCP POST). Overflow → 413. |
| `UPSTREAM_MAX_CONCURRENCY` | `8` | Global cap on concurrent outbound fetches. |
| `UPSTREAM_MAX_BYTES` | `8388608` | Max upstream response body (8 MB) before abort. |
| `CACHE_MAX_ENTRIES` | `500` | LRU cap on the in-memory cache. |
| `CACHE_ENABLED` | `true` | Master switch (set `false` in tests that assert live-fetch behavior). |
| `PONDER_MAX_QUERY_BYTES` | `8192` | Max length of a `query_ponder` GraphQL string. |
| `PONDER_MAX_DEPTH` | `12` | Max selection-set nesting depth allowed in `query_ponder`. |
| `NO_COLOR` | `undefined` | CLI: disable ANSI (also off when stdout is not a TTY). |
| `LOG_LEVEL` | `info` | stderr verbosity: `error`\|`info`\|`debug`. |

Dropped env vars (webhooks): `WEBHOOK_ADMIN_TOKEN`, `WEBHOOK_DATA_DIR`, `WEBHOOK_ALLOWED_HOSTS`,
`WEBHOOK_ALLOW_INSECURE_LOCALHOST`, `RATE_LIMIT_WEBHOOK_MAX`. No `.env` loader (no dotenv) — Railway injects env directly.

---

## F. Security by design

Each defense is named with the module that owns it.

### 1. `query_ponder` — arbitrary GraphQL surface  → `upstream/ponder.js:validateGraphql()` + `services/ponder.js`
The riskiest tool. Defense in depth, **no new dependency** (a full `graphql` parse would be cleanest but is a heavy
dep; we implement a conservative structural validator and rely on the upstream being read-only). Reject the query
*before* it hits the network if any of:
- **Length** > `PONDER_MAX_QUERY_BYTES` (8 KB) → `ValidationError`.
- **Read-only enforcement:** the query text (comments stripped) contains a top-level `mutation` or `subscription`
  operation keyword → reject. Only anonymous `{...}` or `query`-operations allowed.
- **No introspection:** contains `__schema` / `__type` → reject (prevents schema-dumping / fingerprinting).
- **Depth limit:** brace-nesting depth > `PONDER_MAX_DEPTH` (12) → reject (bounds server-side query cost).
- **Root-field allowlist:** every top-level selection name must be in the documented entity allowlist
  (`mintingHubV2PositionV2s, mintingHubV1PositionV1s, mintingHubV2ChallengeV2s, mintingHubV1ChallengeV1s,
  equityTrades, analyticDailyLogs, savingsActivity, savingsMappings, frankencoinMinters, eRC20Balances,
  eRC20TotalSupplys, leadrateRateChangeds, frankencoinProfitLosss, equityTradeCharts`) → else reject. Extracted by
  scanning the outermost selection set.
- **Alias / operation-count cap:** at most 1 operation and ≤ 25 root selections → reject (prevents batch-amplification).
- **`limit:` argument cap:** any numeric `limit:` argument > 1000 is rejected (prevents mega-page extraction).
- **Cost containment at runtime:** the existing 15 s Ponder timeout + 8 MB response cap + result caching (20 s TTL)
  bound the blast radius of anything that slips through. The endpoint is itself public read-only, so the worst case is
  self-DoS, which the timeout/size/rate-limit stack already contains.

### 2. Rate limiting that doesn't blindly trust `X-Forwarded-For`  → `server/rateLimit.js`
⚠️ **Behavior change (security fix):** today the *first* `X-Forwarded-For` entry is trusted unconditionally
(spoofable). New rule: take the client IP as the **`(TRUST_PROXY_HOPS)`-th address from the right** of the XFF list
(i.e. the address the outermost trusted proxy saw), falling back to `req.socket.remoteAddress`. With Railway's single
edge hop (`TRUST_PROXY_HOPS=1`), this reads the real client IP and ignores client-supplied XFF prefixes. Single token
bucket per IP (`RATE_LIMIT_MAX`/window); the separate webhook bucket is deleted. Emits
`X-RateLimit-{Limit,Remaining,Reset}`; over-limit → `429` + `Retry-After` + `{ok:false,error:"Rate limit exceeded."}`.
Buckets pruned on a 5-min `unref()` interval.

### 3. Response size caps  → `server/http.js` (inbound) + `upstream/client.js` (outbound)
Inbound bodies capped at `MAX_BODY_BYTES` (64 KB → 413). Outbound upstream responses capped at `UPSTREAM_MAX_BYTES`
(8 MB). No tool response is unbounded because upstream inputs are bounded and page limits are clamped.

### 4. CORS policy  → `server/http.js`
Public read-only API, so `Access-Control-Allow-Origin: *` stays. ⚠️ **Behavior change:** `Allow-Headers` drops the
webhook-only `X-Webhook-Admin-Token`; keeps `Content-Type, Accept, mcp-session-id, Authorization`. `Allow-Methods:
GET, POST, DELETE, OPTIONS`. `Expose-Headers: mcp-session-id`. `OPTIONS → 204`.

### 5. Security headers (new)  → `server/http.js`
On every response: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
`Cross-Origin-Resource-Policy: cross-origin`, `Cache-Control: no-store` on dynamic tool responses. No `Server` /
`X-Powered-By` banner. (No CSP needed — pure JSON API, no HTML.)

### 6. No secret leakage + safe error messages  → `lib/errors.js`
- Typed errors carry an internal `message` (full detail → stderr) and a `toClientMessage()` (safe, generic) plus a
  machine `code`. Clients receive only the safe message; upstream URLs, key presence, and stack traces never appear in
  responses. ⚠️ **Behavior change (robustness):** REST status is chosen by **error type**
  (`ValidationError→400`, `AuthError→401`, `NotFoundError→404`, `RateLimitError→429`, `UpstreamError/Timeout→502`,
  else `500`) instead of string-sniffing `e.message` for `"required"`/`"unauthorized"`.
- Config never logs key *values*; only `hasCoingeckoKey: true|false` at startup.
- The generic 500 body is `{ok:false,error:"Internal error"}` with a correlation line on stderr — no internals leak.

### 7. Removed attack surface
Deleting the webhook subsystem removes the SSRF-prone outbound-delivery engine, the disk-persisted subscription store,
admin-token handling, and the DNS-pinning client entirely. Net reduction of ~1,700 lines of security-sensitive code.

---

## G. Efficiency / performance (beyond caching)

- **Bounded fan-out (fixes N+1).** `lib/concurrency.mapLimit`:
  - `get_protocol_snapshot`: its 4 upstream groups already run via `Promise.all` — kept, but each underlying fetch is
    cached, so a warm snapshot may issue **zero** network calls.
  - `get_positions` (detail) + `get_challenges`: the per-unique-position Ponder lookups are the current N+1 hotspot.
    **Preferred fix:** collapse them into **one** Ponder request using a single `where:{ position_in:[...] }` (V2) plus
    one V1 query, instead of one request per address. **Fallback** (if Ponder lacks `_in` on `position`): `mapLimit`
    with concurrency 5 + per-query caching + coalescing. Either way outbound calls drop from O(positions) to O(1)–O(5).
- **Response shaping.** Continue requesting only the exact Ponder fields each tool needs (already the case). Round
  numbers at the service edge; do not ship raw wei alongside decoded values.
- **Payload size.** List tools keep their clamped `limit` (≤100) and pagination `pageInfo`. `query_ponder` limit cap
  (≤1000) bounds worst-case payloads.
- **Keep-alive agent reuse.** Shared undici `Agent` (see §C) reuses TLS connections to the five upstream hosts across
  all calls — meaningful latency win given repeated hits to `api.frankencoin.com` and `ponder.frankencoin.com`.
- **Coalescing under load.** Single-flight (§B) means a burst of identical concurrent tool calls (common with MCP
  clients retrying) amplifies to one upstream fetch, not N.
- **Dune non-blocking-ish.** 30-min TTL + SWR means only the very first caller (per 30 min) pays the ~30 s Dune poll;
  everyone else gets a cached or stale-then-revalidated result. The slow synchronous poll is no longer on every hit.

---

## H. Testing strategy (`node:test`, zero new deps)

Run via `node --test test/**/*.test.js`. Upstreams are mocked by **injecting a fake `fetch`**: `upstream/client.js`
reads `globalThis.fetch`, and tests install a stub (or, cleaner, `client.js` accepts an optional injected fetch that
defaults to the global — enabling deterministic tests without touching globals). `CACHE_ENABLED=false` for tests that
assert fetch counts, `true` for cache-behavior tests.

| Suite | File | What it covers |
|---|---|---|
| Number transforms | `test/lib/numbers.test.js` | `fromWei` (incl. large-value precision boundary, 6-dp CHFAU, `36-decimals` liq price), `bpsToPercent` (37500→3.75), `ppmToPercent`, `pegDeviation`, `pegStatus` thresholds (0.5/1.0, null→unknown). Pure, exhaustive. |
| Envelope | `test/lib/envelope.test.js` | REST ok/err shape, MCP text-content wrapping, `get_collaterals` object shape, pretty-printing. |
| Errors | `test/lib/errors.test.js` | Type→HTTP-status mapping, `toClientMessage()` never contains secrets/URLs/stack. |
| Cache | `test/cache.test.js` | TTL expiry, single-flight coalescing (one loader call under N concurrent gets), LRU eviction at cap, SWR serves stale + revalidates, errors not cached. |
| GraphQL validator (security) | `test/upstream/ponder-validate.test.js` | **Rejection cases:** mutation/subscription, `__schema`, depth > limit, non-allowlisted root field, oversize query, `limit:` > 1000, >25 selections. **Accept cases:** the documented entity queries. |
| Dispatch | `test/tools/dispatch.test.js` | zod coercion (string→number/bool), clamps (limit≤100, days≤365), defaults, unknown-param rejection, unknown-tool → NotFoundError. Handlers stubbed. |
| Services (mocked upstreams) | `test/services/*.test.js` | Each service against canned upstream JSON fixtures → asserts output shape/units. Degradation paths: no CG key → market partial + note; no Dune key → dune note. |
| HTTP routes | `test/server/http.test.js` | Spin server on ephemeral port (`PORT=0`): `/health` (13 tools, version), `/api` index, `/api/<tool>` GET+POST, unknown tool 404, body-too-large 413, invalid JSON 400, invalid URL 400, method-not-allowed, CORS + security headers present, OPTIONS 204. |
| MCP integration | `test/server/mcp.test.js` | `initialize` → session id; `tools/list` returns 13; `tools/call` returns text-content JSON; unknown session → -32001. |
| Rate limit | `test/server/ratelimit.test.js` | Exceed `RATE_LIMIT_MAX` → 429 + headers; XFF spoofing does **not** bypass with `TRUST_PROXY_HOPS=1`; window reset. |

Coverage goal: **all pure logic** (numbers, envelope, errors, cache, validator) and **the full dispatch + HTTP + MCP
path** with mocked upstreams. Live-network calls are never made in tests.

---

## I. Migration / cutover notes

### Delete
- `src/webhooks/**` (all 8 modules + `src/webhooks/tests/**`).
- `src/api.js` (barrel) and `src/api/**` — replaced by `src/services/**` + `src/upstream/**`.
- Old `src/index.js`, `src/tools.js`, `src/cli.js` — rewritten in the new layout.

### `package.json` changes
- **Remove** `test:webhooks` and repoint `test` → `node --test test/**/*.test.js`.
- **Confirm NO `build` script exists** (root cause of the prior Railway outage — a phantom `tsc` build). `main`/`bin`
  stay pointed at `./src/*.js`. `start` stays `node src/index.js`; add nothing that implies a build.
- `bin`: keep `frankencoin-mcp → ./src/index.js` and `frankencoin → ./src/cli.js`.
- Dependencies unchanged: `@modelcontextprotocol/sdk`, `zod`. (`undici`'s `Agent`/`setGlobalDispatcher` are imported
  from the built-in `node:undici`-equivalent global — no new dep; if the Node version predates a stable `undici`
  export, fall back to `fetch` defaults, which already keep-alive.)
- Bump `version` to `3.0.0` (major: webhook removal + envelope changes) and update `description` to "13 tools".

### `railway.toml` changes
```
[build]
builder = "nixpacks"

[deploy]
startCommand = "node src/index.js --http"     # kept: repo-level, not dashboard config
healthcheckPath = "/health"
healthcheckTimeout = 30
restartPolicyType = "on_failure"
restartPolicyMaxRetries = 3
# [[volumes]] REMOVED — no /data, no persistence (webhooks gone). Fully stateless.
```
Nixpacks auto-detects Node from `package.json`; no build command runs (there is none). Zero dashboard config needed;
`COINGECKO_API_KEY` / `DUNE_API_KEY` are optional and only enrich two tools.

### Behavior changes clients might notice (consolidated)
1. **`/health`** advertises **13 tools** (was "17 tools (13 data + 4 webhook)"); `interfaces.webhooks` removed;
   description updated.
2. **`/webhooks/*`** routes and MCP tools 14–17 (`subscribe_events` etc.) are **gone** → now `404`.
3. **`get_collaterals`** returns `{ collaterals:[...], count }` (was a bare array).
4. **`change24hPercent`** is a **number** everywhere (was a string in positions/challenges collateral).
5. **`get_market_data`** without `COINGECKO_API_KEY` returns **partial data + note** (was a hard error).
6. **`get_dune_stats`** without `DUNE_API_KEY` returns a **soft note** (was a hard error).
7. **REST error bodies** are pretty-printed and typed (`code` field added); status codes derive from error type, not
   message text. Previously-`500` cases like upstream failures now return **`502`**.
8. **File-based API keys** (`~/.config/.../api_key`) are **no longer read** — env vars only.
9. **`X-Forwarded-For`** is now interpreted via `TRUST_PROXY_HOPS`, not blindly trusting the first entry (defaults keep
   behavior correct behind Railway; direct-connection clients see their socket IP).
10. Unchanged for clients: the 13 tool names, descriptions, input params, MCP text-content JSON payloads, `/mcp` +
    `/sse` transports, `/api/<tool>` GET/POST invocation, and every tool's core `result` field shape (aside from the
    two typed-field fixes above).

### Cutover
Single PR replacing `src/` + `test/` + `package.json` + `railway.toml`. Merge to `main` → Railway auto-deploys via
nixpacks with no build step and no volume. `/health` returning `{status:"ok", ...13 tools}` is the deploy gate.

---

*End of architecture.*
