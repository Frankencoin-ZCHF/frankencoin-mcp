import { test } from "node:test";
import assert from "node:assert/strict";

// Configure the cache before importing it (config reads env once at import).
process.env.CACHE_ENABLED = "true";
process.env.CACHE_MAX_ENTRIES = "3";
process.env.CACHE_MAX_BYTES = "64";
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

test("in-flight cache entries cannot be displaced by unrelated misses", async () => {
  clear();
  let release;
  const pending = new Promise(resolve => { release=resolve; });
  const first = ["a","b","c"].map(key=>getOrLoad(key,1000,()=>pending));
  await assert.rejects(getOrLoad("d",1000,async()=>4),{code:"busy"});
  const again=getOrLoad("a",1000,()=>assert.fail("duplicate"));
  release(1);
  assert.deepEqual(await Promise.all([...first,again]),[1,1,1,1]);
  assert.equal(await getOrLoad("d",1000,async()=>4),4);
});

test("all callers receive eligible stale data while the single refresh is pending", async () => {
  clear();
  const opts={swrMs:10000};
  await getOrLoad("stale",0,async()=>1,opts);
  let release;
  const pending=new Promise(r=>{release=r});
  const a=getOrLoad("stale",100,()=>pending,opts);
  const b=getOrLoad("stale",100,()=>assert.fail("duplicate refresh"),opts);
  assert.deepEqual(await Promise.all([a,b]),[1,1]);
  release(2);
  await new Promise(r=>setImmediate(r));
  assert.equal(await getOrLoad("stale",100,()=>assert.fail("cache miss"),opts),2);
});

test("oversized entries are returned but do not consume the cache budget", async()=>{
  clear();
  let calls=0;
  const load=async()=>{calls++;return "x".repeat(100);};
  for(let i=0;i<2;i++)assert.equal((await getOrLoad("large",1000,load)).length,100);
  assert.equal(calls,2);
  assert.equal(size(),0);
});
