# Frankencoin MCP — Webhook / Event System Specification

**Version:** 1.0 — 2026-03-26  
**Status:** Design spec — no code  
**Author:** PA (subagent)

---

## Overview

Add a polling-based event detection and webhook delivery system to the existing Frankencoin MCP server. The poller runs inside the same Node.js process on a 60-second interval, detects 13 event types by diffing state from Ponder GraphQL, `api.frankencoin.com`, and CoinGecko, and delivers JSON payloads to subscriber-registered HTTP(S) URLs.

**Hard constraints (per Johannes):**
- Polling-based (no WebSocket/push from chain)
- Everything in the existing Node.js process — no sidecar, no queue, no external DB
- No auth on the MCP server itself (public read-only API)
- Poll interval: 60 seconds

---

## 1. Subscription API

### 1.1 HTTP Endpoints

All webhook endpoints live under `/webhooks/`. CORS headers are inherited from the existing server.

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/webhooks/subscribe` | Create a subscription |
| `DELETE` | `/webhooks/subscriptions/:id` | Remove a subscription |
| `GET` | `/webhooks/subscriptions` | List all subscriptions (optionally filtered by `?url=`) |
| `POST` | `/webhooks/subscriptions/:id/test` | Send a synthetic test event to the subscriber |
| `GET` | `/webhooks/events` | List supported event types + their filter schemas |

### 1.2 Subscribe — `POST /webhooks/subscribe`

**Request body:**

```json
{
  "url": "https://example.com/hook",
  "secret": "my-hmac-secret-32chars-min",
  "events": ["challenge_start", "depeg", "mint"],
  "filters": {
    "min_amount": 10000,
    "chain_id": 1,
    "address": "0xabc..."
  }
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `url` | string | **yes** | Must be HTTPS (HTTP allowed only for `localhost`/`127.0.0.1` — dev convenience). Max 2048 chars. |
| `secret` | string | **yes** | ≥ 32 chars. Used for HMAC-SHA256 signing. Stored hashed (SHA-256) — never returned in GET responses. |
| `events` | string[] | **yes** | At least one. Must be from the supported set (see §1.6). `["*"]` subscribes to all. |
| `filters` | object | no | Optional per-event filters. Applied as AND conditions. Unrecognized keys are silently ignored. |
| `filters.min_amount` | number | no | Minimum ZCHF amount (float, post-decimals). Applies to: `mint`, `burn`, `large_transfer`, `fps_large_trade`, `supply_change`. |
| `filters.chain_id` | number | no | Only events from this chain. Applies to all event types that carry `chain_id`. |
| `filters.address` | string | no | Match on position/owner/trader address (case-insensitive). Applies to: `mint`, `burn`, `challenge_*`, `fps_large_trade`, `minter_proposed`, `minter_approved`. |

**Response — 201 Created:**

```json
{
  "ok": true,
  "subscription": {
    "id": "sub_a1b2c3d4e5f6",
    "url": "https://example.com/hook",
    "events": ["challenge_start", "depeg", "mint"],
    "filters": { "min_amount": 10000, "chain_id": 1 },
    "created_at": "2026-03-26T08:00:00.000Z",
    "expires_at": "2026-04-02T08:00:00.000Z"
  }
}
```

**Error responses:**
- `400` — missing/invalid fields, `url` not HTTPS, `secret` too short, unknown event types
- `429` — max subscriptions reached (see §1.5)

### 1.3 Unsubscribe — `DELETE /webhooks/subscriptions/:id`

**Response — 200:**
```json
{ "ok": true, "deleted": "sub_a1b2c3d4e5f6" }
```

**404** if subscription ID not found.

### 1.4 List — `GET /webhooks/subscriptions`

Optional query param: `?url=https://example.com/hook` (exact match).

**Response — 200:**
```json
{
  "ok": true,
  "subscriptions": [
    {
      "id": "sub_a1b2c3d4e5f6",
      "url": "https://example.com/hook",
      "events": ["challenge_start", "depeg"],
      "filters": { "min_amount": 10000 },
      "created_at": "2026-03-26T08:00:00.000Z",
      "expires_at": "2026-04-02T08:00:00.000Z",
      "delivery_stats": {
        "total_delivered": 42,
        "total_failed": 1,
        "last_delivered_at": "2026-03-26T07:55:12.000Z",
        "last_status_code": 200,
        "consecutive_failures": 0
      }
    }
  ],
  "total": 1
}
```

`secret` is **never** returned. `delivery_stats` helps subscribers debug connectivity.

### 1.5 Subscription Lifecycle

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| **TTL** | 7 days from creation | Prevents zombie subscriptions. Subscriber must re-subscribe before expiry. |
| **Max subscriptions (global)** | 100 | Memory budget. No auth = must cap globally. |
| **Max subscriptions per URL** | 5 | Prevents a single subscriber from monopolizing. |
| **Subscription ID format** | `sub_` + 12-char hex (`crypto.randomBytes(6).toString('hex')`) | Short, unique, URL-safe. |
| **Auto-delete on consecutive failures** | 10 | After 10 consecutive delivery failures (not retries — 10 separate events), the subscription is marked dead and deleted. |

**Re-subscribe:** Client creates a new subscription; old one remains until TTL or manual delete. No "renew" endpoint — simplicity over convenience.

### 1.6 Supported Event Types

```
mint, burn, large_transfer, challenge_start, challenge_bid, challenge_end,
depeg, depeg_resolved, fps_large_trade, minter_proposed, minter_approved,
rate_change, supply_change
```

### 1.7 Storage: In-Memory (Decision)

**Choice: In-memory `Map<string, Subscription>`.**

Justification: With a 7-day TTL, max 100 subscriptions, no auth, and a public server, the cost of losing subscriptions on restart is low — subscribers will re-subscribe. SQLite adds a dependency, file I/O complexity, and schema migrations for negligible benefit in v1. Poller state (last-seen cursors) is also in-memory — a restart simply means the first poll cycle after boot won't emit events (no baseline to diff against), which is the correct behavior.

The `Subscription` object in memory:

```
{
  id: string,
  url: string,
  secretHash: string,        // SHA-256 of the plaintext secret
  secretRaw: string,         // plaintext secret for HMAC signing (kept in memory only)
  events: Set<string>,
  filters: { min_amount?: number, chain_id?: number, address?: string },
  createdAt: number,         // epoch ms
  expiresAt: number,         // epoch ms
  deliveryStats: {
    totalDelivered: number,
    totalFailed: number,
    lastDeliveredAt: number | null,
    lastStatusCode: number | null,
    consecutiveFailures: number,
  }
}
```

### 1.8 Test Endpoint — `POST /webhooks/subscriptions/:id/test`

Sends a synthetic event payload to the subscriber URL with `event_type: "test"`. The payload is signed with the subscriber's secret. Returns delivery result:

```json
{
  "ok": true,
  "delivered": true,
  "status_code": 200,
  "response_time_ms": 145
}
```

Or on failure: `{ "ok": true, "delivered": false, "error": "timeout after 5000ms" }`.

Does **not** count toward `consecutiveFailures`.

---

## 2. Event Delivery

### 2.1 Payload Schema

Every webhook delivery is a JSON POST to the subscriber's URL.

```json
{
  "id": "evt_1a2b3c4d5e6f7890",
  "event_type": "challenge_start",
  "timestamp": "2026-03-26T08:01:00.000Z",
  "data": {
    "chain_id": 1,
    "chain_name": "Ethereum",
    "position": "0xabc...",
    "challenger": "0xdef...",
    "collateral_symbol": "WBTC",
    "size": 1.5,
    "size_raw": "150000000",
    "liquidation_price_zchf": 85000.0,
    "challenge_value_zchf": 127500.0,
    "tx_hash": "0x123...",
    "started_at": "2026-03-26T08:00:45.000Z",
    "duration_seconds": 86400
  },
  "source": "ponder",
  "server_version": "2.0.0"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique event ID: `evt_` + 16-char hex. Idempotency key for subscribers. |
| `event_type` | string | One of the 13 types + `test`. |
| `timestamp` | ISO 8601 | When the MCP server detected the event (not the on-chain timestamp). |
| `data` | object | Event-type-specific payload (see §2.2). |
| `source` | string | `"ponder"`, `"api"`, or `"coingecko"` — which data source triggered detection. |
| `server_version` | string | MCP server version from `package.json`. |

### 2.2 Per-Event-Type Data Fields

**`mint`**
```
{ chain_id, chain_name, position, owner, collateral_symbol, minted_zchf, minted_raw, tx_hash }
```

**`burn`**
```
{ chain_id, chain_name, position, owner, collateral_symbol, burned_zchf, burned_raw, tx_hash }
```

**`large_transfer`**
```
{ chain_id, chain_name, from, to, amount_zchf, amount_raw, tx_hash }
```

**`challenge_start`**
```
{ chain_id, chain_name, position, challenger, collateral_symbol, size, size_raw,
  liquidation_price_zchf, challenge_value_zchf, tx_hash, started_at, duration_seconds }
```

**`challenge_bid`**
```
{ chain_id, chain_name, position, challenge_number, bidder, bid_amount_zchf, filled_size, tx_hash }
```

**`challenge_end`**
```
{ chain_id, chain_name, position, challenge_number, outcome: "success"|"averted",
  collateral_acquired, amount_zchf, tx_hash }
```

**`depeg`**
```
{ price_chf, deviation_percent, direction: "above"|"below", threshold_percent: 0.5, source: "coingecko" }
```

**`depeg_resolved`**
```
{ price_chf, deviation_percent, resolved_from: "above"|"below", threshold_percent: 0.3 }
```

**`fps_large_trade`**
```
{ kind: "buy"|"sell", trader, shares_traded, price_chf, amount_zchf, tx_hash }
```

**`minter_proposed`**
```
{ chain_id, chain_name, minter_address, suggestor, application_fee_zchf, apply_message,
  application_period_seconds, tx_hash }
```

**`minter_approved`**
```
{ chain_id, chain_name, minter_address, suggestor, tx_hash, applied_at }
```

**`rate_change`**
```
{ chain_id, chain_name, module, old_rate_percent, new_rate_percent, tx_hash }
```

**`supply_change`**
```
{ chain_id, chain_name, old_supply, new_supply, change_amount, change_percent }
```

### 2.3 HMAC-SHA256 Signing

Every delivery includes these headers:

| Header | Value |
|--------|-------|
| `X-Frankencoin-Signature` | `sha256=<hex-encoded HMAC-SHA256>` |
| `X-Frankencoin-Event` | Event type string (e.g. `challenge_start`) |
| `X-Frankencoin-Delivery` | The event `id` field |
| `X-Frankencoin-Timestamp` | Unix epoch seconds (string) |
| `Content-Type` | `application/json` |
| `User-Agent` | `frankencoin-mcp/<version>` |

**What gets signed:** The raw JSON request body string (the exact bytes sent).

**Algorithm:** `HMAC-SHA256(secretRaw, bodyString)` → hex-encoded.

**Subscriber verification pseudocode:**
```
expected = hmac('sha256', secret, request.body.raw).hex()
actual = request.headers['X-Frankencoin-Signature'].replace('sha256=', '')
timingSafeEqual(expected, actual)
```

**Timestamp replay window:** Subscribers SHOULD reject deliveries where `X-Frankencoin-Timestamp` is > 300 seconds old. This is a subscriber-side concern, not enforced by the server.

### 2.4 Retry Logic

| Attempt | Delay after failure |
|---------|-------------------|
| 1st retry | 10 seconds |
| 2nd retry | 30 seconds |
| 3rd retry | 90 seconds |

**Max retries per event delivery: 3** (so up to 4 total attempts including the initial one).

A delivery "fails" if:
- HTTP response status ≥ 400 (or network error/DNS failure)
- Timeout exceeded (see §2.5)
- TLS error

A delivery "succeeds" if HTTP response status is 2xx. 3xx redirects are **not** followed — subscriber must provide the final URL.

**Dead letter:** Failed events after all retries are logged to stderr with `[webhook:dead-letter]` prefix and the event payload. No persistent dead letter queue in v1. The `consecutiveFailures` counter on the subscription increments. After 10 separate events fail all retries, the subscription is auto-deleted (see §1.5).

### 2.5 Delivery Guarantees

**At-least-once.** The same event may be delivered multiple times if the first attempt's response was lost (e.g., server received 200 but the socket dropped before the poller processed the ACK). Subscribers MUST use the `id` field for idempotency.

**Ordering:** Best-effort chronological within a single event type. No cross-type ordering guarantee.

### 2.6 Timeout

**5 seconds per delivery attempt.** Uses `AbortSignal.timeout(5000)` on `fetch()`. A slow subscriber gets retried, not waited on.

### 2.7 Concurrency

Deliveries for a single event are dispatched to all matching subscribers in parallel (`Promise.allSettled`). Retries for a given subscriber are sequential with the specified backoff. The retry queue is processed asynchronously — it does not block the next poll cycle.

---

## 3. Poller Architecture

### 3.1 Scheduler

**`setInterval` at 60,000 ms**, started after the HTTP server begins listening. Not a cron-style scheduler — we don't need calendar precision, and setInterval is simpler with zero dependencies.

The callback is wrapped in a guard: if the previous poll is still running (flag `isPolling`), the new tick is skipped. This prevents pile-up when Ponder is slow.

```
let isPolling = false;
const pollInterval = setInterval(async () => {
  if (isPolling) return;
  isPolling = true;
  try { await pollAllSources(); }
  catch (e) { console.error('[poller] error:', e.message); }
  finally { isPolling = false; }
}, 60_000);
```

### 3.2 State Management

The poller maintains a `PollerState` singleton object in memory:

```
{
  // Ponder cursor-based
  lastPositionCount: number | null,        // mint/burn: total count of positions items
  lastPositionMintedMap: Map<string, number>,  // position_address → minted amount (float)
  lastChallengeIds: Set<string>,           // challenge IDs seen (id = position+number)
  lastChallengeStatusMap: Map<string, string>, // challenge_id → status
  lastChallengeBidsMap: Map<string, number>,   // challenge_id → bids count
  lastEquityTradeCount: number | null,     // fps_large_trade: latest trade counter
  lastMinterAddresses: Set<string>,        // minter_proposed/approved: known minter addresses
  lastMinterDeniedMap: Map<string, boolean>,   // address → isDenied
  lastRateChangeCount: number | null,      // rate_change: latest count

  // API-based
  lastSupplyByChain: Map<number, number>,  // chain_id → supply (float)
  lastTotalSupply: number | null,

  // CoinGecko-based
  lastZchfPriceChf: number | null,
  isDepegged: boolean,                     // current depeg state (for depeg_resolved detection)
  depegDirection: "above" | "below" | null,

  // Bookkeeping
  initialized: boolean,                    // false until first successful poll (no events emitted on first cycle)
  lastPollAt: number | null,               // epoch ms
  consecutivePonderErrors: number,
  consecutiveCgErrors: number,
  consecutiveApiErrors: number,
}
```

**First poll after boot:** Populates all state fields. `initialized` flips to `true`. No events are emitted — there's nothing to diff against. This is intentional: a restart doesn't generate a flood of false events.

### 3.3 Per-Event-Type Polling Strategy

The 60s poll cycle makes **3 parallel fetch batches** (one per source), then diffs against stored state:

#### Batch 1: Ponder GraphQL (single request, multiple queries)

One batched GraphQL query:

```graphql
{
  positions: mintingHubV2PositionV2s(limit: 100, orderBy: "start", orderDirection: "desc") {
    items { position owner collateral collateralSymbol minted start closed denied }
  }
  challenges: mintingHubV2ChallengeV2s(limit: 50, orderBy: "start", orderDirection: "desc") {
    items { id position number challenger status bids size filledSize acquiredCollateral liqPrice start duration txHash }
  }
  trades: equityTrades(limit: 20, orderBy: "created", orderDirection: "desc") {
    items { count kind trader amount shares price created txHash }
  }
  minters: frankencoinMinters(limit: 50) {
    items { chainId minter applicationPeriod applicationFee applyMessage applyDate suggestor denyMessage denyDate txHash }
  }
  rates: leadrateRateChangeds(limit: 20, orderBy: "created", orderDirection: "desc") {
    items { chainId module approvedRate created txHash }
  }
}
```

**This is a single HTTP POST to `ponder.frankencoin.com`.** Ponder supports batched queries in one request.

**Diffing logic per event type:**

| Event | Detection |
|-------|-----------|
| `mint` | For each position in response: if `position.minted` (after `fromWei`) > `lastPositionMintedMap.get(address)`, emit `mint` with delta. If address is new and `minted > 0`, emit `mint`. |
| `burn` | For each position: if `position.minted` < `lastPositionMintedMap.get(address)`, emit `burn` with delta. |
| `large_transfer` | **Not from Ponder positions.** Requires a separate Ponder query for `eRC20TotalSupplys` — see Batch 2 note below. In v1, `large_transfer` is detected via supply changes per chain (see `supply_change`). A dedicated transfer-level query is out of scope for v1 (see §8). |
| `challenge_start` | New ID in `challenges` response not in `lastChallengeIds`. |
| `challenge_bid` | Existing challenge where `bids` count increased vs `lastChallengeBidsMap`. |
| `challenge_end` | Existing challenge where `status` changed to `"Success"` vs `lastChallengeStatusMap`. |
| `fps_large_trade` | Trades with `count` > `lastEquityTradeCount`. Filter: `fromWei(amount) >= min_amount` (default threshold: 1000 ZCHF if no subscriber filter). |
| `minter_proposed` | New address in `minters` not in `lastMinterAddresses`, where `denyDate` is null. |
| `minter_approved` | Existing minter where `applicationPeriod` has elapsed (compare `applyDate + applicationPeriod` vs now). Since Ponder doesn't have an explicit "approved" flag, a minter is "approved" when: (a) it's been in `lastMinterAddresses` for longer than `applicationPeriod` and (b) `denyDate` is still null. Emit once — track in a `Set<string> approvedEmitted`. |
| `rate_change` | Entry in `rates` with `created` > last-known latest `created`. Compare `approvedRate` with stored value for that chain+module to populate `old_rate_percent`. |

#### Batch 2: api.frankencoin.com (single request)

```
GET https://api.frankencoin.com/ecosystem/frankencoin/info
```

Returns chain-level supply breakdown and total supply.

| Event | Detection |
|-------|-----------|
| `supply_change` | Per-chain: if `abs(chain.supply - lastSupplyByChain.get(chainId))` exceeds threshold. Default threshold: 10,000 ZCHF (or subscriber's `min_amount`). Also detect total supply change. |

**`large_transfer` approximation (v1):** A per-chain supply change is a proxy for large mints/burns. True transfer tracking (A→B without supply change) requires indexing individual Transfer events, which Ponder doesn't expose as a top-level entity easily. Deferred to v2 (§8).

#### Batch 3: CoinGecko (single request)

```
GET https://pro-api.coingecko.com/api/v3/simple/price?ids=frankencoin&vs_currencies=chf
```

| Event | Detection |
|-------|-----------|
| `depeg` | `abs(price - 1.0) > 0.005` (0.5%) AND `isDepegged === false`. Set `isDepegged = true`, store `depegDirection`. |
| `depeg_resolved` | `abs(price - 1.0) <= 0.003` (0.3%) AND `isDepegged === true`. Set `isDepegged = false`. |

The asymmetric thresholds (0.5% to trigger, 0.3% to resolve) prevent flapping at the boundary.

### 3.4 Graceful Shutdown

On `SIGTERM` / `SIGINT`:

1. `clearInterval(pollInterval)` — stop scheduling new polls.
2. Set `shutdownRequested = true` — the current poll (if running) will finish its diff but skip delivery.
3. Wait up to 10 seconds for in-flight deliveries (`Promise.allSettled` on the active delivery batch).
4. Call `httpServer.close()`.
5. `process.exit(0)`.

### 3.5 Error Handling

| Source | Error | Behavior |
|--------|-------|----------|
| Ponder | Network error / 5xx | Increment `consecutivePonderErrors`. Skip Ponder-sourced events this cycle. Log `[poller] Ponder error (N consecutive): <msg>`. After 5 consecutive errors, log at `warn` level. State is NOT cleared — next successful poll resumes diffing normally. |
| Ponder | GraphQL error (partial data) | Process whatever data was returned. Log the error. |
| CoinGecko | 429 rate limit | Increment `consecutiveCgErrors`. Skip depeg check this cycle. The 60s interval means ~1 CG call/min, well within the Pro plan's 500/min limit. |
| CoinGecko | Network error / 5xx | Same as Ponder: skip, increment, log. |
| api.frankencoin.com | Any error | Same pattern. Supply change detection skipped for this cycle. |
| Delivery | Subscriber URL unreachable | Retry per §2.4. Does not block other subscribers or the poller. |

**No circuit breaker needed.** The poll interval is already 60s — if a source is down, we retry once per minute. The consecutive error counter is for observability (exposed in `/webhooks/status`, see §3.6).

### 3.6 Status Endpoint

**`GET /webhooks/status`** — operational health of the webhook system:

```json
{
  "ok": true,
  "poller": {
    "running": true,
    "initialized": true,
    "last_poll_at": "2026-03-26T08:01:00.000Z",
    "poll_interval_ms": 60000,
    "consecutive_errors": {
      "ponder": 0,
      "coingecko": 0,
      "api": 0
    }
  },
  "subscriptions": {
    "total": 3,
    "by_event": { "depeg": 2, "challenge_start": 3, "mint": 1 }
  },
  "delivery": {
    "total_delivered": 142,
    "total_failed": 3,
    "pending_retries": 1
  }
}
```

---

## 4. MCP Tools

### 4.1 Decision: Yes, expose webhook management as MCP tools.

**Rationale:** The MCP server's primary consumers are AI agents. Agents should be able to subscribe to events programmatically via the same MCP session they already use for data queries — no separate HTTP client setup needed. The MCP tools are thin wrappers around the same logic as the HTTP endpoints.

### 4.2 New MCP Tools

#### `subscribe_events`

```json
{
  "name": "subscribe_events",
  "description": "Subscribe to Frankencoin protocol events via webhook. Events are delivered as HTTP POST to your URL with HMAC-SHA256 signing. Supported events: mint, burn, large_transfer, challenge_start, challenge_bid, challenge_end, depeg, depeg_resolved, fps_large_trade, minter_proposed, minter_approved, rate_change, supply_change.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "url": { "type": "string", "description": "HTTPS URL to receive webhook payloads." },
      "secret": { "type": "string", "description": "HMAC secret for payload signing (min 32 chars). Store securely — not returned in responses." },
      "events": { "type": "string", "description": "Comma-separated event types to subscribe to. Use '*' for all." },
      "min_amount": { "type": "number", "description": "Minimum ZCHF amount filter (for amount-based events like mint, burn, fps_large_trade, supply_change)." },
      "chain_id": { "type": "number", "description": "Filter events to a specific chain (1=Ethereum, 8453=Base, 42161=Arbitrum, etc.)." },
      "address": { "type": "string", "description": "Filter by position/owner/trader address." }
    },
    "required": ["url", "secret", "events"]
  }
}
```

#### `unsubscribe_events`

```json
{
  "name": "unsubscribe_events",
  "description": "Remove a webhook subscription by ID.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "subscription_id": { "type": "string", "description": "Subscription ID (e.g. sub_a1b2c3d4e5f6)." }
    },
    "required": ["subscription_id"]
  }
}
```

#### `list_subscriptions`

```json
{
  "name": "list_subscriptions",
  "description": "List all active webhook subscriptions. Optionally filter by URL.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "url": { "type": "string", "description": "Filter subscriptions by URL (exact match)." }
    },
    "required": []
  }
}
```

#### `get_webhook_status`

```json
{
  "name": "get_webhook_status",
  "description": "Health status of the webhook/event system: poller state, subscription counts, delivery stats, error counters.",
  "inputSchema": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```

**Total tools after addition: 17** (13 existing + 4 new).

### 4.3 REST Equivalence

The 4 new tools are also available via REST at `/api/subscribe_events`, `/api/unsubscribe_events`, `/api/list_subscriptions`, `/api/get_webhook_status` — automatically, via the existing `dispatchTool` + `/api/:tool` routing in `index.js`. No additional REST endpoint code needed for these.

However, the HTTP webhook endpoints (`/webhooks/*`) remain as described in §1 — they provide a more REST-idiomatic interface (proper HTTP methods, resource-oriented URLs). Both interfaces call the same underlying functions.

---

## 5. File Structure

### 5.1 New Files

| File | Responsibility |
|------|----------------|
| `src/webhooks/subscriptions.js` | `SubscriptionStore` class: in-memory store, CRUD operations, TTL expiry, validation, filter matching. Exports singleton instance. |
| `src/webhooks/poller.js` | `EventPoller` class: 60s interval, state management, 3-batch fetch, diff logic, event detection. Exports `startPoller(store)` and `stopPoller()`. |
| `src/webhooks/delivery.js` | `deliverEvent(subscription, event)`: HMAC signing, HTTP POST, retry logic with backoff, dead-letter logging. Exports `dispatchToSubscribers(store, event)`. |
| `src/webhooks/events.js` | Event type definitions: supported types set, per-type filter applicability, default thresholds, payload builder functions per event type. |
| `src/webhooks/routes.js` | HTTP route handler for `/webhooks/*` endpoints: `handleWebhookRequest(req, res, url, store)`. Follows same pattern as existing route handling in `index.js`. |
| `src/webhooks/index.js` | Barrel export: re-exports `SubscriptionStore`, `startPoller`, `stopPoller`, `handleWebhookRequest`. |

### 5.2 Modified Files

| File | Change |
|------|--------|
| `src/index.js` | (1) Import `{ SubscriptionStore, startPoller, stopPoller, handleWebhookRequest }` from `./webhooks/index.js`. (2) Instantiate `const store = new SubscriptionStore()` before HTTP server creation. (3) Add route block for `url.pathname.startsWith("/webhooks/")` → `handleWebhookRequest(req, res, url, store)`. (4) Call `startPoller(store)` after `httpServer.listen()`. (5) Add `SIGTERM`/`SIGINT` handler calling `stopPoller()` then `httpServer.close()`. (6) Add 4 new cases to `dispatchTool` switch for the MCP tools. (7) Update `tools` list in health endpoint to include new tools. |
| `src/tools.js` | Add 4 new tool definitions to the `TOOLS` array (schemas from §4.2). |
| `src/api.js` | Add re-export of webhook dispatch functions used by `dispatchTool` (or import directly in `index.js` — either works, but barrel keeps it consistent). |

### 5.3 Directory Layout After Changes

```
src/
  index.js           (modified)
  tools.js           (modified)
  api.js             (modified)
  api/
    snapshot.js      (unchanged)
    market.js        (unchanged)
    savings.js       (unchanged)
    governance.js    (unchanged)
    positions.js     (unchanged)
    analytics.js     (unchanged)
    content.js       (unchanged)
    helpers.js       (unchanged — ponderQuery, cgFetch, apiFetch, fromWei reused by poller)
  webhooks/
    index.js         (barrel)
    subscriptions.js (store)
    poller.js        (event detection)
    delivery.js      (HTTP delivery + HMAC)
    events.js        (type definitions + payload builders)
    routes.js        (HTTP endpoint handlers)
```

---

## 6. Integration Points

### 6.1 Shared State

The `SubscriptionStore` instance is created once in `index.js` and passed by reference to:
- `handleWebhookRequest(req, res, url, store)` — for HTTP endpoints
- `startPoller(store)` — the poller holds a reference and calls `store.getMatchingSubscriptions(eventType, eventData)` on each detected event
- `dispatchTool()` in `index.js` — for MCP tool calls (closures over `store`)

The poller's internal `PollerState` lives inside the `EventPoller` class — it's not shared with anything. Only the poller reads/writes it.

### 6.2 Wiring in index.js

```
// After httpServer.listen():
import { SubscriptionStore, startPoller, stopPoller, handleWebhookRequest } from "./webhooks/index.js";

const webhookStore = new SubscriptionStore();

// Inside httpServer request handler, before the 404 fallthrough:
if (url.pathname.startsWith("/webhooks/")) {
  return handleWebhookRequest(req, res, url, webhookStore);
}

// After httpServer.listen() callback:
startPoller(webhookStore);

// Shutdown:
process.on('SIGTERM', async () => { ... });
```

### 6.3 Reuse of Existing Helpers

The poller imports from `./api/helpers.js`:
- `ponderQuery` — for the batched Ponder GraphQL query
- `apiFetch` — for `api.frankencoin.com` supply data
- `cgFetch` — for CoinGecko price data
- `fromWei`, `bpsToPercent` — for number conversion
- `CHAIN_NAMES` — for human-readable chain names

No duplication. The poller is a consumer of the same data layer as the existing tools.

### 6.4 Impact on Existing Tools

**None.** The 13 existing tools are pure pull-based functions. They don't share mutable state with the poller. The poller makes its own API calls independently. The only shared resource is the Node.js event loop and outbound network connections, which is acceptable.

---

## 7. Deployment Considerations

### 7.1 Persistence

**Subscriptions are lost on restart.** This is acceptable for v1 (see §1.7 rationale). The `/webhooks/status` endpoint and delivery stats help subscribers detect when they need to re-subscribe.

**Poller state is lost on restart.** First poll after boot is a baseline — no events emitted. Second poll (60s later) is the first that can detect changes. Maximum event detection latency after restart: ~120 seconds.

### 7.2 Memory Footprint

| Component | Estimate |
|-----------|----------|
| SubscriptionStore (100 subs) | ~50 KB |
| PollerState (position map, challenge sets) | ~200 KB (assuming ~500 active positions, ~50 challenges, ~100 minters) |
| Retry queue (worst case: 100 subs × 3 retries × 1 KB payload) | ~300 KB |
| **Total overhead** | **< 1 MB** |

Negligible vs the existing server's baseline memory usage.

### 7.3 Rate Limit Exposure

**Per 60-second poll cycle:**

| Source | Calls | Limit |
|--------|-------|-------|
| Ponder GraphQL | 1 (batched) | No documented rate limit; batching keeps it to 1 req/min |
| api.frankencoin.com | 1 | No documented rate limit; 1 req/min is trivial |
| CoinGecko Pro | 1 | 500/min; we use 1/min = 0.2% of budget |

**Total outbound: 3 HTTP requests per minute** from the poller. The existing tool calls by agents add to this, but those are pull-based and separate.

### 7.4 Startup Behavior

- `stdio` mode: Poller does **not** start. Webhooks are an HTTP-mode feature only. (No subscribers can register via stdio, and there's no HTTP server to receive subscriptions.)
- `--http` mode: Poller starts automatically after `httpServer.listen()`. First poll at T+0 (baseline), first event-capable poll at T+60s.

---

## 8. Out of Scope (v1)

| Feature | Reason |
|---------|--------|
| **`large_transfer` as individual A→B transfers** | Ponder doesn't expose raw ERC-20 Transfer events as a top-level entity. Would require a custom Ponder query or a new indexed entity. In v1, supply_change per chain serves as a proxy. |
| **Persistent subscription storage (SQLite/file)** | Adds dependency and complexity. 7-day TTL + easy re-subscribe makes in-memory acceptable. |
| **Authentication / API keys for webhook endpoints** | Server is public/read-only. Abuse prevention is handled via global caps (100 subs, 5 per URL). |
| **WebSocket push (alternative to webhook POST)** | Would require maintaining WebSocket connections. HTTP POST webhooks are simpler and work with any subscriber (including serverless functions). |
| **Webhook payload filtering / transformation** | Subscribers get the full payload for their event type. Field selection or JSONPath filtering is not supported. |
| **Multi-tenant / per-user subscription namespaces** | No auth = no users. Global namespace with URL-based caps. |
| **UI / dashboard for webhook management** | CLI / API / MCP tools only. |
| **Historical event replay** | Events are not stored. Subscribers who miss events should use the existing pull-based tools to catch up. |
| **Rate limiting per subscriber URL** | Delivery rate is bounded by poll frequency (max 1 batch per 60s). No per-subscriber throttle needed. |
| **Configurable poll interval** | Fixed at 60s. Could be made configurable via env var in a future version, but not worth the complexity now. |
| **Dead letter queue with replay** | Failed deliveries are logged to stderr. No persistent queue or replay mechanism. |
| **Challenge bid amount / details** | Ponder's `mintingHubV2ChallengeV2s` entity tracks `bids` (count) but not individual bid details. We detect bid count increases but can't attribute to specific bidders without a sub-query. Accepted limitation. |

---

## Appendix A: Default Thresholds

These apply when a subscriber does not set `filters.min_amount`:

| Event | Default threshold |
|-------|------------------|
| `mint` | 0 (all mints) |
| `burn` | 0 (all burns) |
| `large_transfer` | (deferred to v2) |
| `fps_large_trade` | 1,000 ZCHF |
| `supply_change` | 10,000 ZCHF (per chain) |

These are tunable constants in `src/webhooks/events.js`.

## Appendix B: Example Subscriber Flow

1. Agent calls MCP tool `subscribe_events` with `url`, `secret`, `events: ["depeg", "challenge_start"]`, `min_amount: 50000`.
2. Server creates subscription, returns `subscription_id`.
3. Agent calls `subscribe_events` test endpoint (or MCP tool with test flag) to verify connectivity.
4. Poller runs every 60s. On detecting a new challenge with value > 50,000 ZCHF:
   - Builds `challenge_start` payload.
   - Matches against subscriptions with `challenge_start` in their events and `min_amount <= challenge_value`.
   - POSTs signed payload to subscriber URL.
5. Subscriber verifies HMAC, processes event.
6. Subscription expires after 7 days. Agent re-subscribes if still active.

## Appendix C: Implementation Order

Recommended build sequence for the coding agent:

1. `src/webhooks/events.js` — type definitions, thresholds, payload builders (pure functions, easily testable)
2. `src/webhooks/subscriptions.js` — in-memory store with CRUD + filter matching
3. `src/webhooks/delivery.js` — HMAC signing + HTTP POST + retry
4. `src/webhooks/routes.js` — HTTP endpoint handlers
5. `src/webhooks/poller.js` — the big one: batched fetch, state diffing, event emission
6. `src/webhooks/index.js` — barrel
7. `src/tools.js` — add 4 tool definitions
8. `src/index.js` — wire everything together
9. Test with `POST /webhooks/subscribe` + `POST /webhooks/subscriptions/:id/test`
