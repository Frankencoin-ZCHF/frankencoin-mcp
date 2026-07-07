/**
 * The one fetch wrapper. The ONLY layer that performs network I/O.
 *
 * Provides: per-source timeout, bounded retry for idempotent requests, a global
 * outbound-concurrency semaphore, a response-size cap, keep-alive connection reuse,
 * and typed errors that never leak upstream detail (ARCHITECTURE §C, SECURITY §7).
 */

import { config } from "../config.js";
import { Semaphore } from "../lib/concurrency.js";
import { TimeoutError, UpstreamError } from "../lib/errors.js";

// Shared undici keep-alive agent when available (built into Node); best-effort.
try {
  const undici = await import("undici");
  if (undici?.setGlobalDispatcher && undici?.Agent) {
    undici.setGlobalDispatcher(new undici.Agent({
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 60_000,
      connections: 64,
    }));
  }
} catch {
  // Global fetch already keep-alives by default; tuning is an optimization only.
}

// Injectable fetch (defaults to global). Tests call setFetchImpl() to go offline.
let _fetch = (...args) => globalThis.fetch(...args);
export function setFetchImpl(fn) { _fetch = fn || ((...a) => globalThis.fetch(...a)); }

const outbound = new Semaphore(config.upstreamMaxConcurrency);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BACKOFF = [250, 1000];

/** Read a response body with a hard byte cap; aborts if exceeded. */
async function readBounded(res, source) {
  const cap = config.upstreamMaxBytes;
  const lenHeader = Number(res.headers.get("content-length"));
  if (Number.isFinite(lenHeader) && lenHeader > cap) {
    throw new UpstreamError(source, res.status);
  }
  if (!res.body) return await res.text();

  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new UpstreamError(source, res.status);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * fetchJson — perform a request and parse JSON, with the full hardening stack.
 * @param {string} url absolute URL (host is always a hard-coded constant upstream)
 * @param {object} opts
 * @param {string} opts.source short source tag for typed errors (never leaked verbatim)
 * @param {number} opts.timeout ms
 * @param {number} [opts.retries=2]
 * @param {string} [opts.method="GET"]
 * @param {any} [opts.body] already-stringified body or object (object → JSON)
 * @param {object} [opts.headers]
 * @param {boolean} [opts.idempotent] retry only when true (GET is idempotent by default)
 * @param {string} [opts.redirect="follow"] use "error" for secret-bearing hosts
 * @param {boolean} [opts.expectJson=true]
 */
export async function fetchJson(url, {
  source,
  timeout,
  retries = 2,
  method = "GET",
  body,
  headers = {},
  idempotent,
  redirect = "follow",
  expectJson = true,
} = {}) {
  const canRetry = idempotent ?? (method === "GET");
  const payload = body != null && typeof body !== "string" ? JSON.stringify(body) : body;

  let attempt = 0;
  for (;;) {
    try {
      return await outbound.run(async () => {
        let res;
        try {
          res = await _fetch(url, {
            method,
            headers,
            body: payload,
            redirect,
            signal: AbortSignal.timeout(timeout),
          });
        } catch (e) {
          // AbortSignal.timeout → TimeoutError; anything else → generic upstream.
          if (e?.name === "TimeoutError" || e?.name === "AbortError") throw new TimeoutError(source);
          throw new UpstreamError(source);
        }

        if (!res.ok) {
          const err = new UpstreamError(source, res.status);
          err.retryable = isRetryableStatus(res.status);
          err.retryAfter = Number(res.headers.get("retry-after"));
          // Drain body to free the socket; ignore content.
          try { await res.body?.cancel?.(); } catch { /* ignore */ }
          throw err;
        }

        const text = await readBounded(res, source);
        if (!expectJson) return text;
        try {
          return JSON.parse(text);
        } catch {
          throw new UpstreamError(source, res.status);
        }
      });
    } catch (err) {
      const retryable =
        canRetry &&
        attempt < retries &&
        (err instanceof TimeoutError ||
          (err instanceof UpstreamError && (err.retryable || err.upstreamStatus === undefined)));

      if (!retryable) throw err;

      let delay = BACKOFF[Math.min(attempt, BACKOFF.length - 1)] + Math.floor(Math.random() * 250);
      if (err.retryAfter && Number.isFinite(err.retryAfter)) {
        delay = Math.max(delay, err.retryAfter * 1000);
      }
      attempt++;
      await sleep(delay);
    }
  }
}
