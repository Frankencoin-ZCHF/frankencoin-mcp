import { test } from "node:test";
import assert from "node:assert/strict";
import { Semaphore, mapLimit } from "../../src/lib/concurrency.js";

test("Semaphore caps concurrency", async () => {
  const sem = new Semaphore(2);
  let active = 0;
  let peak = 0;
  const task = () => sem.run(async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 10));
    active--;
  });
  await Promise.all(Array.from({ length: 8 }, task));
  assert.ok(peak <= 2, `peak concurrency ${peak} should be ≤ 2`);
});

test("mapLimit preserves order and bounds concurrency", async () => {
  let active = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return n * 10;
  });
  assert.deepEqual(out, [10, 20, 30, 40, 50]);
  assert.ok(peak <= 2);
});
