import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
process.env.CACHE_ENABLED = "false";
process.env.DUNE_API_KEY = "test-only-secret";
process.env.PHAROS_API_KEY = "test-only-secret";
const { setFetchImpl } = await import("../../src/upstream/client.js");
const { dispatchTool } = await import("../../src/tools/dispatch.js");
const { ethRead } = await import("../../src/upstream/eth.js");
const { FCS_CONTRACT, CHFAU_CONTRACT } = await import("../../src/lib/constants.js");
let calls, route;
const now = () => Math.floor(Date.now() / 1000);
const response = (x, status = 200) => Response.json(x, { status });
beforeEach(() => {
  calls = []; route = () => undefined;
  setFetchImpl(async (url, opts) => { calls.push({ url, opts }); return route(url, opts) ?? response({}, 400); });
});
const card = () => ({ id: "zchf-frankencoin", score: 84, grade: "A", ratingStatus: "rated", partialEvidence: null,
  pillars: Object.fromEntries(["backing", "exit", "control"].map((key) => [key, { score: 80, evidenceLevel: "full", freshness: "fresh", aggregationDisposition: "included", reasons: [] }])) });
const pharos = () => ({ model: "v9", schemaVersion: 9, asOfSec: now(), updatedAt: now(), methodology: { version: "10.44" }, publicationHealth: { status: "current" }, cards: [card()] });

test("Pharos v9 uses current pillars and provider grade, never legacy dimension grades", async () => {
  route = () => response(pharos());
  const { pharos: p } = await dispatchTool("get_risk", { source: "pharos" });
  assert.equal(p.status, "available"); assert.equal(p.overallScore, 84); assert.equal(p.overallGrade, "A");
  assert.deepEqual(p.pillars.map((x) => x.key), ["backing", "exit", "control"]);
  assert.equal(p.dimensions, undefined); assert.equal(p.pillars[0].grade, undefined);
  assert.equal(p.freshness.status, "fresh"); assert.ok(p.retrievedAt);
  assert.equal(calls.length, 1); assert.ok(calls[0].url.endsWith("/api/report-cards/v9"));
});

test("Pharos retired or unavailable detailed API falls back to public grade without transmitting a key", async () => {
  route = (url) => url.endsWith("/v9") ? response({}, 410) : response({ schemaVersion: 1, model: "v9", methodologyVersion: "10.44", asOfSec: now(), updatedAt: now(), publicationStatus: "current", grades: [card()] });
  const { pharos: p } = await dispatchTool("get_risk", { source: "pharos" });
  assert.equal(p.status, "partial"); assert.equal(p.overallScore, 84); assert.equal(p.pillars, null);
  assert.equal(p.primarySource.httpStatus, 410); assert.equal(p.source.kind, "public_overall_grade");
  assert.equal(calls[1].opts.headers["X-API-Key"], undefined);
});

for (const mode of ["held", "stale", "future", "missing-time", "partial-evidence", "not-rated"]) test(`Pharos discloses ${mode} rather than claiming full fresh coverage`, async () => {
  const data = pharos();
  if (mode === "held") data.publicationHealth.status = "held";
  if (mode === "stale") data.asOfSec = now() - 7201;
  if (mode === "future") data.asOfSec = now() + 3600;
  if (mode === "missing-time") delete data.asOfSec;
  if (mode === "partial-evidence") data.cards[0].partialEvidence = { excludedPillars: ["exit"] };
  if (mode === "not-rated") Object.assign(data.cards[0], { score: null, grade: "NR", ratingStatus: "not-rated" });
  route = () => response(data);
  const { pharos: p } = await dispatchTool("get_risk", { source: "pharos" });
  // NR is an actual provider classification, not a failed fetch or a zero score.
  if (mode === "not-rated") { assert.equal(p.overallScore, null); assert.equal(p.ratingStatus, "not-rated"); }
  else assert.equal(p.status, "partial");
  if (mode === "stale") assert.equal(p.freshness.status, "stale");
  if (["future", "missing-time"].includes(mode)) assert.equal(p.asOf, null);
});

test("Pharos pipeline gap and obsolete schemas are unavailable when fallback has no card", async () => {
  for (const body of [{ cards: [{ id: "zchf-frankencoin", overallScore: 84 }] }, { ...pharos(), cards: [{ ...card(), score: null, grade: null, ratingStatus: "pipeline-gap" }] }]) {
    route = (url) => url.endsWith("/v9") ? response(body) : response({ schemaVersion: 1, model: "v9", grades: [] });
    const out = await dispatchTool("get_risk", { source: "pharos" });
    assert.equal(out.pharos.status, "unavailable"); assert.equal(out.pharos.rating, null);
  }
});

function indexedRoute(url, opts) {
  if (!url.includes("ponder")) return undefined;
  const q = JSON.parse(opts.body).query;
  if (q.includes("eRC20BalanceMappings")) {
    assert.match(q, /balance_gt:"0"/); assert.match(q, /account_not:"0x0{40}"/); assert.match(q, /chainId:1/);
    return response({ data: { metric: { totalCount: 0, items: [] } } });
  }
  if (q.includes("analyticDailyLogs")) return response({ data: { metric: { items: [{ date: "2026-11-01", timestamp: "1793491200", totalSavings: "1234567890123456789012345" }] } } });
  const created = String(now() - 100);
  return response({ data: { metric: { items: [{ created, blockheight: "123", amount: "1000000000000000001" }, { created, blockheight: "124", amount: "2000000000000000002" }], pageInfo: { hasNextPage: false, endCursor: null } } } });
}

test("Dune 400s retain diagnostics while scoped indexer alternatives supply all four metrics", async () => {
  route = indexedRoute;
  const out = await dispatchTool("get_dune_stats", {});
  assert.equal(out.status, "available"); assert.equal(out.duneStatus, "unavailable");
  assert.equal(out.holders.zchf.holders, 0); assert.equal(out.holders.fps.holders, 0);
  assert.equal(out.minting[0].raw, "3000000000000000003"); assert.equal(out.minting[0].events, 2);
  assert.equal(out.savingsTvl[0].raw, "1234567890123456789012345");
  assert.equal(out.sources.zchfHolders.asOf, null); assert.equal(out.sources.zchfHolders.freshness.status, "unknown");
  assert.equal(out.queries.mintingVolume.httpStatus, 400);
  assert.match(out.sources.mintingVolume.scope, /Gross Ethereum/);
  const gov = await dispatchTool("get_governance", { type: "holders" });
  assert.equal(gov.holders.zchf.holders, 0); assert.equal(gov.holders.fcs.count, null);
  assert.ok(calls.filter((c) => c.url.includes("dune")).every((c) => c.opts.method === "GET" && !c.url.includes("execute")));
});

test("Dune published-result metadata is retained; unverified series use explicit alternatives", async () => {
  route = (url, opts) => url.includes("dune") ? response({ state: "QUERY_STATE_COMPLETED", execution_id: "published", execution_ended_at: "2026-11-01T00:00:00Z", result: { rows: [{ holders: 0 }] } }) : indexedRoute(url, opts);
  const out = await dispatchTool("get_dune_stats", {});
  assert.equal(out.sources.zchfHolders.provider, "Dune"); assert.equal(out.holders.zchf.holders, 0);
  assert.equal(out.queries.zchfHolders.executionId, "published"); assert.equal(out.sources.zchfHolders.asOf, "2026-11-01T00:00:00.000Z");
  assert.equal(out.queries.mintingVolume.code, "unverified_metric_schema");
  assert.equal(out.sources.mintingVolume.provider, "Frankencoin Ponder");
});

test("incomplete pagination and invalid indexer values never yield partial sums or fabricated zeros", async () => {
  route = (url, opts) => url.includes("ponder") ? response({ data: { metric: { totalCount: "0", items: [{ created: String(now()), amount: "1", blockheight: "1" }], pageInfo: { hasNextPage: true, endCursor: "same" } } } }) : undefined;
  const out = await dispatchTool("get_dune_stats", {});
  assert.equal(out.status, "unavailable"); assert.equal(out.holders, null); assert.equal(out.minting, null); assert.equal(out.savingsTvl, null);
});

const block = () => ({ number: "0x123", hash: `0x${"ab".repeat(32)}`, timestamp: `0x${now().toString(16)}` });
function rpcResponse(opts, value = `0x${"0".repeat(64)}`) {
  const { method, params } = JSON.parse(opts.body);
  if (method === "eth_chainId") return response({ result: "0x1" });
  if (method === "eth_getBlockByNumber") return response({ result: block() });
  assert.deepEqual(params[1], { blockHash: block().hash, requireCanonical: true });
  return response({ result: value });
}
test("CHFAU failover performs a canonical block-hash read and accepts a genuine uint256 zero", async () => {
  route = (url, opts) => url.includes("publicnode") ? response({}, 503) : rpcResponse(opts);
  const out = await ethRead(CHFAU_CONTRACT, "0x18160ddd");
  assert.equal(out.value, `0x${"0".repeat(64)}`); assert.equal(out.blockNumber, "291"); assert.equal(out.chainId, 1);
  assert.match(out.rpc, /drpc/); assert.ok(out.measuredAt); assert.ok(out.retrievedAt);
});
for (const invalid of ["0x", "0x0", "nonsense", null]) test(`invalid RPC uint256 ${invalid} is not zero supply`, async () => {
  route = (url, opts) => rpcResponse(opts, invalid);
  assert.equal(await ethRead(CHFAU_CONTRACT, "0x18160ddd"), null);
});
test("wrong-chain RPC never produces token supply", async () => {
  route = (url, opts) => JSON.parse(opts.body).method === "eth_chainId" ? response({ result: "0xa" }) : rpcResponse(opts);
  assert.equal(await ethRead(CHFAU_CONTRACT, "0x18160ddd"), null);
  assert.ok(calls.every((x) => JSON.parse(x.opts.body).method !== "eth_call"));
});

const fcsInfo = () => ({ chain: { chainId: 1, address: FCS_CONTRACT }, erc20: { decimals: 18 }, token: { totalSupply: 0, totalAssets: 0, ask: 0, bid: 0, isBinding: false }, metadata: { blockNumber: "291", blockHash: block().hash, blockTimestamp: now(), fetchedAt: new Date().toISOString(), sameBlock: true, readStatus: { bid: "available" } } });
test("FCS differentiates verified upstream block time, fetch time and retrieval; zero bid is supported", async () => {
  const data = fcsInfo(); route = () => response(data);
  const out = (await dispatchTool("get_governance", { type: "fcs" })).fcs;
  assert.equal(out.state.referencePriceZchf.bid, 0); assert.equal(out.state.status, "available");
  assert.equal(out.state.source.blockNumber, "291"); assert.equal(out.state.source.freshness.status, "fresh"); assert.ok(out.state.source.retrievedAt);
  assert.equal(out.mechanics, undefined); assert.equal(out.context.included, false);
  const full = (await dispatchTool("get_governance", { type: "fcs", includeContext: "true" })).fcs;
  assert.match(full.mechanics.qualification, /shared quorum/);
});
for (const mode of ["legacy", "stale", "future", "invalid-block", "bid-failed"]) test(`FCS ${mode} provenance is explicit`, async () => {
  const data = fcsInfo();
  if (mode === "legacy") delete data.metadata;
  if (mode === "stale") data.metadata.blockTimestamp = now() - 601;
  if (mode === "future") data.metadata.blockTimestamp = now() + 3600;
  if (mode === "invalid-block") data.metadata.blockNumber = "-1";
  if (mode === "bid-failed") data.metadata.readStatus.bid = "fallback";
  route = () => response(data);
  const out = (await dispatchTool("get_governance", { type: "fcs" })).fcs.state;
  if (["legacy", "bid-failed"].includes(mode)) assert.equal(out.referencePriceZchf.bid, null);
  if (mode === "stale") assert.equal(out.source.freshness.status, "stale");
  if (["legacy", "future", "invalid-block"].includes(mode)) { assert.equal(out.source.freshness.status, "unknown"); assert.equal(out.source.blockNumber, null); }
});
