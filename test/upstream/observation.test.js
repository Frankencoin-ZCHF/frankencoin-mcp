import { test } from "node:test";
import assert from "node:assert/strict";
process.env.CACHE_ENABLED = "true";
const { clear } = await import("../../src/cache.js");
const { setFetchImpl } = await import("../../src/upstream/client.js");
const { apiFetch, apiObservation } = await import("../../src/upstream/frankencoin.js");
const { ponderQuery, ponderObservation } = await import("../../src/upstream/ponder.js");

test("cache hits preserve actual HTTP retrieval time without changing existing API shapes", async () => {
  clear(); let calls = 0;
  setFetchImpl(async (url) => { calls++; return Response.json(url.includes("ponder") ? { data: { metric: 0 } } : { token: 0 }); });
  const api = await apiObservation("/fcs/info");
  assert.deepEqual(await apiFetch("/fcs/info"), { token: 0 });
  assert.strictEqual(await apiObservation("/fcs/info"), api);
  assert.ok(api.retrievedAt);
  const query = "{ metric }", ponder = await ponderObservation(query);
  assert.deepEqual(await ponderQuery(query), { metric: 0 });
  assert.strictEqual(await ponderObservation(query), ponder);
  assert.ok(ponder.retrievedAt); assert.equal(calls, 2);
});

test("provider failures are coalesced and cooled down while preserving typed diagnostics", async () => {
  const { withProviderCooldown } = await import("../../src/upstream/cooldown.js");
  const { UpstreamError } = await import("../../src/lib/errors.js");
  clear(); let calls = 0;
  const error = new UpstreamError("dune", 400);
  const loader = async () => { calls++; throw error; };
  const results = await Promise.allSettled([withProviderCooldown("test", loader), withProviderCooldown("test", loader)]);
  assert.ok(results.every((r) => r.status === "rejected" && r.reason === error));
  await assert.rejects(() => withProviderCooldown("test", loader), (e) => e === error);
  assert.equal(calls, 1);
});
