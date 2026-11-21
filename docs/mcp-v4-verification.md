# MCP v4 verification

The release targets [MCP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28). Run `npm ci && npm test` on Node 22. The suite starts real HTTP listeners and stdio child processes and uses the official modern and legacy clients. Its data-service regression tests use controlled upstream responses.

| Surface tested | Result on the release branch |
| --- | --- |
| Frankencoin application | 194 tests passed on Node 22, including discovery of the 17 tools, structured and text results, prompt retrieval, resource reads, version errors, header mismatches, concurrent legacy sessions and streamed-body limits. |
| Official HTTP conformance harness | The v4 HTTP router passed all 37 scored scenarios for the 2026-07-28 revision with the SDK diagnostic catalogue installed in a temporary test copy. The runner recorded 118 successful checks, two warnings and one informational result across those scenarios. |
| Production catalogue versus diagnostic catalogue | Direct application tests use Frankencoin names and schemas. Running the entire official fixture suite against the application catalogue yields missing demo tools, prompts and resource URIs. For example, it explicitly calls `test_simple_text` and reads `test://static-text`. |
| Legacy compatibility | The official v1 client initialized, listed tools, and terminated a Streamable HTTP session. It also connected through the legacy SSE endpoint. |

The harness run used `@modelcontextprotocol/conformance@0.2.0-alpha.12 server --requirements 2026-07-28`
with the [official SDK diagnostic registrations](https://github.com/modelcontextprotocol/typescript-sdk/blob/5ee54ee30ddc00a914a3d981880f87fdce0e6246/test/conformance/src/everythingServer.ts).
Only the server factory was substituted for this transport test. The router, classifier, origin checks and HTTP adapter came from Frankencoin.
The two warnings concern optional notifications after mutations in that diagnostic catalogue. Frankencoin's production catalogue is fixed and advertises `listChanged: false`.

The runner additionally executed 13 unscored scenarios. Nine failed in the optional Tasks extension, which this server does not advertise. The three pending schema and HTTP-header scenarios passed against the diagnostic catalogue. This verification covers a locally running release candidate.

## Live snapshot benchmark, 21 November 2026

Node 22 served local Streamable HTTP endpoints with real upstream providers. The v3.2 baseline was main at f164c38. Each of three rounds started fresh, isolated processes for all three variants, connected an official client, then timed the first successful tool call and ten immediate repeats. The three variants ran concurrently per round. Connection setup and process startup are excluded. Response size is the byte length of the serialized MCP tool result, including both structured and text content.

| Mode | First call, median of 3 | Cached call, median of 30 | Result bytes |
| --- | ---: | ---: | ---: |
| v3.2 full | 8.42 s | 2.48 ms | 20,403 |
| v4 full | 4.48 s | 3.64 ms | 13,189 |
| v4 overview | 4.45 s | 3.13 ms | 3,043 |

The full snapshot now requests enrichment for active challenges only. The gain depends on the challenge population and upstream latency. The overview reads one Frankencoin endpoint. Measurements describe this local client and these live upstreams, with public-server traffic, client internet latency and LLM processing outside the measurement.

## Analytics and availability verification

The expanded catalogue contains 27 tools. Account analysis uses chain IDs, addresses and contract evidence. No address book, name resolution or wallet ownership enrichment is configured. Financial results identify their units, source scope and observation time. A missing chain balance suppresses the portfolio total. A missing CEX book or DEX route has an explicit status. Chainlink lookups verify the chain and token on each leg. FCS scenario reads use a single canonical Ethereum block hash.

The outbound pool admits eight active requests by default and queues up to 128 additional requests for at most two seconds. Transient failures on an origin open a ten-second circuit after three failed logical reads. A single probe checks recovery. Retries, timeouts, response byte limits and a shared request budget bound each upstream read. A tool that calls providers in sequence can take longer. Cached reads coalesce by key. The cache bounds both entry count and serialized data volume (64 MiB by default, configurable with `CACHE_MAX_BYTES`). This is a serialized-value budget, not a process RSS limit.

Run `npm test` on Node 22. Fault-injection cases cover provider rate limits, oversized and interrupted bodies, queue saturation and recovery, cache pressure, provider isolation, RPC reorganisation, partial receipts and indexer outages, incomplete balances, mismatched quote assets, insufficient order-book depth, and removal of upstream wallet labels.

For a deployment check, run the real MCP client over the public endpoint, request the new tools list, run one cold and several warm data reads, and inspect provider-level availability in each result. HTTP liveness alone does not establish data availability. Public RPCs, indexers and exchange APIs have independent latency, availability and indexing lag. Instances maintain separate caches and rate counters.

On 21 November 2026 the expanded application passed 217 tests on Node 22. Live reads exercised all 21 accounting modes, an FCS contract preview, protocol events and receipts, Base pool discovery, peg candles, and both legs of an Ethereum-to-Optimism ZCHF transfer. A local HTTP holder-page read with live upstream data took 3.98 seconds cold. The next 50 reads in groups of five all returned HTTP 200, with 3 ms median and 7 ms p95. The earlier transport conformance run used the initial v4 catalogue and fixtures described above.

The five getting-started headings use the English website directory at `src/content/en/use-cases.json` on `main`. Its `gettingStarted` map selects case IDs for each heading. The overview and the links topic share a validated snapshot. On the first request after five minutes, the server refreshes it. Missing IDs are omitted, including when a case is removed before its selection is edited. During a source outage, the response marks the last successful snapshot stale and retries on demand after 30 seconds. This fallback lives in process memory. A fresh process without a successful read returns the headings and the directory link.

## Public release audit, 21 November 2026

The public endpoint advertised v4.0.0 and all 27 tools after the merge of c4705b9. A pinned official client called every tool with representative read-only arguments. All 27 produced structured results; source availability varied. The market, risk, challenge and Dune responses included partial, stale or unavailable datasets. For a 1,000 ZCHF sell, Velora and both Kraken books quoted; MEXC was unavailable. The knowledge directory returned the corrected Plusplus listing and omitted Zeal.

### Response times

One external probe through its network proxy timed actual Streamable HTTP requests. Each tool below had one initial call and eight immediate repeat calls, with at most two benchmark streams active. Times include the network and client processing. The initial call can hit existing caches. Eight repeats are too few for a reliable production tail percentile.

| Operation | Initial | Median repeat | Slowest repeat |
| --- | ---: | ---: | ---: |
| Knowledge index | 296 ms | 309 ms | 342 ms |
| Getting-started overview | 4,313 ms | 336 ms | 362 ms |
| Lean snapshot | 398 ms | 325 ms | 335 ms |
| Full snapshot | 345 ms | 338 ms | 357 ms |
| Five holders | 371 ms | 328 ms | 348 ms |
| FCS votes | 399 ms | 332 ms | 441 ms |
| Sized liquidity | 1,106 ms | 585 ms | 609 ms |

Eight additional fresh SDK clients performed discovery followed by tool listing. Six completed each request in 316–375 ms. The first two took 4.15–4.19 s for discovery and 4.23–4.99 s for tool listing. Deployment v4.0.0 had no application-duration header, so these observations cannot distinguish server delay, edge handling and the probe’s network path. The revenue report and risk lookup also took 4.00 s and 3.12 s respectively on their sampled calls.

### Interoperability and limits

- Production discovery, structured and text tool results, resources, prompts, validation errors, legacy Streamable HTTP and legacy SSE were exercised with official clients. Both legacy transports listed 27 tools.
- On production, the official resource-not-found scenario passed all four checks. The stateless scenario recorded 24 successes, four failures explicitly tagged untestable because the catalogue lacks diagnostic-only tools, and two skipped dynamic-list notification checks.
- The official 2026-07-28 requirements run on the merged router with the SDK diagnostic catalogue passed all 37 scored scenarios (118 successful checks, two warnings and one informational result). Nine unscored optional Tasks scenarios failed. Tasks are not advertised. The unmodified release application passed 218 Node 22 tests.
- A local MCP test with a controlled 45 ms ledger dependency completed 1,000 of 1,000 requests at concurrency eight, with p50 10 ms and p95 16 ms. It made one upstream read. A separate 25-way burst from one IP against a delayed source admitted 10 and returned explicit rate-limit results to 70. All 20 follow-up requests succeeded.
- The public probe used one vantage point and a bounded request rate. The local concurrency results measure application overhead and backpressure, not Railway capacity, multi-region latency, or an uptime SLA.

### Follow-up patch

CEX books are shared across sizes, sides and chains for five seconds; failed reads are suppressed for the same short window. Each fill is still computed for the requested size, with the book’s original observation time. In two parallel local runs against real providers, the pre-patch handler had three repeats over 3.6 seconds; all eight immediate post-patch repeats completed in under one millisecond. This measures the service function before network transport. The patch adds a Server-Timing app duration from HTTP request receipt to first response headers, and a repeatable low-volume public check with `node scripts/verify-live.mjs`.

A one-minute local run at 80 calls/second completed all 4,800 calls. A separate retention check completed 15,000/15,000 calls. Its combined client/server process used approximately 240 MiB RSS at both 10,000 and 15,000 calls. Post-GC heap grew from 30.4 MiB at 1,000 calls to 35.3 MiB at 15,000; this short run does not establish long-term memory stability. These runs used a controlled ledger upstream and a raised local rate limit.

The proposed v4.0.1 passed 219 application tests and the same 37 scored transport scenarios. Eight loopback client sessions on the patch took 2–11 ms for discovery and 4–12 ms for tool listing. The public endpoint still needs the post-deployment comparison to attribute its slower first requests.
