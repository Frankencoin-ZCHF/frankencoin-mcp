/**
 * HMAC-SHA256 signing + HTTP POST delivery + retry with backoff.
 */

import crypto from "crypto";

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

  // Attempt delivery with retries
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    if (attempt > 0) {
      pendingRetries++;
      await sleep(RETRY_DELAYS[attempt - 1]);
      pendingRetries--;
    }

    const start = Date.now();
    try {
      const res = await fetch(sub.url, {
        method: "POST",
        headers,
        body: bodyString,
        redirect: "manual", // Don't follow redirects per spec
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT),
      });

      const responseTimeMs = Date.now() - start;

      if (res.status >= 200 && res.status < 300) {
        if (!isTest) {
          store.recordSuccess(sub.id, res.status);
        }
        return { delivered: true, statusCode: res.status, responseTimeMs };
      }

      // Non-2xx: log and retry
      console.error(
        `[webhook:delivery] ${sub.url} returned ${res.status} (attempt ${attempt + 1}/${RETRY_DELAYS.length + 1})`
      );

      if (attempt === RETRY_DELAYS.length) {
        // All retries exhausted
        if (!isTest) {
          store.recordFailure(sub.id, res.status);
        }
        logDeadLetter(event, sub, `HTTP ${res.status}`);
        return { delivered: false, statusCode: res.status, error: `HTTP ${res.status}`, responseTimeMs };
      }
    } catch (e) {
      const responseTimeMs = Date.now() - start;
      const errorMsg = e.name === "TimeoutError"
        ? `timeout after ${DELIVERY_TIMEOUT}ms`
        : e.message;

      console.error(
        `[webhook:delivery] ${sub.url} error: ${errorMsg} (attempt ${attempt + 1}/${RETRY_DELAYS.length + 1})`
      );

      if (attempt === RETRY_DELAYS.length) {
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function logDeadLetter(event, sub, reason) {
  console.error(
    `[webhook:dead-letter] event=${event.event_type} id=${event.id} url=${sub.url} reason=${reason} payload=${JSON.stringify(event.data)}`
  );
}
