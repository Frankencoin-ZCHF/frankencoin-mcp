# v3.3: provider reliability, freshness and compact responses

These are release changes, not evidence of deployment or uptime. The tool count stays at 17. REST transport success and dataset availability remain separate; availability and measurement freshness are also separate.

## Response defaults

- `get_protocol_snapshot` and `get_governance` default to compact FCS identity, state, provenance and material warnings. `includeContext=true` restores all mechanics and references. `get_knowledge?topic=fcs` always supplies the full reference. FCS and underlying FPS metrics remain separate. Governance discovery now describes the current shared >1% quorum, separately from binding.
- `get_collateral_assessments` defaults to `view=summary&limit=10&offset=0`. `pageInfo` exposes `totalMatching`, `hasNextPage` and `nextOffset`; `total` is the whole catalogue and `count` the current page. Follow `nextOffset` until null. `limit` accepts 1–50. Pagination happens before report downloads. `view=full` preserves every metadata field. An `asset` selector or `includeContent=true` also returns unabridged Markdown/source; pagination still applies. Supporting-document selectors are unchanged. Catalogue changes between requests can shift offset pages; this is not a version-pinned export.

## Dune and indexer alternatives

The legacy name `get_dune_stats` is retained. Queries use [GET latest published results](https://docs.dune.com/api-reference/executions/endpoint/get-query-result), never execute/poll or request query computation. Download credits and provider limits can still apply. Dune `executionId`, result completion time and actual HTTP retrieval time are retained. Completion time describes a query execution, not a blockchain synchronization guarantee.

`queries`/`duneStatus` report Dune health. `sources` identify the data actually returned. Missing keys, HTTP failures, empty/malformed results, truncated results and unverified schemas can trigger Ponder alternatives. A fallback does not mean the Dune queries have been repaired. Failed Dune/Pharos HTTP attempts are coalesced and cooled down for 60 seconds so repeated calls do not hammer a failing provider. One nonnegative integer `holders` row is supported; Dune series columns/units remain unverified, so their raw rows stay separately labelled in `unverifiedRows` and are never guessed into metrics.

| Metric | Indexer alternative and exact scope |
| --- | --- |
| ZCHF/FPS holders | `eRC20BalanceMappings.totalCount`, Ethereum, correct token, positive balance, zero address excluded. Includes contracts; not people, FCS holders, or a deduplicated cross-chain total. No indexer sync watermark: freshness unknown. |
| Minting | Last 30 UTC calendar days (current day incomplete) of Ethereum ZCHF Transfer events from the zero address. Gross issuance from all sources, not net supply change or borrowing volume. `mintedZchf`, exact `raw` integer (18 decimals), event count per observed day. Only event-bearing days are returned. Bounded pagination rejects incomplete totals; an empty index is not proof of zero real-world issuance. |
| Savings | Last 30 `analyticDailyLogs.totalSavings` entries. `tvlZchf` plus exact `raw` integer (18 decimals). Source `asOf` is the latest daily bucket timestamp, not an independently verified block time. |

The indexer fields/filters were verified against the live public GraphQL schema. Its completeness and synchronization are not independently proven. Do not compare provider totals without checking scope. Future source changes produce unavailable metrics rather than zero.

## Pharos and market data

The retired unversioned endpoint is replaced by `/api/report-cards/v9`, using the [provider's current API contract](https://pharos.watch/api/reference/). The three pillars are backing, exit and control; scores/grades are provider data, with no invented pillar letter grades or legacy dimension mapping. `not-rated`, `pipeline-gap`, partial evidence and publication holds remain distinguishable. A held publication is labelled `freshness.status=held` even if its timestamp is recent.

If detailed cards cannot be used, `/api/safety-grades` supplies the public overall grade without sending a key. This is explicitly partial: detailed pillars are null, and the primary-source failure remains visible. `asOf` is source measurement/publication-as-of time, `updatedAt` source publication time, and `retrievedAt` the cached HTTP retrieval time. Unknown/future source times stay null; age budget is two hours.

CHFAU `totalSupply()` reads verify chain ID 1 and use EIP-1898 `blockHash` with `requireCanonical=true`. PublicNode and dRPC are fixed-host alternatives. Empty, short or malformed uint256 replies are unavailable, not zero. Responses expose block number/hash, block timestamp, RPC and retrieval time; the ten-minute budget measures block age. `totalSupply` is Ethereum ERC-20 supply (6 decimals). The old `circulatingSupply` field remains a deprecated alias, with an explicit scope warning; it does not establish circulating supply, a CHF peg or market capitalization. The unrelated DeFiChain Apple CoinGecko mapping is removed from AAPLx; its available Frankencoin API price remains usable.

## FCS upstream block evidence

The companion API change pins the five FCS contract reads to one Ethereum block number and checks that block's hash again before publishing. Failed reads (except the explicitly labelled bid fallback) or a changed block hash retain the previous cached state **and its original metadata**.

MCP accepts `metadata.blockNumber`, `blockHash`, `blockTimestamp` (Unix seconds), `fetchedAt` (ISO), `sameBlock=true`, and `readStatus.bid`. Valid metadata yields:

- `measuredAt`: block timestamp; ten-minute age budget, reflecting the API's five-minute refresh schedule.
- `updatedAt`: upstream read completion.
- `retrievedAt`: actual MCP HTTP retrieval, retained through cache hits.
- `kind=api_reported_contract_reads`: still not independent MCP RPC verification.

Legacy or invalid metadata leaves block/time null and freshness unknown. A legacy bid of zero remains ambiguous/null; `readStatus.bid=available` permits a genuine zero and `fallback` forces null. Deploying only the MCP cannot create missing upstream evidence. Snapshot `generatedAt` (and legacy `updatedAt` alias) describes response assembly, never a common measurement block for the whole protocol.

## Validation and rollout

Hermetic tests cover published Dune reads, malformed schemas, failed/partial providers, exact raw units, incomplete pagination, missing/future/stale source times, cache timestamps, RPC failover/wrong chain/invalid uint256, lean/full REST responses and complete catalogue pagination. The companion API tests cover pinned reads, failed refreshes, reorg rejection and true-zero versus failed-bid handling.

Live checks on 2026-11-12 verified the public Pharos grade feed, all four indexer alternatives and CHFAU canonical-block RPC reads. No production Dune or Pharos key was available locally: authenticated published Dune results and full Pharos v9 cards require a post-deploy check. These checks do not establish uptime or constitute a security audit.

Deploy the API companion for FCS block evidence, then deploy this MCP release (either order is backward compatible). Verify `/health`, `/api`, `/llms.txt`, MCP discovery/calls, and inspect per-source status/freshness rather than just HTTP 200. Confirm Dune key/query access separately if Dune itself remains unavailable.
