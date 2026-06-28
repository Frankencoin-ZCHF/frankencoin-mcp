/**
 * HMAC-SHA256 signing + HTTP POST delivery + retry with backoff.
 */

import crypto from "crypto";
import http from "node:http";
import https from "node:https";
import { resolveSafeWebhookTarget } from "./urlSafety.js";

const RETRY_DELAYS = [10_000, 30_000, 90_000]; // 10s, 30s, 90s
const DELIVERY_TIMEOUT = 5_000; // 5s per attempt

// Track pending retries for status endpoint
let pendingRetries = 0;

export function getPendingRetryCount() {
  return pendingRetries;
}

/**
 * Sign a payload body string with the subscriber's secret.
 * @returns {string} hex-encoded HMAC-SHA256
 */
export function signPayload(secret, bodyString) {
  return crypto.createHmac("sha256", secret).update(bodyString).digest("hex");
}

/**
 * Deliver a single event to a single subscriber with retries.
 * @param {object} sub - Subscription object (with secretRaw, url, id)
 * @param {object} event - Complete event payload
 * @param {object} store - SubscriptionStore for recording success/failure
 * @param {string} serverVersion - Server version string
 * @param {boolean} isTest - If true, don't count toward consecutiveFailures
 * @returns {Promise<{delivered: boolean, statusCode?: number, error?: string, responseTimeMs?: number}>}
 */
export async function deliverEvent(sub, event, store, serverVersion, isTest = false) {
  let target;
  try {
    target = await resolveSafeWebhookTarget(sub.url);
  } catch (err) {
    const errorMsg = `blocked unsafe webhook URL: ${err.message}`;
    console.error(`[webhook:delivery] ${sub.url} ${errorMsg}`);
    if (!isTest) store.recordFailure(sub.id, null);
    logDeadLetter(event, sub, errorMsg);
    return { delivered: false, error: errorMsg };
  }

  const bodyString = JSON.stringify(event);
  const signature = signPayload(sub.secretRaw, bodyString);
  const timestamp = Math.floor(Date.now() / 1000).toString();

  const headers = {
    "Content-Type": "application/json",
    "User-Agent": `frankencoin-mcp/${serverVersion}`,
    "X-Frankencoin-Signature": `sha256=${signature}`,
    "X-Frankencoin-Event": event.event_type,
    "X-Frankencoin-Delivery": event.id,
    "X-Frankencoin-Timestamp": timestamp,
  };

  const maxRetries = isTest ? 0 : RETRY_DELAYS.length;

  // Attempt delivery with retries. Test deliveries are single-shot so callers
  // get fast feedback and cannot use the test endpoint as retry amplification.
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      pendingRetries++;
      await sleep(RETRY_DELAYS[attempt - 1]);
      pendingRetries--;
    }

    const start = Date.now();
    try {
      const res = await postJsonPinned(target, headers, bodyString);
      const responseTimeMs = Date.now() - start;

      if (res.statusCode >= 200 && res.statusCode < 300) {
        if (!isTest) {
          store.recordSuccess(sub.id, res.statusCode);
        }
        return { delivered: true, statusCode: res.statusCode, responseTimeMs };
      }

      // Non-2xx: log and retry
      console.error(
        `[webhook:delivery] ${sub.url} returned ${res.statusCode} (attempt ${attempt + 1}/${maxRetries + 1})`
      );

      if (attempt === maxRetries) {
        // All retries exhausted
        if (!isTest) {
          store.recordFailure(sub.id, res.statusCode);
        }
        logDeadLetter(event, sub, `HTTP ${res.statusCode}`);
        return { delivered: false, statusCode: res.statusCode, error: `HTTP ${res.statusCode}`, responseTimeMs };
      }
    } catch (e) {
      const responseTimeMs = Date.now() - start;
      const errorMsg = e.name === "TimeoutError"
        ? `timeout after ${DELIVERY_TIMEOUT}ms`
        : e.message;

      console.error(
        `[webhook:delivery] ${sub.url} error: ${errorMsg} (attempt ${attempt + 1}/${maxRetries + 1})`
      );

      if (attempt === maxRetries) {
        // All retries exhausted
        if (!isTest) {
          store.recordFailure(sub.id, null);
        }
        logDeadLetter(event, sub, errorMsg);
        return { delivered: false, error: errorMsg, responseTimeMs };
      }
    }
  }
}

/**
 * Dispatch an event to all matching subscribers in parallel.
 * Retries are sequential per subscriber but don't block other subscribers.
 */
export async function dispatchToSubscribers(store, event) {
  const subs = store.getMatching(event.event_type, event.data);
  if (subs.length === 0) return;

  console.error(`[webhook:dispatch] ${event.event_type} → ${subs.length} subscriber(s)`);

  // Parallel dispatch to all matching subscribers
  const promises = subs.map((sub) =>
    deliverEvent(sub, event, store, event.server_version).catch((e) => {
      console.error(`[webhook:dispatch] Unexpected error delivering to ${sub.url}: ${e.message}`);
    })
  );

  // Don't block the caller — fire and forget
  Promise.allSettled(promises);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function postJsonPinned(target, headers, bodyString) {
  return new Promise((resolve, reject) => {
    const { parsed, safeAddress } = target;
    const client = parsed.protocol === "http:" ? http : https;
    const options = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method: "POST",
      headers: {
        ...headers,
        "Content-Length": Buffer.byteLength(bodyString),
      },
      timeout: DELIVERY_TIMEOUT,
      agent: false,
    };

    if (safeAddress) {
      options.lookup = (_hostname, _opts, cb) => cb(null, safeAddress.address, safeAddress.family);
    }

    const req = client.request(options, (res) => {
      // Drain body so the socket can close cleanly. Redirects are deliberately
      // not followed; the status is returned exactly as received.
      res.resume();
      res.on("end", () => resolve({ statusCode: res.statusCode || 0 }));
    });

    req.on("timeout", () => {
      req.destroy(Object.assign(new Error(`timeout after ${DELIVERY_TIMEOUT}ms`), { name: "TimeoutError" }));
    });
    req.on("error", reject);
    req.write(bodyString);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function logDeadLetter(event, sub, reason) {
  console.error(
    `[webhook:dead-letter] event=${event.event_type} id=${event.id} url=${sub.url} reason=${reason} payload=${JSON.stringify(event.data)}`
  );
}
