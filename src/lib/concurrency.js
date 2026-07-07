/**
 * Bounded parallelism primitives. Pure (no I/O).
 */

/** A counting semaphore: acquire() resolves when a slot is free; release() frees one. */
export class Semaphore {
  constructor(max) {
    this.max = Math.max(1, max | 0);
    this.active = 0;
    this._queue = [];
  }

  async acquire() {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise((resolve) => this._queue.push(resolve));
    this.active++;
  }

  release() {
    this.active--;
    const next = this._queue.shift();
    if (next) next();
  }

  /** Run fn() while holding a slot; always releases. */
  async run(fn) {
    await this.acquire();
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
