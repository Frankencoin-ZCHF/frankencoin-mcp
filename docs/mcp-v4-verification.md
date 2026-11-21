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
