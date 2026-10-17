import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
process.env.CACHE_ENABLED = "false";
for (const key of ["COINGECKO_API_KEY", "DUNE_API_KEY", "PHAROS_API_KEY", "XERBERUS_API_KEY"]) process.env[key] = "offline-test-only";
const { setFetchImpl } = await import("../../src/upstream/client.js");
const { dispatchTool } = await import("../../src/tools/dispatch.js");
const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/live-audit/${name}.json`, import.meta.url)));
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
let route;
beforeEach(() => {
  route = () => undefined;
  setFetchImpl(async (url, opts = {}) => route(url, opts) ?? (url.endsWith("/prices/list") ? response(fixture("source-prices")) : response({}, 401)));
});

test("R1 lock dependency artifact version agrees with resolved tarball, root bump retained", () => {
  const lock = JSON.parse(readFileSync(new URL("../../package-lock.json", import.meta.url)));
  assert.equal(lock.version, "3.1.0");
  assert.equal(lock.packages[""].version, "3.1.0");
  const dependency = lock.packages["node_modules/shebang-regex"];
  assert.equal(dependency.version, "3.0.0");
  assert.ok(dependency.resolved.endsWith(`/shebang-regex-${dependency.version}.tgz`));
});

function marketRoute(mode) {
  return (url) => {
    if (!url.includes("coingecko")) return url.includes("ethereum") ? response({ result: "0x0" }) : undefined;
    if (url.includes("/global")) return response({ data: { total_market_cap: { usd: 0 } } });
    const ids = new URL(url).searchParams.get("ids").split(",");
    if (url.includes("/coins/markets")) return response(ids.map((id) => mode === "prices" ? { id, current_price: 1 } : { id, current_price: 0, market_cap: 0, total_volume: 0, price_change_percentage_24h: 0, circulating_supply: 0 }));
    return response(Object.fromEntries(ids.map((id) => [id, mode === "prices" ? { usd: 2 } : mode === "invalid" ? { usd: "2", chf: false, usd_market_cap: "Infinity", usd_24h_change: {}, usd_24h_vol: null } : { usd: 0, chf: 0, usd_market_cap: 0, usd_24h_change: 0, usd_24h_vol: 0 }])));
  };
}

test("R2 market all IDs with prices only are partial, not full metrics", async () => {
  route = marketRoute("prices");
  const out = await dispatchTool("get_market_data", {});
  for (const key of ["coingeckoZchf", "coingeckoMacro", "coingeckoCollateral", "coingeckoStablecoins"]) assert.equal(out.sources[key].status, "partial", key);
  assert.equal(out.status, "partial");
  assert.equal(out.macro.bitcoin.marketCap.usd, null);
  assert.equal(out.macro.bitcoin.price.usd, 2);
});

test("R2 market invalid numeric metrics are unavailable and null", async () => {
  route = marketRoute("invalid");
  const out = await dispatchTool("get_market_data", {});
  assert.equal(out.sources.coingeckoMacro.status, "unavailable");
  assert.equal(out.macro.bitcoin.price.usd, null);
  assert.equal(out.macro.bitcoin.price.chf, null);
});

test("R2 complete zero market metrics retain caps volume and changes", async () => {
  route = marketRoute("zero");
  const out = await dispatchTool("get_market_data", {});
  assert.equal(out.sources.coingeckoMacro.status, "available");
  assert.equal(out.macro.bitcoin.marketCap.usd, 0);
  assert.equal(out.collateral[0].marketCap.usd, 0);
  assert.equal(out.defiTotalMarketCap.usd, 0);
});

function positionRoute(data, two = false) {
  return (url) => {
    if (url.includes("coingecko")) return response(data);
    if (url.includes("ponder.")) {
      const items = [{ position: "0x1111111111111111111111111111111111111111", collateral: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", collateralDecimals: 8 }];
      if (two) items.push({ ...items[0], collateral: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2" });
      return response({ data: { mintingHubV2PositionV2s: { items }, v2: { items } } });
    }
    if (url.endsWith("/ecosystem/collateral/list")) return response({ list: [] });
    if (url.endsWith("/challenges/list")) return response({ list: [{ position: "0x1111111111111111111111111111111111111111", start: 100, duration: 10 }] });
  };
}

test("R2 empty CoinGecko enrichment is unavailable for positions and challenges", async () => {
  route = positionRoute({ "wrapped-bitcoin": {} });
  for (const [name, args] of [["get_positions", { detail: true }], ["get_challenges", {}]]) {
    const out = await dispatchTool(name, args);
    assert.equal(out.sources.coingecko.status, "unavailable");
  }
});

test("R2 enrichment checks every requested ID and preserves zero cap", async () => {
  route = positionRoute({ "wrapped-bitcoin": { usd_market_cap: 0, usd_24h_change: 0 } }, true);
  const out = await dispatchTool("get_positions", { detail: true });
  assert.equal(out.sources.coingecko.status, "partial");
  assert.equal(out.positions[0].collateral.marketCapUsd, 0);
  assert.equal(out.positions[0].collateral.change24hPercent, 0);
});

function duneRoute(rows) {
  return (url) => url.includes("/execute") ? response({ execution_id: "test" }) : url.includes("/execution/test/results") ? response({ state: "QUERY_STATE_COMPLETED", result: { rows } }) : undefined;
}

test("R2 Dune completed null rows contain no metrics", async () => {
  route = duneRoute([null]);
  const out = await dispatchTool("get_dune_stats", {});
  assert.equal(out.status, "unavailable");
  assert.ok(Object.values(out.queries).every((q) => q.status === "unavailable"));
  assert.equal(out.minting, null);
  assert.equal(out.savingsTvl, null);
});

test("R2 Dune rejects unrelated columns and preserves usable holder rows with partial coverage", async () => {
  route = duneRoute([{ unrelated: 42 }, { holders: 0 }, null]);
  const out = await dispatchTool("get_dune_stats", {});
  assert.equal(out.queries.zchfHolders.status, "partial");
  assert.deepEqual(out.holders.zchf, { holders: 0 });
  assert.notEqual(out.queries.mintingVolume.status, "available");
});

test("R2 Pharos overall score without dimensions is partial", async () => {
  route = (url) => url.includes("pharos") ? response({ cards: [{ id: "zchf-frankencoin", overallScore: 75 }] }) : undefined;
  const out = await dispatchTool("get_risk", { source: "pharos" });
  assert.equal(out.pharos.status, "partial");
  assert.equal(out.pharos.overallScore, 75);
  assert.equal(out.status, "partial");
});

const githubBody = (body) => response({ content: Buffer.from(JSON.stringify(body)).toString("base64") });

test("R3 news empty objects are not confirmed empty datasets", async () => {
  route = (url) => url.includes("api.github.com") ? githubBody({}) : undefined;
  const out = await dispatchTool("get_news", {});
  assert.equal(out.status, "unavailable");
  assert.equal(out.media, null);
  assert.equal(out.useCases, null);
  assert.equal(out.ecosystem, null);
  assert.ok(Object.values(out.sources).every((s) => s.status === "unavailable"));
});

test("R3 malformed use cases do not discard captured healthy media", async () => {
  const media = fixture("media");
  route = (url) => url.includes("api.github.com") ? githubBody(new URL(url).pathname.endsWith("/media.json") ? media : new URL(url).pathname.endsWith("/use-cases.json") ? { cases: { invalid: true } } : { tabs: [] }) : undefined;
  const out = await dispatchTool("get_news", {});
  assert.equal(out.status, "partial");
  assert.equal(out.media.articles.length, media.articles.length);
  assert.equal(out.sources.media.status, "available");
  assert.equal(out.sources.useCases.status, "unavailable");
  assert.equal(out.useCases, null);
  assert.deepEqual(out.ecosystem, []);
});

test("R3 explicitly empty arrays are valid empty datasets", async () => {
  route = (url) => url.includes("api.github.com") ? githubBody(new URL(url).pathname.endsWith("/media.json") ? { articles: [], videos: [] } : new URL(url).pathname.endsWith("/use-cases.json") ? { cases: [] } : { tabs: [] }) : undefined;
  const out = await dispatchTool("get_news", {});
  assert.equal(out.status, "available");
  assert.deepEqual(out.media, { articles: [], videos: [] });
});
