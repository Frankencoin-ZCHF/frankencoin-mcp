import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
process.env.CACHE_ENABLED = "false";
for (const key of ["COINGECKO_API_KEY", "DUNE_API_KEY", "PHAROS_API_KEY", "XERBERUS_API_KEY"]) process.env[key] = "offline-test-only";
const { setFetchImpl } = await import("../../src/upstream/client.js");
const { dispatchTool } = await import("../../src/tools/dispatch.js");
const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/live-audit/${name}.json`, import.meta.url)));
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
let calls, route;
beforeEach(() => {
  calls = [];
  route = () => undefined;
  setFetchImpl(async (url, opts = {}) => {
    calls.push({ url, opts });
    const custom = route(url, opts);
    if (custom !== undefined) return custom;
    if (url.endsWith("/savings/leadrate/info")) return response(fixture("source-savings-leadrate"));
    if (url.endsWith("/prices/list")) return response(fixture("source-prices"));
    if (url.includes("ponder.frankencoin.com")) return response({ data: {} });
    if (url.includes("api.frankencoin.com")) return response({});
    return response({}, 401);
  });
});

test("I01 historical proposals are not pending in savings or snapshot", async () => {
  const savings = await dispatchTool("get_savings", {});
  assert.equal(savings.summary.pendingRateChanges, 0);
  assert.deepEqual(savings.rates.proposed, []);
  const snapshot = await dispatchTool("get_protocol_snapshot", {});
  assert.equal(snapshot.savings.pendingRateChanges, 0);
});

test("I05 rateBps uses conventional BPS and ratePpm preserves source units", async () => {
  const s = await dispatchTool("get_savings", {});
  const lead = s.rates.approved.find((r) => r.ratePercent === 3.5);
  assert.equal(lead.rateBps, 350);
  assert.equal(lead.ratePpm, 35000);
  const data = fixture("source-savings-leadrate"); data.open = data.proposed;
  route = (url) => url.endsWith("/savings/leadrate/info") ? response(data) : undefined;
  const pending = (await dispatchTool("get_savings", {})).rates.proposed;
  assert.equal(pending[0].proposedRateBps, 100);
  assert.equal(pending[0].proposedRatePpm, 10000);
  assert.equal((await dispatchTool("get_protocol_snapshot", {})).savings.leadRatePercent, 3.5);
});

test("I06 pending rates use the live open set, never approved history", async () => {
  route = (url) => url.includes("ponder.") ? response({ data: { leadrateRateChangeds: { items: [{ chainId: 1, approvedRate: 35000, created: 1776267521 }] } } }) : undefined;
  const out = await dispatchTool("get_governance", { type: "rate_proposals", status: "pending", limit: 3 });
  assert.deepEqual(out.rateProposals, []);
  const data = fixture("source-savings-leadrate"); data.open = data.proposed;
  route = (url) => url.endsWith("/savings/leadrate/info") ? response(data) : undefined;
  const pending = await dispatchTool("get_governance", { type: "rate_proposals", status: "pending", limit: 1 });
  assert.equal(pending.rateProposals.length, 1);
  assert.equal(pending.rateProposals[0].status, "pending");
});

test("I07 minter status predicates precede limit and retain pagination", async () => {
  route = (url, opts) => {
    if (!url.includes("ponder.")) return undefined;
    const query = JSON.parse(opts.body).query;
    const filtered = query.includes('denyDate_gt: "0"');
    return response({ data: { frankencoinMinters: { items: filtered ? [{ minter: "0x3e44a18499a298877f989117403c16084e4ff6c1", denyDate: 10 }] : [], pageInfo: { hasNextPage: true, endCursor: "next" } } } });
  };
  const out = await dispatchTool("get_governance", { type: "minters", status: "denied", limit: 1 });
  assert.equal(out.minters.length, 1);
  assert.equal(out.minters[0].isActive, false);
  assert.equal(out.mintersPageInfo.hasNextPage, true);
  await dispatchTool("get_governance", { type: "minters", status: "active", limit: 1 });
  assert.match(JSON.parse(calls.at(-1).opts.body).query, /denyDate: "0"/);
});

test("I09 time series selects only actual indexer fields and marks absent metrics null", async () => {
  const allowed = new Set(fixture("analytics-schema").data.__type.fields.map((f) => f.name));
  const { parse, visit } = await import("graphql");
  route = (url, opts) => {
    if (!url.includes("ponder.")) return undefined;
    const query = JSON.parse(opts.body).query;
    if (!query.includes("analyticDailyLogs")) return response({ data: {} });
    let fields;
    visit(parse(query), { Field(n) { if (n.name.value === "items") fields = n.selectionSet.selections.map((f) => f.name.value); } });
    if (fields.some((f) => !allowed.has(f))) return response({ errors: [{ message: "Removed analytics field" }] });
    return response({ data: { analyticDailyLogs: { items: [{ date: "2026-10-16", fpsTotalSupply: "2000000000000000000", fpsPrice: "3000000000000000000", totalEquity: "6000000000000000000" }] } } });
  };
  const out = await dispatchTool("get_analytics", { days: 7 });
  assert.equal(out.daily[0].supply.total, null);
  assert.equal(out.daily[0].fps.marketCapChf, 6);
  assert.equal(out.daily[0].rates.savingsRatePercent, null);
  assert.ok(out.unavailableFields.includes("totalSupply"));
});

test("I14 rate_history applies the requested rolling window before the limit", async () => {
  route = (url, opts) => {
    if (!url.includes("ponder.")) return undefined;
    const q = JSON.parse(opts.body).query;
    assert.match(q, /limit: 3/);
    const cutoff = Number(q.match(/created_gte: "(\d+)"/)?.[1]);
    assert.ok(Math.abs(cutoff - (Math.floor(Date.now() / 1000) - 7 * 86400)) <= 2);
    return response({ data: { leadrateRateChangeds: { items: [] } } });
  };
  const out = await dispatchTool("get_analytics", { type: "rate_history", days: 7, limit: 3 });
  assert.deepEqual(out.rateHistory.all, []);
  assert.equal(out.rateHistory.days, 7);
});

test("I08 Dune query failures are explicit in stats and governance holders", async () => {
  const out = await dispatchTool("get_dune_stats", {});
  assert.equal(out.status, "unavailable");
  assert.equal(out.queries.zchfHolders.status, "unavailable");
  assert.equal(out.queries.zchfHolders.httpStatus, 401);
  assert.match(out.note, /unavailable/i);
  const gov = await dispatchTool("get_governance", { type: "holders" });
  assert.equal(gov.holders.status, "unavailable");
  assert.equal(gov.holders.fcs.count, null);
});

test("I11 failed Pharos preserves working Xerberus and discloses unknown as-of", async () => {
  route = (url) => url.includes("xerberus") ? response({ data: [
    { type: "protocol", id: "frankencoin", score: 77 },
    { type: "organisation", id: "frankencoin-dao", score: 75 },
    { type: "pool", id: "frankencoin-savings-eth", score: 81 },
  ] }) : undefined;
  const out = await dispatchTool("get_risk", {});
  assert.equal(out.status, "partial");
  assert.equal(out.pharos.status, "unavailable");
  assert.equal(out.pharos.httpStatus, 401);
  assert.deepEqual(out.xerberus.ratings.map((r) => r.score), [77, 75, 81]);
  assert.equal(out.xerberus.asOf, null);
  assert.match(out.xerberus.freshnessNote, /not supplied/i);
});

test("I02 market retains public USD fallback and exposes failed optional sources", async () => {
  const out = await dispatchTool("get_market_data", {});
  assert.equal(out.zchf.price.usd, fixture("source-prices").find((p) => p.symbol === "ZCHF").price.usd);
  assert.equal(out.sources.coingeckoZchf.status, "unavailable");
  assert.equal(out.sources.coingeckoZchf.httpStatus, 401);
  assert.equal(out.sources.chfauSupply.status, "unavailable");
  assert.equal(out.status, "partial");
  assert.match(out.note, /unavailable/i);
});

test("I03 live price rows label stale feeds and suppress sentinel quotes", async () => {
  const out = await dispatchTool("get_market_data", {});
  const zero = out.prices.find((p) => p.address.toLowerCase() === "0x913b061e19549def21541d66ff121aba8e7f9221");
  assert.equal(zero.price.usd, null);
  assert.equal(zero.freshness.status, "unavailable");
  assert.equal(out.prices.find((p) => p.symbol === "CHFAU").price.chf, null);
  assert.equal(out.prices.find((p) => p.symbol === "UNI").freshness.status, "stale");
  assert.ok(out.prices.find((p) => p.symbol === "UNI").freshness.ageSeconds > 86400);
});

test("I04 Association is steward, not the ZCHF issuer", async () => {
  const zchf = (await dispatchTool("get_market_data", {})).chfStablecoins.find((t) => t.symbol === "ZCHF");
  assert.equal(zchf.issuer, null);
  assert.match(zchf.issuerNote, /no identifiable issuer/i);
  assert.equal(zchf.steward, "Frankencoin Association");
});

// Synthetic closed WBTC position exercises upstream BigInt units and provider failure.
function positionRoute(url) {
  const p = { position: "0x1111111111111111111111111111111111111111", collateral: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", collateralDecimals: 8, collateralBalance: "100000000", minted: "1000000000000000000", availableForMinting: "5000000000000000000", closed: true };
  if (url.includes("ponder.")) return response({ data: { mintingHubV2PositionV2s: { items: [p], pageInfo: { hasNextPage: true } }, v2: { items: [p] } } });
  if (url.endsWith("/challenges/list")) return response({ num: 1, list: [{ position: p.position, start: 100, duration: 10, status: "Success" }] });
}

test("I02 positions and challenges expose CoinGecko enrichment failure", async () => {
  route = positionRoute;
  for (const [name, args] of [["get_positions", { detail: true }], ["get_challenges", {}]]) {
    const out = await dispatchTool(name, args);
    assert.equal(out.sources.coingecko.status, "unavailable");
    assert.equal(out.sources.coingecko.httpStatus, 401);
  }
});

test("I13 detail totals and nominal minting allowance are not executable capacity", async () => {
  route = positionRoute;
  const out = await dispatchTool("get_positions", { detail: true, active_only: false });
  assert.equal(out.returned, 1);
  assert.equal(out.totalScope, "returned_page");
  assert.equal(out.totalMatching, null);
  assert.equal(out.positions[0].availableForMintingNominal, 5);
  assert.equal(out.positions[0].executableMintingCapacity, null);
  assert.match(out.capacityNote, /not executable/i);
});

test("I10 GitHub Contents failure falls back to the same public main-branch file", async () => {
  const doc = readFileSync(new URL("../fixtures/live-audit/overview.md", import.meta.url), "utf8");
  route = (url) => url === "https://raw.githubusercontent.com/Frankencoin-ZCHF/gitbook/main/README.md" ? new Response(doc) : undefined;
  const out = await dispatchTool("get_knowledge", { topic: "overview" });
  assert.equal(out.content, doc);
});

test("I10 source failures preserve news sections and disclose unavailable docs", async () => {
  const media = fixture("media");
  route = (url) => url.includes("api.github.com") && url.endsWith("/media.json") ? response({ content: Buffer.from(JSON.stringify(media)).toString("base64") }) : undefined;
  const out = await dispatchTool("get_news", {});
  assert.equal(out.status, "partial");
  assert.equal(out.media.articles.length, media.articles.length);
  assert.equal(out.sources.useCases.status, "unavailable");
  assert.equal(out.useCases, null);
  const knowledge = await dispatchTool("get_knowledge", { topic: "overview" });
  assert.equal(knowledge.status, "unavailable");
  assert.equal(knowledge.content, null);
  assert.match(knowledge.note, /unavailable/i);
});

test("I12 actual MCP and REST both reject unknown keys, including empty schemas", async () => {
  const { createHttpServer } = await import("../../src/server/http.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const server = createHttpServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = new Client({ name: "audit-regression", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));
    const result = await client.callTool({ name: "get_savings", arguments: { unsupported: true } });
    assert.equal(result.isError, true);
    const manifest = await client.listTools();
    assert.ok(manifest.tools.every((t) => t.inputSchema.additionalProperties === false));
    assert.equal((await fetch(base + "/api/get_savings?unsupported=true")).status, 400);
  } finally {
    await client.close(); await new Promise((resolve) => server.close(resolve));
  }
});

test("I15 merch amount currency comes from Shopify metadata, not assumed USD", async () => {
  route = (url) => url.includes("/products.json") ? response({ products: [{ title: "Test", handle: "test", images: [], options: [], variants: [{ price: "29.95", available: true }] }] }) : url.endsWith("/meta.json") ? response({ currency: "CHF" }) : undefined;
  const out = await dispatchTool("get_merch", {});
  assert.equal(out.store.currency, "CHF");
  assert.equal(out.products[0].variants[0].currency, "CHF");
  assert.equal(out.products[0].currency, "CHF");
  assert.doesNotMatch(out.note, /prices in USD/);
});

test("I02 partial successful providers do not claim complete market coverage", async () => {
  route = (url) => url.includes("pro-api.coingecko.com") ? response(url.includes("/coins/markets") ? [] : { bitcoin: { usd: 10 } }) : undefined;
  const out = await dispatchTool("get_market_data", {});
  assert.equal(out.sources.coingeckoMacro.status, "partial");
  assert.ok(out.sources.coingeckoMacro.missingFields.includes("ethereum"));
});

test("I11 empty provider scores are unavailable, partial scores remain partial", async () => {
  route = (url) => url.includes("pharos") ? response({ cards: [{ id: "zchf-frankencoin" }] }) : url.includes("xerberus") ? response({ data: [{ type: "protocol", id: "frankencoin", score: 77 }] }) : undefined;
  const out = await dispatchTool("get_risk", {});
  assert.equal(out.pharos.status, "unavailable");
  assert.equal(out.xerberus.status, "partial");
  assert.equal(out.status, "partial");
});

test("I01 missing open state is unknown, not a confirmed empty pending set", async () => {
  const data = fixture("source-savings-leadrate"); delete data.open;
  route = (url) => url.endsWith("/savings/leadrate/info") ? response(data) : undefined;
  assert.equal((await dispatchTool("get_savings", {})).summary.pendingRateChanges, null);
  assert.equal((await dispatchTool("get_protocol_snapshot", {})).savings.pendingRateChanges, null);
});

test("I08 Dune preserves successful zero-valued results beside failing queries", async () => {
  route = (url) => url.includes("/query/6712642/execute") ? response({ execution_id: "test-execution" }) : url.includes("/execution/test-execution/results") ? response({ state: "QUERY_STATE_COMPLETED", result: { rows: [{ holders: 0 }] } }) : undefined;
  const out = await dispatchTool("get_dune_stats", {});
  assert.equal(out.status, "partial"); assert.equal(out.holders.zchf.holders, 0);
  assert.equal(out.queries.zchfHolders.status, "available");
  assert.equal(out.queries.fpsHolders.status, "unavailable");
});

test("I15 missing currency stays null with explicit source failure", async () => {
  route = (url) => url.includes("/products.json") ? response({ products: [] }) : undefined;
  const out = await dispatchTool("get_merch", {});
  assert.equal(out.store.currency, null);
  assert.equal(out.store.currencyStatus.status, "unavailable");
});

test("I06 missing authoritative open set does not masquerade as no pending proposals", async () => {
  route = (url) => url.endsWith("/savings/leadrate/info") ? response({ proposed: {} }) : undefined;
  const out = await dispatchTool("get_governance", { type: "rate_proposals", status: "pending" });
  assert.equal(out.rateProposalsStatus, "unavailable");
});

test("I10 frontend metadata failure preserves independently sourced listings", async () => {
  route = (url) => url.includes("api.github.com") && url.endsWith("/shared/frontends.json") ? response({ content: Buffer.from(JSON.stringify({ frontends: [{ name: "Example", url: "https://example.org" }] })).toString("base64") }) : undefined;
  const out = await dispatchTool("get_knowledge", { topic: "frontends" });
  assert.equal(out.status, "partial");
  assert.equal(out.frontends[0].name, "Example");
  assert.equal(out.warning, null);
  assert.equal(out.sources.metadata.status, "unavailable");
});

test("I07 active minters include the indexer null denyDate sentinel before limiting", async () => {
  route = (url, opts) => {
    if (!url.includes("ponder.")) return undefined;
    const q = JSON.parse(opts.body).query;
    return response({ data: { frankencoinMinters: { items: q.includes("denyDate: null") ? [{ minter: "active", denyDate: null }, { minter: "zero", denyDate: "0" }] : [] } } });
  };
  const out = await dispatchTool("get_governance", { type: "minters", status: "active", limit: 3 });
  assert.equal(out.minters.length, 2);
  assert.ok(out.minters.every((m) => m.isActive && m.deniedAt === null));
});
