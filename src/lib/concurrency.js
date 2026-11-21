/**
 * Bounded parallelism primitives. Pure (no I/O).
 */

/** A counting semaphore: acquire() resolves when a slot is free; release() frees one. */
import { BusyError } from "./errors.js";

export class Semaphore {
  constructor(max, { maxQueue = 128, waitMs = 2000 } = {}) {
    this.maxQueue = maxQueue;
    this.waitMs = waitMs;
    this.max = Math.max(1, max | 0);
    this.active = 0;
    this._queue = [];
  }

  async acquire(waitMs = this.waitMs) {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    if (this._queue.length >= this.maxQueue) throw new BusyError();
    await new Promise((resolve, reject) => {
      const grant = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        this._queue.splice(this._queue.indexOf(grant), 1);
        reject(new BusyError());
      }, Math.min(this.waitMs, waitMs));
      this._queue.push(grant);
    });
  }

  release() {
    const next = this._queue.shift();
    if (next) next(); // Transfer the reserved slot directly to the oldest waiter.
    else this.active--;
  }

  /** Run fn() while holding a slot; always releases. */
  async run(fn, waitMs) {
    await this.acquire(waitMs);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/**
 * Map `items` through async `fn` with at most `limit` concurrent calls.
 * Preserves input order in the returned results array.
 */
export async function mapLimit(items, limit, fn) {
  const list = [...items];
  const results = new Array(list.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (cursor < list.length) {
      const i = cursor++;
      results[i] = await fn(list[i], i);
    }
  });

  await Promise.all(workers);
  return results;
}
