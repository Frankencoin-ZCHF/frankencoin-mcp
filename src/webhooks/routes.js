/**
 * HTTP endpoint handlers for /webhooks/* routes.
 */

import { getEventTypeSchemas, buildEvent } from "./events.js";
import { deliverEvent } from "./delivery.js";
import { getPollerStatus } from "./poller.js";
import { getPendingRetryCount } from "./delivery.js";

/**
 * Handle all /webhooks/* HTTP requests.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {URL} url
 * @param {SubscriptionStore} store
 * @param {string} serverVersion
 */
export async function handleWebhookRequest(req, res, url, store, serverVersion) {
  const path = url.pathname;

  try {
    // POST /webhooks/subscribe
    if (path === "/webhooks/subscribe" && req.method === "POST") {
      const body = await readBody(req);
      if (!body) return sendJson(res, 400, { ok: false, error: "Invalid JSON body" });

      // Parse events from string (comma-separated) or array
      let events = body.events;
      if (typeof events === "string") {
        events = events.split(",").map((s) => s.trim()).filter(Boolean);
      }

      const result = store.create({
        url: body.url,
        secret: body.secret,
        events,
        filters: body.filters || {},
      });

      return sendJson(res, result.status || 200, result);
    }

    // DELETE /webhooks/subscriptions/:id
    const deleteMatch = path.match(/^\/webhooks\/subscriptions\/([^/]+)$/);
    if (deleteMatch && req.method === "DELETE") {
      const result = store.delete(deleteMatch[1]);
      return sendJson(res, result.status || 200, result);
    }

    // POST /webhooks/subscriptions/:id/test
    const testMatch = path.match(/^\/webhooks\/subscriptions\/([^/]+)\/test$/);
    if (testMatch && req.method === "POST") {
      const sub = store.get(testMatch[1]);
      if (!sub) return sendJson(res, 404, { ok: false, error: "Subscription not found" });

      const testEvent = buildEvent("test", {
        message: "This is a test event from Frankencoin MCP",
        subscription_id: sub.id,
        timestamp: new Date().toISOString(),
      }, "test", serverVersion);

      const start = Date.now();
      const result = await deliverEvent(sub, testEvent, store, serverVersion, true);
      const responseTimeMs = Date.now() - start;

      return sendJson(res, 200, {
        ok: true,
        delivered: result.delivered,
        status_code: result.statusCode || null,
        response_time_ms: result.responseTimeMs || responseTimeMs,
        error: result.error || undefined,
      });
    }

    // GET /webhooks/subscriptions
    if (path === "/webhooks/subscriptions" && req.method === "GET") {
      const filterUrl = url.searchParams.get("url") || undefined;
      const result = store.list(filterUrl);
      return sendJson(res, 200, result);
    }

    // GET /webhooks/events
    if (path === "/webhooks/events" && req.method === "GET") {
      return sendJson(res, 200, {
        ok: true,
        event_types: getEventTypeSchemas(),
      });
    }

    // GET /webhooks/status
    if (path === "/webhooks/status" && req.method === "GET") {
      const pollerStatus = getPollerStatus();
      const deliveryStats = store.getDeliveryStats();
      const eventCounts = store.getEventCounts();

      return sendJson(res, 200, {
        ok: true,
        poller: {
          running: pollerStatus.running,
          initialized: pollerStatus.initialized,
          last_poll_at: pollerStatus.lastPollAt
            ? new Date(pollerStatus.lastPollAt).toISOString()
            : null,
          poll_interval_ms: 60_000,
          consecutive_errors: pollerStatus.consecutiveErrors,
        },
        subscriptions: {
          total: store.subs.size,
          by_event: eventCounts,
        },
        delivery: {
          total_delivered: deliveryStats.totalDelivered,
          total_failed: deliveryStats.totalFailed,
          pending_retries: getPendingRetryCount(),
        },
      });
    }

    // 404 — unknown webhook route
    sendJson(res, 404, {
      ok: false,
      error: "Unknown webhook endpoint",
      available: [
        "POST /webhooks/subscribe",
        "DELETE /webhooks/subscriptions/:id",
        "GET /webhooks/subscriptions",
        "POST /webhooks/subscriptions/:id/test",
        "GET /webhooks/events",
        "GET /webhooks/status",
      ],
    });
  } catch (e) {
    console.error(`[webhooks] Error handling ${req.method} ${path}: ${e.message}`);
    if (!res.headersSent) {
      sendJson(res, 500, { ok: false, error: e.message });
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data, null, 2));
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = "";
    req.on("data", (chunk) => { buf += chunk; });
    req.on("end", () => {
      try {
        resolve(JSON.parse(buf));
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}
