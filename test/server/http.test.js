import { test, before, after } from "node:test";
import assert from "node:assert/strict";

// Configure before importing anything that reads config.
process.env.CACHE_ENABLED = "false";
process.env.RATE_LIMIT_MAX = "30";
delete process.env.COINGECKO_API_KEY;
delete process.env.DUNE_API_KEY;

const { setFetchImpl } = await import("../../src/upstream/client.js");
// Offline stub so any accidental dispatch never hits the network.
setFetchImpl(async (url) => ({
  ok: true, status: 200, headers: { get: () => null }, body: null,
  text: async () => JSON.stringify(
    url.includes("collateral/list") ? { list: [] } : {},
  ),
}));

const { createHttpServer } = await import("../../src/server/http.js");

let server, base;
before(async () => {
  server = createHttpServer();
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

// Each call uses a unique right-most XFF entry → its own rate-limit bucket, so
// functional tests never interfere with each other or the spoof test.
let ipc = 0;
function freshXff() {
  ipc++;
  return `1.2.3.4, 10.${(ipc >> 16) & 255}.${(ipc >> 8) & 255}.${ipc & 255}`;
}
function call(path, { method = "GET", headers = {}, body, xff } = {}) {
  return fetch(`${base}${path}`, {
    method,
    headers: { "x-forwarded-for": xff ?? freshXff(), ...headers },
    body,
  });
}

test("/health is lean, says 15 tools, no webhook mention", async () => {
  const r = await call("/health");
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.status, "ok");
  assert.equal(j.toolCount, 15);
  assert.doesNotMatch(JSON.stringify(j), /webhook|17 tools/i);
});

test("/llms.txt → 200 text/plain, cacheable, lists all 15 tools", async () => {
  const r = await call("/llms.txt");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/plain/);
  assert.match(r.headers.get("cache-control"), /max-age=3600/);
  const txt = await r.text();
  assert.match(txt, /^# Frankencoin MCP Server/);
  assert.ok(txt.includes("**query_ponder**"));
  assert.match(txt, /## Tools \(15\)/);
});

test("/llms.txt rejects non-GET → 405 with Allow", async () => {
  const r = await call("/llms.txt", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(r.status, 405);
  assert.match(r.headers.get("allow"), /GET/);
});

test("security + CORS headers present, no framework banner", async () => {
  const r = await call("/health");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
  assert.equal(r.headers.get("access-control-allow-credentials"), null);
  assert.equal(r.headers.get("x-powered-by"), null);
});

test("OPTIONS preflight → 204 with CORS, no credentials", async () => {
  const r = await call("/api/get_savings", { method: "OPTIONS" });
  assert.equal(r.status, 204);
  assert.match(r.headers.get("access-control-allow-methods"), /GET, POST, DELETE, OPTIONS/);
  assert.equal(r.headers.get("access-control-allow-credentials"), null);
});

test("unknown path → 404 with endpoints (no /webhooks)", async () => {
  const r = await call("/nope");
  assert.equal(r.status, 404);
  const j = await r.json();
  assert.equal(j.error, "Not found");
  assert.doesNotMatch(JSON.stringify(j), /webhook/i);
});

test("unknown tool → 404, name only in structured field", async () => {
  const r = await call("/api/does_not_exist");
  assert.equal(r.status, 404);
  const j = await r.json();
  assert.equal(j.ok, false);
  assert.equal(j.error, "Unknown tool");
  assert.ok(Array.isArray(j.available));
});

test("webhook tools/routes are gone → 404", async () => {
  assert.equal((await call("/api/subscribe_events", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 404);
  assert.equal((await call("/webhooks/status")).status, 404);
});

test("body too large → 413", async () => {
  const big = JSON.stringify({ query: "x".repeat(200 * 1024) });
  const r = await call("/api/query_ponder", { method: "POST", headers: { "content-type": "application/json" }, body: big });
  assert.equal(r.status, 413);
});

test("malformed JSON → 400 (not 500)", async () => {
  const r = await call("/api/query_ponder", { method: "POST", headers: { "content-type": "application/json" }, body: "{ bad json" });
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.equal(j.error, "Invalid JSON body");
});

test("prototype-pollution body → 400, global prototype untouched", async () => {
  const r = await call("/api/get_challenges", { method: "POST", headers: { "content-type": "application/json" }, body: '{"__proto__":{"polluted":true}}' });
  assert.equal(r.status, 400);
  assert.equal(({}).polluted, undefined);
});

test("wrong content-type on POST body → 415", async () => {
  const r = await call("/api/query_ponder", { method: "POST", headers: { "content-type": "text/plain" }, body: '{"query":"{x}"}' });
  assert.equal(r.status, 415);
});

test("method not allowed on /api tool → 405 with Allow", async () => {
  const r = await call("/api/get_savings", { method: "DELETE" });
  assert.equal(r.status, 405);
  assert.match(r.headers.get("allow"), /GET, POST, PUT/);
});

test("query_ponder mutation → 400 generic, no internals leaked", async () => {
  const r = await call("/api/query_ponder", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "mutation { setRate(bps:0){ ok } }" }) });
  assert.equal(r.status, 400);
  const text = await r.text();
  const j = JSON.parse(text);
  assert.equal(j.error, "only read-only queries are allowed");
  assert.doesNotMatch(text, /ponder\.frankencoin|graphql|stack|at Object|\.js:/i);
});

test("forged left-most X-Forwarded-For does NOT defeat rate limiting", async () => {
  // Fixed right-most (the hop a trusted proxy would append) → shared bucket.
  let got429 = 0;
  for (let i = 0; i < 40; i++) {
    const r = await call("/health", { xff: `9.9.9.${i}, 203.0.113.7` });
    if (r.status === 429) got429++;
  }
  assert.ok(got429 > 0, "spoofing the left-most XFF entry must not mint fresh buckets");
});
