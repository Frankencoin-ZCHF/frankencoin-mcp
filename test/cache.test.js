import { test } from "node:test";
import assert from "node:assert/strict";

// Configure the cache before importing it (config reads env once at import).
process.env.CACHE_ENABLED = "true";
process.env.CACHE_MAX_ENTRIES = "3";
const { getOrLoad, clear, size, invalidate } = await import("../src/cache.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("fresh hit returns cached value without reloading", async () => {
  clear();
  let calls = 0;
  const load = async () => { calls++; return "v"; };
  assert.equal(await getOrLoad("k1", 1000, load), "v");
  assert.equal(await getOrLoad("k1", 1000, load), "v");
  assert.equal(calls, 1);
});

test("TTL expiry triggers a reload", async () => {
  clear();
  let calls = 0;
  const load = async () => { calls++; return calls; };
  assert.equal(await getOrLoad("k2", 20, load), 1);
  await sleep(35);
  assert.equal(await getOrLoad("k2", 20, load), 2);
  assert.equal(calls, 2);
});

test("single-flight coalesces concurrent loads into one", async () => {
  clear();
  let calls = 0;
  const load = async () => { calls++; await sleep(20); return "x"; };
  const results = await Promise.all([
    getOrLoad("k3", 1000, load),
    getOrLoad("k3", 1000, load),
    getOrLoad("k3", 1000, load),
    getOrLoad("k3", 1000, load),
  ]);
  assert.deepEqual(results, ["x", "x", "x", "x"]);
  assert.equal(calls, 1);
});

test("errors are not cached", async () => {
  clear();
  let calls = 0;
  const load = async () => { calls++; if (calls === 1) throw new Error("fail"); return "ok"; };
  await assert.rejects(() => getOrLoad("k4", 1000, load));
  assert.equal(await getOrLoad("k4", 1000, load), "ok");
  assert.equal(calls, 2);
});

test("LRU eviction bounds the map at the configured cap", async () => {
  clear();
  for (let i = 0; i < 6; i++) await getOrLoad(`lru${i}`, 10000, async () => i);
  assert.ok(size() <= 3, `cache size ${size()} should be ≤ 3`);
});

test("invalidate removes an entry", async () => {
  clear();
  let calls = 0;
  const load = async () => { calls++; return "v"; };
  await getOrLoad("k5", 1000, load);
  invalidate("k5");
  await getOrLoad("k5", 1000, load);
  assert.equal(calls, 2);
});
