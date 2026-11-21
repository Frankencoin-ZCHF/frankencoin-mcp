# MCP v4 verification

The release targets [MCP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28). Run `npm ci && npm test` on Node 22. The suite starts real HTTP listeners and stdio child processes and uses the official modern and legacy clients. Its data-service regression tests use controlled upstream responses.

| Surface tested | Result on the release branch |
| --- | --- |
| Frankencoin application | 191 tests passed on Node 22, including discovery of the 17 tools, structured and text results, prompt retrieval, resource reads, version errors, header mismatches, concurrent legacy sessions and streamed-body limits. |
| Official HTTP conformance harness | The v4 HTTP router passed all 37 scored scenarios for the 2026-07-28 revision with the SDK diagnostic catalogue installed in a temporary test copy. The runner recorded 118 successful checks, two warnings and one informational result across those scenarios. |
| Production catalogue versus diagnostic catalogue | Direct application tests use Frankencoin names and schemas. Running the entire official fixture suite against the application catalogue yields missing demo tools, prompts and resource URIs. For example, it explicitly calls `test_simple_text` and reads `test://static-text`. |
| Legacy compatibility | The official v1 client initialized, listed tools, and terminated a Streamable HTTP session. It also connected through the legacy SSE endpoint. |

The harness run used `@modelcontextprotocol/conformance@0.2.0-alpha.12 server --requirements 2026-07-28`
with the [official SDK diagnostic registrations](https://github.com/modelcontextprotocol/typescript-sdk/blob/5ee54ee30ddc00a914a3d981880f87fdce0e6246/test/conformance/src/everythingServer.ts).
Only the server factory was substituted for this transport test. The router, classifier, origin checks and HTTP adapter came from Frankencoin.
The two warnings concern optional notifications after mutations in that diagnostic catalogue. Frankencoin's production catalogue is fixed and advertises `listChanged: false`.

The runner additionally executed 13 unscored scenarios. Nine failed in the optional Tasks extension, which this server does not advertise. The three pending schema and HTTP-header scenarios passed against the diagnostic catalogue. This verification covers a locally running release candidate.
