import { test } from "node:test";
import assert from "node:assert/strict";

// Hermetic: disable cache, no secrets, inject a fake fetch (never touches network).
process.env.CACHE_ENABLED = "false";
delete process.env.COINGECKO_API_KEY;
delete process.env.DUNE_API_KEY;
delete process.env.PHAROS_API_KEY;
delete process.env.XERBERUS_API_KEY;

const { dispatchTool } = await import("../../src/tools/dispatch.js");
const { setFetchImpl } = await import("../../src/upstream/client.js");
const { ValidationError, NotFoundError } = await import("../../src/lib/errors.js");

const calls = [];
function res(obj) {
  return { ok: true, status: 200, headers: { get: () => null }, body: null, text: async () => JSON.stringify(obj) };
}

setFetchImpl(async (url, opts = {}) => {
  calls.push({ url, body: opts.body });
  if (url.includes("/positions/open")) return res({ num: 2, addresses: ["0xaaa", "0xbbb"] });
  if (url.includes("/ecosystem/collateral/list")) return res({ list: [{ chainId: 1, address: "0xC02a", name: "WETH", symbol: "WETH", decimals: 18 }] });
  if (url.includes("/prices/list")) return res([]);
  if (url.includes("ponder.frankencoin.com")) {
    return res({ data: { leadrateRateChangeds: { items: [] }, mintingHubV2PositionV2s: { items: [], pageInfo: {} } } });
  }
  return res({});
});

function lastPonder() {
  const c = [...calls].reverse().find((x) => x.url.includes("ponder"));
  return c ? c.body : "";
}
function ponderBodies() {
  return calls.filter((x) => x.url.includes("ponder")).map((x) => x.body).join("\n");
}

test("unknown tool → NotFoundError", async () => {
  await assert.rejects(() => dispatchTool("does_not_exist", {}), NotFoundError);
});

test("get_collaterals returns { collaterals, count } object envelope", async () => {
  const out = await dispatchTool("get_collaterals", {});
  assert.ok(Array.isArray(out.collaterals));
  assert.equal(out.count, out.collaterals.length);
  assert.equal(out.count, 1);
});

test("enum validation: get_analytics type=nonsense → ValidationError", async () => {
  await assert.rejects(() => dispatchTool("get_analytics", { type: "nonsense" }), ValidationError);
});

test("unknown param rejected (strict schema)", async () => {
  await assert.rejects(() => dispatchTool("get_challenges", { limit: 5, evil: 1 }), ValidationError);
});

test("numeric clamp: get_governance limit=1e9 → clamped to 100 in the upstream query", async () => {
  calls.length = 0;
  await dispatchTool("get_governance", { type: "rate_proposals", limit: 1e9 });
  assert.match(lastPonder(), /limit: 100/);
});

test("numeric clamp: get_analytics days=99999 → clamped to 365", async () => {
  calls.length = 0;
  await dispatchTool("get_analytics", { type: "time_series", days: 99999 });
  assert.match(ponderBodies(), /analyticDailyLogs\(limit: 365/);
});

test("string→boolean coercion: detail='true' takes the detail branch", async () => {
  calls.length = 0;
  await dispatchTool("get_positions", { detail: "true" });
  // detail branch queries ponder; list branch would only hit /positions/open
  assert.ok(calls.some((c) => c.url.includes("ponder")), "detail=true should query ponder");
});

test("string→boolean coercion: detail absent → lightweight list branch", async () => {
  calls.length = 0;
  const out = await dispatchTool("get_positions", {});
  assert.ok(Array.isArray(out.addresses));
  assert.ok(!calls.some((c) => c.url.includes("ponder")), "list branch must not query ponder");
});

test("address-filter injection blocked: bad collateral → ValidationError", async () => {
  await assert.rejects(
    () => dispatchTool("get_positions", { detail: true, collateral: '0x1"} evil {' }),
    ValidationError,
  );
});

test("query_ponder mutation rejected with generic message", async () => {
  await assert.rejects(
    () => dispatchTool("query_ponder", { query: "mutation { x }" }),
    (e) => e instanceof ValidationError && e.message === "only read-only queries are allowed",
  );
});

test("get_dune_stats degrades to soft note without a key (no throw)", async () => {
  const out = await dispatchTool("get_dune_stats", {});
  assert.match(out.note, /not configured/i);
  assert.equal(out.holders, null);
});

test("get_risk degrades to soft notes without keys (no throw, no network)", async () => {
  calls.length = 0;
  const out = await dispatchTool("get_risk", {});
  assert.match(out.pharos.note, /not configured/i);
  assert.equal(out.pharos.rating, null);
  assert.match(out.xerberus.note, /not configured/i);
  assert.equal(out.xerberus.ratings, null);
  // Missing keys must short-circuit BEFORE any outbound fetch.
  assert.ok(!calls.some((c) => /pharos|xerberus/.test(c.url)), "no network call when keys absent");
});

test("get_risk source=pharos returns only the pharos section", async () => {
  const out = await dispatchTool("get_risk", { source: "pharos" });
  assert.ok(out.pharos);
  assert.equal(out.xerberus, undefined);
});

test("get_risk rejects an unknown source (enum)", async () => {
  await assert.rejects(() => dispatchTool("get_risk", { source: "nope" }), ValidationError);
});
