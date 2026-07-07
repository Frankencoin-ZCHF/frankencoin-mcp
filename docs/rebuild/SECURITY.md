# Frankencoin MCP Server — Threat Model & Hardening Spec

> **Scope.** Security requirements for the from-scratch rewrite of the Frankencoin (ZCHF) MCP server: a **public, read-only, unauthenticated** HTTP service running on **Railway** at `mcp.frankencoin.com`. It exposes 13 data tools over three surfaces — MCP Streamable HTTP (`/mcp`), legacy SSE (`/sse` + `/messages`), and a plain REST API (`/api/<tool>`) — plus `/health`.
>
> **Out of scope by design.** The webhook subsystem is **removed** in the rewrite. That deletes: all outbound HTTP POST delivery, HMAC signing, the 60 s poller, disk persistence of subscriptions, admin/management tokens, and the SSRF guard that protected webhook target URLs. Consequently this document does **not** cover SSRF-via-user-supplied-URL, outbound-delivery abuse, or persistence tampering — those attack classes no longer exist. Webhook tools 14–17 and `/webhooks/*` routes MUST NOT exist in the rewrite.
>
> **Locked constraints.** Node.js ESM, no build step. No authentication (public read-only API — hardening the open surface, not gating it). Stateless per-process on Railway (multiple replicas possible; all in-memory state — rate-limit buckets, caches, session maps — is per-process and MUST NOT be assumed shared). Secrets `COINGECKO_API_KEY` and `DUNE_API_KEY` come from env and MUST never leak. No heavy infra: no WAF, no Redis, no external auth provider — every control here is implementable in-process in Node.

---

## 0. Threat model summary

**Assets to protect**
1. **Server availability** (the primary asset — this is a free public service; DoS is the highest-likelihood attack).
2. **Upstream availability & our reputation with upstreams** (CoinGecko Pro / Dune are metered/paid via our keys; Ponder/api.frankencoin.com are shared community infra — a client can amplify one cheap request into many expensive upstream calls billed to / rate-limited against us).
3. **The two API secrets** (`COINGECKO_API_KEY`, `DUNE_API_KEY`) — must never appear in any response, error, log line, or health payload.
4. **Integrity of served data** — read-only; the server must never become a vector to *write* to any upstream (notably: `query_ponder` must not be able to reach a GraphQL mutation).

**Adversary model.** Unauthenticated remote attackers over the internet. No insider threat in scope. Attacker fully controls: HTTP method, path, all headers (including `X-Forwarded-For`, `Host`, `Origin`, `Content-Type`, `mcp-session-id`), query string, and request body bytes. Attacker can open many concurrent connections and send slowly.

**Top risks, ranked**
1. **`query_ponder` arbitrary-GraphQL passthrough** (P0) — unvalidated forwarding to `ponder.frankencoin.com`: mutation reachability, depth/alias/complexity bombs, introspection abuse, batched-query amplification, oversized result relay.
2. **Resource-exhaustion DoS** (P0) — spoofable rate-limit key, upstream fan-out amplification, unbounded session-map growth, slowloris, no inbound timeouts, no cost cap on expensive tools.
3. **Information disclosure via errors/logs** (P0) — current code string-matches `e.message` and echoes upstream error text verbatim; must not leak stack traces, upstream URLs, secret presence, or file paths.
4. **Input-validation gaps** (P1) — no per-tool schema validation; type coercion only; prototype pollution on JSON bodies; missing clamps enforced only in dispatch.
5. **Transport/header policy** (P1/P2) — `CORS: *`, missing security headers, loose content-type/method handling.
6. **Supply chain** (P1) — dependency footprint, lockfile integrity, Node pinning.

---

## 1. Attack surface enumeration (post-webhook-removal)

Every inbound entry point that remains, and exactly what the attacker controls at each.

| # | Entry point | Methods | Attacker-controlled inputs | Primary risks |
|---|-------------|---------|----------------------------|---------------|
| 1 | `POST /mcp` (new init) | POST | JSON-RPC body, `Accept`, absence of `mcp-session-id` | Unbounded session creation (memory DoS); JSON-RPC parse; tool-call fan-out; init-lock races |
| 2 | `POST /mcp` (established) | POST | `mcp-session-id` header, JSON-RPC body (tool name + args) | Tool abuse (esp. `query_ponder`), fan-out amplification, session hijack by ID guessing (UUIDv4 — infeasible), oversized body |
| 3 | `GET /mcp` | GET | `mcp-session-id` | Long-lived SSE stream held open (connection exhaustion) |
| 4 | `DELETE /mcp` | DELETE | `mcp-session-id` | Session teardown of guessed IDs (UUIDv4 — infeasible) |
| 5 | `GET /sse` | GET | (none but connection) | **Unbounded** SSE session creation + long-lived stream (memory + connection DoS) — worst offender, one GET = one held connection + `McpServer` |
| 6 | `POST /messages?sessionId=` | POST | `sessionId` query param, JSON-RPC body | Tool abuse, oversized body, unknown-session probing |
| 7 | `GET /api/<tool>` | GET | tool name (path), query-string params | Unknown-tool probing, param injection, fan-out amplification, `query_ponder` not reachable via GET (no body) — but other tools are |
| 8 | `POST/PUT /api/<tool>` | POST/PUT | tool name (path), JSON body | **`query_ponder` primary vector**, oversized body, malformed JSON, prototype pollution, fan-out |
| 9 | `GET /api` (index) | any | (none) | Info exposure (tool list) — acceptable, public |
| 10 | `GET /health`, `/` | any | (none) | Info exposure (versions, session count, tool list) — minimize |
| 11 | catch-all | any | arbitrary path/method | Must fail closed with a clean 404, no reflection of path into a way that enables XSS/log injection |
| 12 | `OPTIONS *` (CORS preflight) | OPTIONS | `Origin`, `Access-Control-Request-*` | CORS policy correctness |

**Note on `Host` header.** The current code builds `new URL(req.url, "http://localhost:PORT")` — it ignores the client `Host` header for routing, which is correct (no Host-header trust). Keep it that way; do not use `req.headers.host` to construct absolute URLs used in responses.

---

## 2. `query_ponder` — hard validation spec (P0, the top risk)

`query_ponder` forwards a client-supplied GraphQL string to `https://ponder.frankencoin.com`. Today it is passed **verbatim** with zero validation (`runPonderQuery(q) → ponderQuery(q)`). This is the single highest-risk surface. The rewrite MUST implement a hard **allow-query-only, validate-before-forward** gate.

### 2.1 Parsing requirement (P0)

Regex/substring validation of GraphQL is **insufficient and bypassable** (comments, aliases, string literals, unicode escapes, whitespace tricks defeat it). The validator MUST parse the query into an AST and reason over the AST.

- **Approved dependency exception:** add the reference `graphql` package (npm `graphql`, a single well-maintained, dependency-free library) solely for `parse()` + AST traversal in the `query_ponder` validator. This is the one justified addition beyond `sdk` + `zod`; a from-scratch GraphQL parser is not maintainable and regex is not safe. Pin it in the lockfile (§8).
- Parse with `parse(query, { noLocation: true })`. If parse throws → reject (see §2.4, generic "invalid GraphQL query" — do **not** echo the parser's positional error, which can reflect input).

### 2.2 Reject conditions (all P0, evaluate in this order, first failure wins)

Apply these **before** any network call to Ponder:

| # | Check | Exact condition to REJECT | Rationale |
|---|-------|---------------------------|-----------|
| Q1 | **Body shape** | Request body is a JSON array, or contains a top-level `queries`/batch array, or more than one GraphQL string | Blocks **batched queries** (N operations in one request → N× cost) |
| Q2 | **Size cap** | `query.length > 8000` characters (UTF-16 code units) | Bounds parser cost and complexity bombs |
| Q3 | **Single operation** | AST `definitions` contains ≠ 1 `OperationDefinition`, OR any `FragmentDefinition` count > 8 | One operation per call; bound fragment reuse amplification |
| Q4 | **Read-only** | Operation `operation !== "query"` (i.e. it is `mutation` or `subscription`) | **Enforces read-only — no writes reach Ponder.** Also blocks `subscription` (long-lived stream) |
| Q5 | **No introspection** | Any field name in the selection tree is `__schema` or `__type` (introspection roots). `__typename` is **allowed** | Blocks introspection-abuse (huge recursive schema dumps); allowlisting `__typename` keeps normal usage working |
| Q6 | **Depth limit** | Max nesting depth of selection sets > **8** | Blocks deeply nested query bombs |
| Q7 | **Total field count** | Total number of `Field` nodes in the document > **200** | Blocks wide/flat field-count bombs |
| Q8 | **Alias count** | Total number of aliased fields > **20** | Blocks alias-based amplification (`a: x b: x c: x …` multiplies identical expensive resolvers) |
| Q9 | **Argument literal size** | Any single string/int argument literal > 512 chars, OR total argument nodes > 100 | Bounds `where:`/filter abuse |
| Q10 | **Directive cap** | Total `Directive` nodes > 10 | Blocks `@include`/`@skip` and custom-directive amplification |

Depth (Q6), field count (Q7), alias count (Q8), directive count (Q10) are computed with a single `visit()` pass over the AST (from the `graphql` package) using counters/`enter`/`leave` — no recursion the attacker controls.

### 2.3 Timeout & result-size cap (P0)

- **Upstream timeout:** the Ponder fetch MUST use `AbortSignal.timeout(15000)` (15 s), unchanged. On timeout → reject with generic "upstream query timed out".
- **Result-size cap:** after Ponder responds, before returning to the client, cap the serialized JSON: if `JSON.stringify(data).length > 1_000_000` (1 MB) → do NOT return the payload; reject with "query result too large — narrow your query with a smaller `limit`". This prevents a validated-but-broad query (e.g. `limit: 100000`) from relaying tens of MB back through us.
- **Implicit `limit` guard (P1):** if the parsed query contains a `limit` argument with an integer value > 1000 anywhere, reject with "`limit` argument may not exceed 1000". (Complements the byte cap; catches the amplification at request time.)

### 2.4 Error envelope for `query_ponder` (P0)

All rejections return a **generic, input-free** message. Never echo the parser error text, the query, the Ponder URL, or upstream error bodies.

- REST: `400` `{ "ok": false, "tool": "query_ponder", "error": "<generic reason>" }`
- MCP: `{ content: [{ type: "text", text: "Error: <generic reason>" }], isError: true }`

Approved generic reasons (fixed strings, no interpolation of user input):
`"invalid GraphQL query"`, `"only read-only queries are allowed"`, `"query too large"`, `"query too deeply nested"`, `"query too complex"`, `"introspection is not permitted"`, `"batched queries are not allowed"`, `"limit argument may not exceed 1000"`, `"query result too large — narrow your query"`, `"upstream query timed out"`, `"upstream query failed"`.

### 2.5 Host pinning (P0)

`query_ponder` MUST NOT allow the client to influence the destination host. The query is sent to the hard-coded constant `PONDER_BASE = "https://ponder.frankencoin.com"` only. The client controls the GraphQL **string** but never a URL, host, header, or path. Confirm by code review that no field of the request body is ever used to build the fetch URL or headers. (See §7.)

---

## 3. Denial of service / resource exhaustion (P0)

### 3.1 Request body size cap (P0)

- Cap streamed request bodies at **64 KB** (`MAX_BODY_BYTES = 64 * 1024`), applied on **every** body-reading route (`/mcp` POST, `/messages` POST, `/api/<tool>` POST/PUT). On overflow: stop reading, `req.destroy()`, respond `413 { "ok": false, "error": "Request body too large (max 64 KB)" }`.
- The MCP SDK transports read the body themselves; enforce the cap by attaching a byte counter to the raw request stream **before** handing off to `transport.handleRequest`, or by configuring the transport's max body if the SDK exposes it. Do not rely on the SDK's default.

### 3.2 Rate limiting — correct client-IP derivation behind Railway (P0)

**Current bug (call out explicitly):** `getClientIp()` does `req.headers["x-forwarded-for"].split(",")[0].trim()` — it trusts the **left-most** XFF entry, which is **fully attacker-controlled**. An attacker sends `X-Forwarded-For: <random>` on every request and gets a fresh rate-limit bucket each time → **the rate limiter is trivially bypassed**. This MUST be fixed.

**Correct handling behind Railway's proxy (Railway fronts apps with an Envoy-based edge):**

1. **Preferred:** trust **`X-Envoy-External-Address`** if present. Railway's edge sets this header to the single real external client IP, and (being set by the trusted proxy, not appended to a list) it is not client-spoofable through the proxy. Use it verbatim as the rate-limit key.
2. **Fallback:** if `X-Envoy-External-Address` is absent, parse `X-Forwarded-For` and take the **right-most** entry (the address the closest trusted proxy appended), **not** the left-most. Rationale: clients can prepend arbitrary values to the left of XFF; only the right-most hop is written by infrastructure we trust. Assume exactly **1** trusted proxy hop (Railway edge) — take `xff.split(",").pop().trim()`.
3. **Final fallback:** `req.socket.remoteAddress`.
4. If none resolves → `"unknown"` (shared bucket — acceptable, it only makes the limit stricter, never looser).

**Additional rules (P0/P1):**
- Validate the derived value looks like an IP (basic `/^[0-9a-fA-F:.]+$/` and length ≤ 45) before using it as a map key — reject/normalize junk to prevent map-key blowup and log injection (P1).
- Cap the **number of distinct rate-limit buckets** (Map size). If `rateBuckets.size` exceeds **50,000**, evict the oldest-resetAt entries (or clear expired first). Prevents a spoofer who *can* still vary the socket-level source from growing the map unbounded (P1).
- Config via env: `RATE_LIMIT_WINDOW_MS` (default 60000), `RATE_LIMIT_MAX` (default 120 req/window/IP). The separate webhook-mutation bucket is **removed** (no webhooks). One general limit remains. (P1)
- **`query_ponder` sub-limit (P1):** apply a tighter per-IP limit for `query_ponder` specifically — default **20 req/window** — because each call is a validated-but-still-unbounded upstream GraphQL hit. Key: `ip + ":ponder"`.
- Emit `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`; on breach `429` + `Retry-After` + `{ "ok": false, "error": "Rate limit exceeded. Please slow down." }`. (P2)
- **Acknowledge the multi-replica gap (P2, documented, not fixed):** in-memory buckets are per-process; with N Railway replicas the effective limit is N× the configured value. This is accepted (no Redis per constraints). Document it; do not silently assume global enforcement. Set per-replica limits conservatively.

### 3.3 Inbound request timeouts / slowloris (P0)

Node's `http.Server` has no request timeout by default → a slowloris client can hold connections open indefinitely (byte-a-second bodies, never-ending headers). Set on the `http.Server`:

- `server.headersTimeout = 10_000` (10 s to send all headers).
- `server.requestTimeout = 30_000` (30 s total to send the full request).
- `server.keepAliveTimeout = 5_000` (5 s idle keep-alive).
- `server.timeout = 0` is Node's default (disabled) — do **not** rely on it; the two above are the real guards.
- For long-lived SSE/streamable GET responses, these apply to the **request** phase; the response stream is intentionally long-lived but MUST be bounded by session caps (§3.5).

### 3.4 Concurrency limits (P1)

- **Global in-flight cap:** track a counter of concurrent tool dispatches (across MCP + REST). If it exceeds **100**, respond `503 { "ok": false, "error": "Server busy, retry shortly" }` + `Retry-After: 1`. Prevents an attacker opening thousands of parallel expensive tool calls from exhausting the event loop / socket pool.
- **Per-IP in-flight cap:** max **10** concurrent tool dispatches per rate-limit key; excess → `429`. Stops a single client from monopolizing capacity below the global cap.

### 3.5 Unbounded session growth (P0) — memory DoS via `/mcp` and `/sse`

Both `sessions` (`/mcp`) and `sseSessions` (`/sse`) are `Map`s that grow on every new init and only shrink on `onclose`. An attacker who opens sessions and never cleanly closes them (or opens SSE streams and drops the TCP connection uncleanly) grows these maps and their attached `McpServer`/transport objects without bound → memory exhaustion.

MUST implement:
- **Hard cap per map:** `MAX_SESSIONS = 1000` for `/mcp`, `MAX_SSE_SESSIONS = 1000` for `/sse`. On a new-session request when the map is at cap → `503 { "error": "Server at session capacity, retry shortly" }` + `Retry-After: 2`. Do **not** evict a random live session for a new one (that would let attackers evict legitimate users) — refuse the new one.
- **Idle TTL / sweep:** every session record stores `lastSeenAt` (updated on each request routed to it). A sweep timer (`setInterval(...).unref()`, every 60 s) closes and deletes sessions idle > **10 minutes** (`transport.close?.()` then map delete). This reclaims sessions from clients that vanished without a DELETE / clean SSE close.
- **Absolute lifetime cap:** also close+delete any session older than **60 minutes** regardless of activity, to bound worst-case held streams.
- **SSE connection close hook:** ensure `res.on("close", ...)` (socket closed by client) deletes the `sseSessions` entry — do not rely solely on the SDK `transport.onclose`, which may not fire on an unclean TCP drop.
- Health payload's `activeSessions` count MUST be derived from these maps so operators can observe growth (but see §5.5 on minimization — expose it only as a coarse number, which is fine).

### 3.6 Upstream fan-out amplification (P0)

One cheap client request triggers **many** expensive upstream calls. Examples from the spec: `get_protocol_snapshot` fans out to ≥5 upstream calls (2 REST + `getSavings` [2 REST] + `getChallenges` [REST + Ponder + CoinGecko]); `get_positions?detail=true` → Ponder + 2 REST + CoinGecko; `get_market_data` → ~7 CoinGecko/REST/RPC calls; `get_dune_stats` → 4 Dune queries each polling up to ~30 s. Unbounded, an attacker turns a trickle of requests into a flood against CoinGecko Pro (metered/paid) and Dune (paid), and can get **our keys rate-limited or billed**.

MUST implement:
- **Response caching with short TTL (P0 for amplification control).** A tiny in-process TTL cache keyed by `(toolName + normalized-args)`. Suggested TTLs: `get_protocol_snapshot`/`get_market_data`/`get_savings`/`get_collaterals` **30 s**; `get_positions`/`get_challenges`/`get_governance`/`get_analytics` **30 s**; `get_dune_stats` **300 s** (Dune data is slow-moving and each miss is ~30 s + paid); `get_knowledge`/`get_news`/`get_merch` **300 s** (GitHub/Shopify content). `query_ponder` **not cached** (arbitrary) — governed by its own sub-limit instead. Cache stores successful results only; never cache errors. Bound the cache to **≤500 entries** with LRU/size eviction so it cannot itself grow unbounded (see §3.7).
- **Single-flight / request coalescing (P1):** if a cache-miss fetch for key K is already in flight, concurrent requests for K await the same promise rather than each firing their own upstream fan-out. This collapses a thundering herd on a cold cache into one upstream burst.
- **Per-upstream circuit breaker (P2):** if an upstream (CoinGecko/Dune) returns 429/5xx repeatedly (e.g. ≥5 consecutive failures), stop calling it for a cooldown (e.g. 60 s) and serve degraded/cached/`null` — protects our key from hammering a throttling upstream.
- **Dune-specific (P1):** `get_dune_stats` is the most expensive tool (~30 s synchronous poll, paid). Its 300 s cache is mandatory; additionally consider serving only cached Dune data and refreshing out-of-band. At minimum, the per-IP and global concurrency caps (§3.4) plus the cache bound the damage.

### 3.7 Cache-based amplification / cache poisoning (P1)

- **Bounded cache** (see §3.6): hard entry cap + byte-size awareness so a client cannot inflate memory by causing many distinct cache keys (e.g. varying `limit`/`days`/`type` combinations). Clamp/normalize args **before** they form the cache key (see §4) so the key space is small and finite.
- **No user string in cache key unbounded:** `query_ponder` is excluded from caching precisely because its arg is unbounded free text; do not add it.
- Cache stores only server-produced objects (never raw upstream error text), preventing an attacker from getting a poisoned/error value served to others.

---

## 4. Input validation (P1)

**Current gap:** the rewrite must not repeat the current design where clamps live only in the dispatch switch and REST does mere type-coercion with unknown params passing straight through. Validate every tool's params against an explicit schema (zod) at the dispatch boundary, shared by MCP and REST.

### 4.1 Per-tool parameter schema (P1)

Define one zod schema per tool; parse args through it in `dispatchTool` before any handler runs. Reject unknown/extra keys (`.strict()`), enforce types, ranges, enums, and clamps:

| Tool | Param | Rule |
|------|-------|------|
| `get_governance` | `type` | enum `all\|rate_proposals\|minters\|equity_trades\|holders`; default `all`; else reject |
| | `status` | enum `active\|denied\|all\|pending\|approved`; default `all` |
| | `limit` | integer, coerce, clamp `1..100`, default 20 |
| `get_positions` | `detail` | boolean, default false |
| | `limit` | integer, clamp `1..100` |
| | `active_only` | boolean |
| | `collateral` | string, **must match `/^0x[a-fA-F0-9]{40}$/`** or reject (it is interpolated into a Ponder `where` clause — see §4.4) |
| `get_challenges` | `limit` | integer, clamp `1..100`, default 20 |
| | `active_only` | boolean, default false |
| `get_analytics` | `type` | enum `time_series\|trades\|minters\|rate_history`; default `time_series` |
| | `days` | integer, clamp `1..365`, default 90 |
| | `limit` | integer, clamp `1..100`, default 20 |
| `get_knowledge` | `topic` | enum of the 15 known topics; unknown → return the existing `{error, availableTopics}` object (not a 500) |
| `query_ponder` | `query` | string, required, non-empty, ≤8000 chars → then §2 validation |
| (no-param tools) | — | reject any provided params (`.strict({})`) |

- **Clamps enforce upper bounds even when the source is REST query-string** (where `Number(v)` could yield `NaN`, `Infinity`, or huge values). Reject `NaN`/`Infinity`/non-finite numbers explicitly.
- `limit`, `days` etc. must be validated as **integers ≥ 1**; negative or zero → reject or clamp to the min. A negative `limit` interpolated into GraphQL must never reach Ponder.

### 4.2 JSON parse safety (P1)

- Parse bodies with `JSON.parse` inside try/catch; on failure → `400 "Invalid JSON body"` (never 500, never echo the parse error).
- Enforce the 64 KB cap **before** parsing (§3.1).
- Reject bodies whose top-level value is not a JSON **object** for tool calls (e.g. a bare array or string) → `400 "Invalid JSON body"`. (Also blocks batched-array bodies for `query_ponder`, reinforcing Q1.)

### 4.3 Prototype-pollution safety (P0 for the JSON body path)

An attacker POSTs `{ "__proto__": { "polluted": true } }` or `{ "constructor": { "prototype": {...} } }`. Because params flow into handler logic and (if cached) into keys:

- After `JSON.parse`, **reject or strip** any object containing own keys `__proto__`, `constructor`, or `prototype` at any depth. Simplest robust rule: reject the whole body with `400 "Invalid JSON body"` if a `__proto__`/`constructor`/`prototype` key is present. (Note: `JSON.parse` does not set `Object.prototype` via `__proto__` as a real prototype — it creates an own property named `"__proto__"` — but downstream code doing `params[k]` or spreads can still be tricked; reject to be safe.)
- Do all param access via the zod-parsed, allow-listed object — never spread untrusted bodies into option objects that later hit `Object.assign`/`{...params}` used as lookup maps.
- Never use a user-supplied string to index into an object that could resolve a prototype method (e.g. dispatch on tool name via an explicit `switch`/allow-list `Set`, never `handlers[toolName]` on a plain object without a `hasOwnProperty` guard).

### 4.4 GraphQL injection via interpolated params (P1)

`get_positions` and `get_challenges` build Ponder `where` clauses by **string interpolation** of `collateral`/`position` addresses. A non-address value could alter the query. Mitigation: the address regex validation in §4.1 (`/^0x[a-fA-F0-9]{40}$/`) is **mandatory** — reject anything else before interpolation. Positions/challenges address filters must be validated identically wherever interpolated.

### 4.5 Query-string coercion safety (P1)

- Coerce by declared schema type, then run through the same zod schema as JSON bodies — so GET and POST converge on one validated shape.
- Duplicate query params (`?limit=1&limit=2`): take a deterministic single value (first) and validate; never pass an array where a scalar is expected.
- Reject unknown query-string keys or ignore them, but never forward them to handlers.

### 4.6 Unknown tool / unknown path (P1)

- Unknown `/api/<tool>` → `404 { "ok": false, "error": "Unknown tool", "available": [<tool names>] }`. Do **not** reflect the raw attacker-supplied tool name back inside the error string unescaped if it will ever be rendered as HTML anywhere; it is JSON so this is low-risk, but keep the message a fixed string and put the name only in a structured field. (Prevents log/response injection subtleties.)
- Unknown path → `404 { "error": "Not found", "endpoints": ["/mcp", "/api", "/sse", "/health"] }`. No `/webhooks` in the list.
- Unknown method on a known route → `405` + `Allow` header for that route (§6.4).

---

## 5. Information disclosure (P0)

**Current gaps:** REST maps `e.message` substrings to status codes and returns `error: e.message` verbatim — which for upstream failures is text like `"Frankencoin API error 500: /positions/open"`, `"CoinGecko error 401"`, `"Ponder error 500"`, or a raw GraphQL error message. These leak upstream URLs/paths, upstream status, and the fact/shape of our upstream topology. The catch-all `/mcp` handler returns `{ error: e.message }` which can carry a stack-adjacent message.

### 5.1 Safe error envelope (P0)

Define a single error mapper used by **all** routes. It maps an internal error to `(status, safeMessage)` where `safeMessage` is drawn from a **fixed allow-list of generic strings** — never the raw `e.message`, never `e.stack`.

Mapping rules (by internal cause, determined by a typed error or an internal code, **not** by sniffing message substrings that could contain input):

| Internal cause | HTTP status | Safe client message |
|----------------|-------------|---------------------|
| Missing required param / validation fail | 400 | `"invalid request parameters"` (optionally with the zod field name, which is server-defined, not user data) |
| Unknown tool / path | 404 | `"not found"` |
| Rate limited | 429 | `"rate limit exceeded"` |
| At capacity / busy | 503 | `"server busy, retry shortly"` |
| Upstream timeout | 504 | `"upstream timed out"` |
| Upstream non-2xx / any handler throw | 502 | `"upstream data source error"` |
| Anything else / unexpected | 500 | `"internal server error"` |

- **Never** interpolate `e.message`, upstream URLs, file paths, or stack frames into any response body.
- The REST error envelope stays `{ "ok": false, "tool": <name>, "error": <safe message> }`. The MCP envelope stays `{ content: [{ type: "text", text: "Error: <safe message>" }], isError: true }`.
- Remove the "status by string-match on `e.message`" logic entirely; replace with typed errors (e.g. a small `class UpstreamError`, `class ValidationError`, `class RateLimitError`) or an internal `code` field on thrown errors.

### 5.2 Secrets never in output (P0)

- `COINGECKO_API_KEY` / `DUNE_API_KEY` MUST never appear in any response, error, or log. Since upstream error messages (`"CoinGecko error 401"`) are no longer echoed (§5.1), a key-related upstream failure surfaces only as generic `"upstream data source error"`.
- The key-absence messages (`"CoinGecko API key not configured on server"`, `"Dune API key not configured on server"`) **reveal server config state** and MUST NOT be returned to clients verbatim — map them to the generic 502/503 message. (An attacker learning which optional keys are configured is minor recon, but there's no reason to disclose it.)
- Remove the file-based key fallback that reads `~/.config/.../api_key` from the server user's home dir, or at minimum ensure a read error there never surfaces a filesystem path to clients. On Railway, keys come from env only.

### 5.3 Logging hygiene (P0)

- Logs go to stderr only. Log lines MUST NOT include secrets, full request bodies, `query_ponder` query text (could be large / used for log-flooding), or full `Authorization`-class headers (none needed now).
- Sanitize any client-derived value that enters a log line (IP, tool name) — strip CR/LF to prevent **log injection** (an attacker putting `\n[session] new: fake` into a header/param to forge log entries). Reject/replace `\r` and `\n` in any logged client string.
- Do not log at a volume an attacker can exploit for disk/IO DoS — e.g. do not log the full body of every request; log tool name + outcome + status only.

### 5.4 No stack traces to clients (P0)

- Global `try/catch` around every route handler; on unexpected throw → `500 "internal server error"` with headers-sent guard. Never `res.end(e.stack)` or `res.end(String(e))`.
- Set `process.on("uncaughtException")` / `unhandledRejection` handlers that log to stderr and (for uncaughtException) exit cleanly — never write the error to an in-flight response.

### 5.5 `/health` response minimization (P1)

Current `/health` returns version, full tool list w/ descriptions, `activeSessions`, description string mentioning "17 tools". Minimize:
- Keep: `{ "status": "ok", "server": "frankencoin-mcp", "version": <v> }`. Version disclosure is acceptable for an open-source public API but is optional — consider omitting the patch version.
- The full tool list with descriptions is already public via `/api` and MCP `tools/list`, so exposing it on `/health` is not a *new* leak — but `/health` should be lean for uptime checks. Move the tool manifest to `/api` only.
- `activeSessions` as a coarse integer is fine (operational signal); do not expose session IDs, IPs, or per-session detail.
- Description string MUST say "13 tools" (not "17 (13 data + 4 webhook)") — the webhook mention is stale and misleading.

---

## 6. Transport / headers (P1/P2)

### 6.1 CORS policy (P1)

**Assessment:** For a **public, read-only, unauthenticated, secret-free** API, `Access-Control-Allow-Origin: *` is **acceptable and appropriate** — there are no cookies, no `Authorization`, no per-origin secrets, and nothing a malicious origin can do via a victim's browser that it couldn't do with a direct `fetch` from its own server (no ambient authority is riding on the request). CORS is not a server-side access control; keeping `*` maximizes interoperability for the intended clients (agents, scripts, browsers).

**Required policy (exact):**
- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS`
- `Access-Control-Allow-Headers: Content-Type, Accept, mcp-session-id` (drop `Authorization` and `X-Webhook-Admin-Token` — no auth remains)
- `Access-Control-Expose-Headers: mcp-session-id`
- **Do NOT set `Access-Control-Allow-Credentials: true`** — it is incompatible with `*` and there are no credentials. Explicitly ensure it is never sent.
- `OPTIONS` → `204` with the above headers, empty body.
- Optionally set `Access-Control-Max-Age: 600` to reduce preflight volume (P2).

### 6.2 Security response headers (P2, cheap wins)

Set on all responses (or at least all non-stream JSON responses):
- `X-Content-Type-Options: nosniff` — prevents MIME-sniffing of JSON as HTML.
- `Cache-Control: no-store` on `/api/*`, `/mcp`, `/messages`, and `/health` responses — these are dynamic; prevents intermediary caching of data responses. (Distinct from the *internal* TTL cache of §3.6.)
- `Referrer-Policy: no-referrer` (P2).
- `Content-Security-Policy: default-src 'none'` on JSON responses (P2) — the API serves no HTML/JS; a strict CSP neutralizes any accidental HTML rendering.
- Do **not** set HSTS from the app if Railway terminates TLS at the edge (set it at the edge if desired); an app-level HSTS on a non-HTTPS-terminating origin is a no-op or misleading. (P2)
- **Do not** advertise the framework/version via a `Server`/`X-Powered-By` header (Node's raw `http` doesn't add `X-Powered-By`; ensure nothing adds it).

### 6.3 Content-Type enforcement on bodies (P1)

- For `POST/PUT /api/<tool>` with a non-empty body, require `Content-Type` to be `application/json` (allow `application/json; charset=utf-8`). Reject other content types with `415 "unsupported media type"`. This blocks `text/plain` CORS-simple-request tricks and enforces the parser contract.
- `/mcp` and `/messages` (JSON-RPC) similarly expect JSON; the SDK may enforce this — verify and add an explicit check if not.

### 6.4 Method allow-lists per route (P1)

Enforce exact method sets; anything else → `405` with correct `Allow`:
- `/mcp`: `POST, GET, DELETE` (+ `OPTIONS`). Else `405 Allow: POST, GET, DELETE, OPTIONS`.
- `/sse`: `GET` only. `/messages`: `POST` only.
- `/api/<tool>`: `GET, POST, PUT` (+ `OPTIONS`). `query_ponder` effectively requires POST/PUT (needs a body).
- `/health`, `/api` index: `GET` (be lenient — any read method OK, but no bodies processed).

---

## 7. Outbound / upstream hardening (P1)

The server calls **7 upstreams** (Frankencoin REST, Ponder GraphQL, CoinGecko Pro, Dune, Ethereum RPC llamarpc, GitHub, Shopify merch). Even though all are read-only and server-initiated:

- **Host pinning (P0 for `query_ponder`, P1 generally):** every upstream base URL is a hard-coded constant in `helpers.js`. **No client-supplied value may ever influence the destination host, port, scheme, or path** of any outbound request. Confirm by review:
  - `query_ponder` sends only to `PONDER_BASE`; the client string is the GraphQL **body**, never the URL. ✔ (verify in rewrite)
  - `get_positions.collateral` / `get_challenges` position addresses are validated to `/^0x[0-9a-fA-F]{40}$/` (§4.4) and only ever placed inside the GraphQL body, never a URL.
  - `get_knowledge.topic` maps through a **fixed allow-list** to a fixed file path — the client never supplies a raw path segment that reaches the GitHub URL. Reject unknown topics before building any GitHub path (no path traversal into `../`).
- **Timeouts (P1):** keep per-upstream `AbortSignal.timeout(...)`: REST 10 s, Ponder 15 s, CoinGecko 10 s, Dune 10 s/call, ETH RPC 8 s, GitHub 10 s, merch 10 s. These bound how long a client request can pin server resources on a slow/hung upstream.
- **No verbatim upstream error relay (P0):** upstream non-2xx bodies/messages are mapped to the generic envelope (§5.1). Never `res.end(upstreamResponseText)`.
- **Response size bounds from upstreams (P1):** cap the bytes read from any upstream (especially `query_ponder`→Ponder, merch Shopify feed, GitHub markdown). Enforce the §2.3 1 MB cap on `query_ponder`; for others, rely on the fixed queries + a sane global cap (e.g. abort if a response exceeds ~5 MB) to prevent a compromised/hostile upstream from OOMing us.
- **No following redirects to unexpected hosts (P2):** `fetch` follows redirects by default. For upstreams, set `redirect: "error"` (or `"manual"`) so a redirect from an upstream can't bounce our request (with our Dune/CoinGecko key headers) to an attacker-influenced host. At minimum for CoinGecko/Dune (which carry secret headers), use `redirect: "error"`.
- **Do not forward secret headers cross-host (P1):** `x-cg-pro-api-key` / `x-dune-api-key` are attached only on requests to `CG_BASE` / `DUNE_BASE`. Combined with `redirect: "error"`, this guarantees keys never travel to any other host.

---

## 8. Dependency / supply chain (P1)

- **Minimal footprint:** production deps = `@modelcontextprotocol/sdk`, `zod`, and (newly, §2.1) `graphql`. No dotenv, no express, no body-parser — use Node core `http`. Every added dep is a review item.
- **Lockfile integrity (P1):** commit `package-lock.json`; deploy/CI uses `npm ci` (not `npm install`) so builds are reproducible and the lockfile is authoritative. Railway build MUST run `npm ci`.
- **`npm audit` posture (P1):** run `npm audit --production` in CI; fail on `high`/`critical`. Given the tiny dep tree, the transitive surface is small — keep it that way.
- **Node version pinning (P1):** pin the Node major in `package.json` `engines` (e.g. `"node": ">=20 <23"`) and via a Railway `NODE_VERSION` / `.nvmrc` so the runtime is a known, supported LTS receiving security patches. Avoid EOL Node.
- **Pin/verify the `graphql` dependency (P1):** it is dependency-free; pin an exact minor and review updates. It is used only for `parse()`/`visit()` in the validator — do not pull in `graphql-tools`/servers.
- **No postinstall surprises (P2):** review that no dependency runs postinstall scripts in the deploy path; consider `npm ci --ignore-scripts` if compatible.
- **Provenance (P2):** prefer deps with npm provenance/signed publishes where available.

---

## 9. Hardening checklist (numbered, testable — MUST implement)

Each item maps to a code-review check or a test in §10. Priority in brackets.

**query_ponder (§2)**
1. **[P0]** `query_ponder` parses the query into an AST (via `graphql` `parse`) before any upstream call; parse failure → generic `400 "invalid GraphQL query"`. *(review + test T1a)*
2. **[P0]** Reject any operation that is not `query` (no `mutation`/`subscription`). *(T1)*
3. **[P0]** Reject batched queries: array body or >1 `OperationDefinition`. *(T2)*
4. **[P0]** Reject `__schema`/`__type` introspection roots; allow `__typename`. *(T3)*
5. **[P0]** Enforce max depth 8, max total fields 200, max aliases 20, max directives 10, max query length 8000 chars, max arg literal 512 chars. *(T4)*
6. **[P0]** Reject any `limit:` argument > 1000; cap serialized result at 1 MB, else reject. *(T5)*
7. **[P0]** 15 s upstream timeout on the Ponder call; timeout → generic message. *(review)*
8. **[P0]** All `query_ponder` errors use fixed generic strings; never echo parser/upstream text or the query. *(T6)*

**DoS / resource (§3)**
9. **[P0]** 64 KB body cap on all body-reading routes; overflow → `413`. *(T7)*
10. **[P0]** Client IP for rate limiting uses `X-Envoy-External-Address` → right-most XFF → socket addr; **never** left-most XFF. *(T8)*
11. **[P0]** IP value validated as IP-shaped before use as a map key; CRLF stripped. *(review + T14)*
12. **[P1]** Rate-limit bucket Map capped (≤50k) with eviction. *(review)*
13. **[P1]** Tighter per-IP sub-limit for `query_ponder` (20/window). *(review)*
14. **[P0]** `server.headersTimeout=10s`, `requestTimeout=30s`, `keepAliveTimeout=5s` set on the HTTP server. *(T9)*
15. **[P1]** Global in-flight cap (100) and per-IP in-flight cap (10) → `503`/`429`. *(review + T15)*
16. **[P0]** `sessions` and `sseSessions` maps capped (1000 each); at cap → `503`. *(T10)*
17. **[P0]** Idle-session sweep (>10 min) + absolute lifetime cap (60 min); SSE `res.on("close")` deletes entry. *(review + T11)*
18. **[P0]** TTL response cache for expensive tools (Dune 300 s, others 30–300 s), bounded ≤500 entries; `query_ponder` never cached. *(review + T16)*
19. **[P1]** Single-flight coalescing on cache misses. *(review)*

**Input validation (§4)**
20. **[P1]** Every tool's args validated by a strict zod schema shared by MCP + REST; unknown keys rejected. *(T12)*
21. **[P1]** Numeric params coerced, checked finite-integer, and clamped (`limit≤100`, `days≤365`, `≥1`). *(T13)*
22. **[P1]** Enum params (`type`, `status`, `topic`) validated against fixed allow-lists. *(T13)*
23. **[P1]** `collateral` / position addresses validated `/^0x[a-fA-F0-9]{40}$/` before GraphQL interpolation. *(T17)*
24. **[P0]** JSON bodies with `__proto__`/`constructor`/`prototype` keys rejected `400`. *(T18)*
25. **[P1]** Malformed JSON → `400 "Invalid JSON body"`, never `500`. *(T19)*
26. **[P1]** Non-object JSON body for tool calls → `400`. *(review)*

**Info disclosure (§5)**
27. **[P0]** Single error mapper; responses use fixed generic messages only; no `e.message`/stack/upstream-URL/file-path ever in a response body. *(T20)*
28. **[P0]** Status derived from typed errors, not `e.message` substring matching. *(review)*
29. **[P0]** Secrets never in responses or logs; key-absence never disclosed to clients. *(T21 + review)*
30. **[P0]** CRLF stripped from any client-derived value that enters a log line. *(review)*
31. **[P0]** `uncaughtException`/`unhandledRejection` handlers log to stderr, never to a response; `res.headersSent` guarded everywhere. *(review)*
32. **[P1]** `/health` minimized; says "13 tools"; no session/IP detail. *(T22)*

**Transport/headers (§6)**
33. **[P1]** CORS: `Origin: *`, methods `GET, POST, DELETE, OPTIONS`, headers `Content-Type, Accept, mcp-session-id`; **no** `Allow-Credentials`. *(T23)*
34. **[P2]** `X-Content-Type-Options: nosniff`, `Cache-Control: no-store` on data routes, no `X-Powered-By`/`Server` banner. *(T24)*
35. **[P1]** `Content-Type: application/json` required on non-empty POST/PUT bodies → else `415`. *(T25)*
36. **[P1]** Method allow-lists per route with correct `Allow` header on `405`. *(T26)*

**Upstream (§7)**
37. **[P0]** No client input influences any outbound host/port/scheme/path; all bases are constants. *(review + T27)*
38. **[P1]** Per-upstream timeouts retained; upstream errors never relayed verbatim. *(review)*
39. **[P1]** Secret headers attached only to their own host; `redirect: "error"` on secret-bearing (CoinGecko/Dune) fetches. *(review)*
40. **[P1]** `get_knowledge.topic` allow-listed; no raw path segment reaches the GitHub URL (no traversal). *(T28)*

**Supply chain (§8)**
41. **[P1]** `package-lock.json` committed; deploy uses `npm ci`. *(review)*
42. **[P1]** CI runs `npm audit --production`, fails on high/critical. *(review)*
43. **[P1]** Node major pinned via `engines` + Railway config; supported LTS only. *(review)*
44. **[P1]** No `/webhooks/*` route and no webhook tools exist; deps contain no webhook/SSRF/persistence code. *(T29 + review)*

---

## 10. Security test plan (adversarial cases against the deployed server)

Format: **name — request — expected — FAIL looks like.** These run against the deployed HTTP server (Railway staging). REST is the easiest driver for most; `/mcp` equivalents should be spot-checked too.

**T1 — query_ponder mutation rejected [P0]**
- Request: `POST /api/query_ponder` body `{"query":"mutation { setRate(bps:0){ ok } }"}`.
- Expected: `400 { ok:false, error:"only read-only queries are allowed" }`; **no** request reaches Ponder.
- FAIL: 200, or any 5xx that implies the mutation was forwarded, or the error contains Ponder's response text.

**T1a — malformed GraphQL rejected cleanly [P0]**
- Request: `POST /api/query_ponder` body `{"query":"{ this is (not valid"}`.
- Expected: `400 "invalid GraphQL query"`, no parser location/offset echoed.
- FAIL: `500`, or an error string containing the query text or `Syntax Error ... at line/column`.

**T2 — batched query rejected [P0]**
- Request: `POST /api/query_ponder` body `[{"query":"{a}"},{"query":"{b}"}]` and also `{"query":"query A{x} query B{y}"}`.
- Expected: `400 "batched queries are not allowed"` (array) / rejected for >1 operation.
- FAIL: either variant is forwarded / returns 200.

**T3 — introspection abuse rejected [P0]**
- Request: `POST /api/query_ponder` body `{"query":"{ __schema { types { name fields { name } } } }"}`.
- Expected: `400 "introspection is not permitted"`. A query using `__typename` still succeeds.
- FAIL: 200 with a full schema dump; or `__typename` wrongly rejected.

**T4 — depth/field/alias bomb rejected [P0]**
- Request: `POST /api/query_ponder` with (a) a 12-level nested selection, (b) 300 sibling fields, (c) 50 aliases `a0: x … a49: x`.
- Expected: each → `400` with the matching generic reason ("too deeply nested" / "too complex").
- FAIL: any is forwarded to Ponder or returns 200.

**T5 — oversized-result / limit cap [P0]**
- Request: `POST /api/query_ponder` body `{"query":"{ eRC20Balances(limit: 100000){ items { balance } } }"}`.
- Expected: `400 "limit argument may not exceed 1000"` (caught at parse) or, if it slips through, `400 "query result too large — narrow your query"` (byte cap). Never a multi-MB 200.
- FAIL: 200 relaying a huge body; server memory spike.

**T6 — query_ponder error hides internals [P0]**
- Request: any rejected query above.
- Expected: error body contains none of: `ponder.frankencoin.com`, the submitted query text, a stack frame, `graphql`, an upstream status line.
- FAIL: any of those substrings present.

**T7 — oversized body → 413 [P0]**
- Request: `POST /api/query_ponder` with a 200 KB body.
- Expected: `413 "Request body too large (max 64 KB)"`; connection not left hanging.
- FAIL: `500`, hang, OOM, or the full body buffered and parsed.

**T8 — forged X-Forwarded-For does not defeat rate limiting [P0]**
- Request: send `RATE_LIMIT_MAX + 20` requests to `/api/get_collaterals`, each with a **different random** `X-Forwarded-For` (e.g. `1.2.3.<n>`), same socket source, no `X-Envoy-External-Address`.
- Expected: after the limit, `429` — the server keys on the right-most XFF / socket address, so spoofing the left-most does not mint fresh buckets.
- FAIL: all requests return 200 (limiter bypassed) — indicates left-most XFF still trusted.

**T9 — slowloris bounded [P0]**
- Request: open a connection, send headers one byte per ~2 s / send a `Content-Length`-declared body extremely slowly.
- Expected: connection dropped by `headersTimeout`/`requestTimeout` within ~10–30 s.
- FAIL: connection held open indefinitely.

**T10 — session-map cap [P0]**
- Request: rapidly open `/sse` connections (or `/mcp` inits) beyond `MAX_SSE_SESSIONS`/`MAX_SESSIONS`.
- Expected: past the cap, `503 "...session capacity..."` + `Retry-After`; existing sessions unaffected; process RSS stays bounded.
- FAIL: unbounded map growth, RSS climbs without limit, no 503.

**T11 — idle sessions reclaimed [P0]**
- Request: open several `/sse` sessions, drop the TCP connections uncleanly, wait past the idle TTL.
- Expected: sweep closes+deletes them; `activeSessions` returns toward baseline.
- FAIL: sessions persist forever after client disappears.

**T12 — unknown params rejected [P1]**
- Request: `GET /api/get_challenges?limit=5&evil=1&__proto__=x`.
- Expected: `evil`/`__proto__` ignored or `400`; `limit` honored; no prototype pollution.
- FAIL: unknown keys reach the handler, or `Object.prototype` is polluted (probe `({}).x`).

**T13 — clamp & enum enforcement [P1]**
- Request: `GET /api/get_analytics?days=99999&limit=-5&type=nonsense` and `GET /api/get_governance?limit=1e9`.
- Expected: `days` clamped ≤365, `limit` clamped into `1..100` (or rejected), `type` → `400`/allow-list rejection; non-finite/huge numbers rejected.
- FAIL: `days=99999` reaches Ponder, negative `limit` interpolated, or `NaN`/`Infinity` propagates.

**T14 — junk XFF doesn't crash / inflate map [P1]**
- Request: `X-Forwarded-For: <2000-char garbage>` / control chars.
- Expected: normalized/rejected to a safe key; no crash; no log-injection newline in logs.
- FAIL: 500, giant map key, or forged log line.

**T15 — concurrency cap [P1]**
- Request: fire 300 concurrent `/api/get_dune_stats` (slow tool).
- Expected: excess → `503`/`429`; event loop stays responsive (`/health` still fast); Dune not hammered with 300 parallel executions.
- FAIL: all 300 dispatch, `/health` stalls, or 300 Dune executions launch.

**T16 — cache limits upstream fan-out [P1]**
- Request: 50 rapid `/api/get_protocol_snapshot` within the TTL window; observe upstream call count (staging instrumentation).
- Expected: ~1 upstream fan-out (plus single-flight), remainder served from cache.
- FAIL: 50× fan-out to CoinGecko/REST/Ponder.

**T17 — address-filter injection blocked [P1]**
- Request: `GET /api/get_positions?detail=true&collateral=0x1"} evil {`.
- Expected: `400`/validation reject (fails the address regex); nothing malformed reaches the Ponder `where` clause.
- FAIL: the value is interpolated into the GraphQL query.

**T18 — prototype pollution blocked [P0]**
- Request: `POST /api/get_challenges` body `{"__proto__":{"polluted":true}}`.
- Expected: `400 "Invalid JSON body"` (or stripped); afterward `({}).polluted === undefined`.
- FAIL: subsequent requests behave as if `polluted` is set globally.

**T19 — malformed JSON → 400 not 500 [P1]**
- Request: `POST /api/query_ponder` body `{ "query": `  (truncated/invalid JSON).
- Expected: `400 "Invalid JSON body"`.
- FAIL: `500` or a stack trace in the body.

**T20 — error envelope hides internals [P0]**
- Request: force an upstream failure (e.g. a tool during an upstream outage, or a crafted request that makes a handler throw).
- Expected: response is one of the fixed generic messages; contains no `e.message`, no upstream URL/path, no stack, no `api.frankencoin.com`/`coingecko`/`dune` host strings.
- FAIL: any upstream URL, status detail, secret, or stack frame present.

**T21 — secrets never leak [P0]**
- Request: probe `/health`, `/api`, `/api/get_market_data`, `/api/get_dune_stats`, and error paths; grep all responses + (staging) logs for the key values.
- Expected: key values appear nowhere; "key not configured" never returned to client (mapped to generic 502/503).
- FAIL: a key value or a "…API key not configured…" string in any client response.

**T22 — health minimized [P1]**
- Request: `GET /health`.
- Expected: lean `{status, server, version}` (+ optional coarse `activeSessions`); description references 13 tools; no webhook mention; no session IDs/IPs.
- FAIL: "17 tools"/"webhook" text, session detail, or IPs present.

**T23 — CORS policy exact [P1]**
- Request: `OPTIONS /api/get_savings` with `Origin: https://evil.example`.
- Expected: `204`; `Access-Control-Allow-Origin: *`; methods `GET, POST, DELETE, OPTIONS`; **no** `Access-Control-Allow-Credentials`.
- FAIL: `Allow-Credentials: true` present, or reflected specific origin alongside credentials.

**T24 — security headers present [P2]**
- Request: `GET /api/get_savings`.
- Expected: `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`; no `X-Powered-By`/`Server: Express`.
- FAIL: missing nosniff, cacheable data response, or framework banner leaked.

**T25 — content-type enforced [P1]**
- Request: `POST /api/query_ponder` with `Content-Type: text/plain` and a JSON body.
- Expected: `415 "unsupported media type"`.
- FAIL: body parsed and processed anyway.

**T26 — method allow-list [P1]**
- Request: `PUT /sse`, `DELETE /api/get_savings` (unsupported), `TRACE /mcp`.
- Expected: `405` with a correct `Allow` header for each route.
- FAIL: `200`, `500`, or missing/incorrect `Allow`.

**T27 — no outbound host redirection [P0]**
- Request: attempt to influence a destination host via any param (`query_ponder` body, `collateral`, `topic`).
- Expected: all outbound calls still go only to the hard-coded upstream hosts (verify via staging egress logs); no request to an attacker host.
- FAIL: any outbound request to a host derived from client input.

**T28 — knowledge path-traversal blocked [P1]**
- Request: `GET /api/get_knowledge?topic=../../etc/passwd` and `?topic=../../../README`.
- Expected: unknown-topic response `{error, availableTopics}`; no GitHub fetch built from the raw segment; no traversal.
- FAIL: a GitHub URL constructed from the raw `topic`, or a `500`.

**T29 — webhook surface gone [P0]**
- Request: `POST /webhooks/subscribe`, `GET /webhooks/status`, `POST /api/subscribe_events`, `GET /api/get_webhook_status`.
- Expected: all → clean `404` (webhook routes/tools do not exist); `/health` and `/api` list no webhook tools.
- FAIL: any webhook route/tool responds as if present.

---

## 11. Residual risks (accepted, documented)

- **Per-replica rate limiting & caching** — with multiple Railway replicas, effective rate limits are N× and cache hit-rate is lower (each replica caches independently). Accepted per "no Redis" constraint. Mitigate by setting conservative per-replica limits and, if abuse appears, reducing replica count or adding an edge rate limit at Railway.
- **No auth** — by design (public read-only). The controls above harden the open surface; they do not gate it. If abuse becomes untenable despite rate limits, the *minimal* escalation is an optional API-key/allow-list at the Railway edge, not in-app — out of current scope.
- **Upstream trust** — we trust api.frankencoin.com / Ponder / CoinGecko / Dune / llamarpc / GitHub / Shopify to not serve maliciously huge or hostile payloads. Size caps (§7) bound the blast radius; full validation of every upstream schema is not performed.
- **`query_ponder` remains an amplifier** even after validation — a single valid query can still be moderately expensive on Ponder. The per-IP sub-limit + no-cache + result cap bound it; complete cost accounting would require Ponder-side limits we don't control.
```
