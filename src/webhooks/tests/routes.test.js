/**
 * Integration tests for src/webhooks/routes.js
 * Starts a real HTTP server on port 2000.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { SubscriptionStore } from "../subscriptions.js";
import { handleWebhookRequest } from "../routes.js";

const PORT = 2000;
const RECEIVER_PORT = 2001;
const BASE = `http://localhost:${PORT}`;
const VALID_SECRET = "a".repeat(32);

let server;
let store;

async function request(method, path, body = null) {
  const url = `${BASE}${path}`;
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

describe("Webhook Routes Integration", () => {
  before(async () => {
    store = new SubscriptionStore();
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      await handleWebhookRequest(req, res, url, store, "2.0.0");
    });
    await new Promise((resolve) => server.listen(PORT, resolve));
  });

  after(async () => {
    store.destroy();
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    // Clear all subscriptions between tests
    store.subs.clear();
  });

  // ─── POST /webhooks/subscribe → 201 ─────────────────────────────────────

  describe("POST /webhooks/subscribe", () => {
    it("should create a subscription and return 201", async () => {
      const { status, json } = await request("POST", "/webhooks/subscribe", {
        url: "https://example.com/hook",
        secret: VALID_SECRET,
        events: ["mint"],
      });

      assert.equal(status, 201);
      assert.equal(json.ok, true);
      assert.ok(json.subscription);
      assert.ok(json.subscription.id.startsWith("sub_"));
      assert.equal(json.subscription.url, "https://example.com/hook");
      assert.deepStrictEqual(json.subscription.events, ["mint"]);
    });

    it("should accept wildcard events", async () => {
      const { status, json } = await request("POST", "/webhooks/subscribe", {
        url: "https://example.com/hook",
        secret: VALID_SECRET,
        events: ["*"],
      });

      assert.equal(status, 201);
      assert.equal(json.subscription.events.length, 14);
    });

    it("should accept comma-separated events string", async () => {
      const { status, json } = await request("POST", "/webhooks/subscribe", {
        url: "https://example.com/hook",
        secret: VALID_SECRET,
        events: "mint,burn,depeg",
      });

      assert.equal(status, 201);
      assert.equal(json.subscription.events.length, 3);
    });
  });

  // ─── POST /webhooks/subscribe → 400 ─────────────────────────────────────

  describe("POST /webhooks/subscribe — 400 errors", () => {
    it("should return 400 for missing url", async () => {
      const { status, json } = await request("POST", "/webhooks/subscribe", {
        secret: VALID_SECRET,
        events: ["mint"],
      });

      assert.equal(status, 400);
      assert.equal(json.ok, false);
    });

    it("should return 400 for short secret", async () => {
      const { status, json } = await request("POST", "/webhooks/subscribe", {
        url: "https://example.com/hook",
        secret: "short",
        events: ["mint"],
      });

      assert.equal(status, 400);
      assert.equal(json.ok, false);
    });

    it("should return 400 for unknown event type", async () => {
      const { status, json } = await request("POST", "/webhooks/subscribe", {
        url: "https://example.com/hook",
        secret: VALID_SECRET,
        events: ["fake_event"],
      });

      assert.equal(status, 400);
      assert.equal(json.ok, false);
    });

    it("should return 400 for non-HTTPS URL", async () => {
      const { status, json } = await request("POST", "/webhooks/subscribe", {
        url: "http://example.com/hook",
        secret: VALID_SECRET,
        events: ["mint"],
      });

      assert.equal(status, 400);
      assert.equal(json.ok, false);
    });

    it("should return 400 for invalid JSON body", async () => {
      const url = `${BASE}/webhooks/subscribe`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json {{{",
      });
      assert.equal(res.status, 400);
    });
  });

  // ─── DELETE /webhooks/subscriptions/:id → 200 ───────────────────────────

  describe("DELETE /webhooks/subscriptions/:id", () => {
    it("should delete an existing subscription and return 200", async () => {
      // Create first
      const { json: created } = await request("POST", "/webhooks/subscribe", {
        url: "https://example.com/hook",
        secret: VALID_SECRET,
        events: ["mint"],
      });
      const id = created.subscription.id;

      // Delete
      const { status, json } = await request("DELETE", `/webhooks/subscriptions/${id}`);
      assert.equal(status, 200);
      assert.equal(json.ok, true);
      assert.equal(json.deleted, id);
    });

    it("should return 404 for unknown id", async () => {
      const { status, json } = await request("DELETE", "/webhooks/subscriptions/sub_nonexistent");
      assert.equal(status, 404);
      assert.equal(json.ok, false);
    });
  });

  // ─── GET /webhooks/subscriptions ────────────────────────────────────────

  describe("GET /webhooks/subscriptions", () => {
    it("should list all subscriptions", async () => {
      // Create two
      await request("POST", "/webhooks/subscribe", {
        url: "https://example.com/hook1",
        secret: VALID_SECRET,
        events: ["mint"],
      });
      await request("POST", "/webhooks/subscribe", {
        url: "https://example.com/hook2",
        secret: VALID_SECRET,
        events: ["burn"],
      });

      const { status, json } = await request("GET", "/webhooks/subscriptions");
      assert.equal(status, 200);
      assert.equal(json.ok, true);
      assert.equal(json.total, 2);
      assert.equal(json.subscriptions.length, 2);
    });

    it("should filter by url", async () => {
      await request("POST", "/webhooks/subscribe", {
        url: "https://example.com/hook1",
        secret: VALID_SECRET,
        events: ["mint"],
      });
      await request("POST", "/webhooks/subscribe", {
        url: "https://example.com/hook2",
        secret: VALID_SECRET,
        events: ["burn"],
      });

      const { status, json } = await request(
        "GET",
        "/webhooks/subscriptions?url=https://example.com/hook1"
      );
      assert.equal(status, 200);
      assert.equal(json.total, 1);
      assert.equal(json.subscriptions[0].url, "https://example.com/hook1");
    });
  });

  // ─── POST /webhooks/subscriptions/:id/test ──────────────────────────────

  describe("POST /webhooks/subscriptions/:id/test", () => {
    it("should deliver a test event to a local receiver", async () => {
      let receivedPayload = null;

      // Start receiver on port 2001
      const receiver = http.createServer((req, res) => {
        let buf = "";
        req.on("data", (d) => buf += d);
        req.on("end", () => {
          receivedPayload = JSON.parse(buf);
          res.writeHead(200);
          res.end("ok");
        });
      });
      await new Promise((resolve) => receiver.listen(RECEIVER_PORT, resolve));

      try {
        // Create subscription pointing to our receiver
        const { json: created } = await request("POST", "/webhooks/subscribe", {
          url: `http://localhost:${RECEIVER_PORT}/hook`,
          secret: VALID_SECRET,
          events: ["mint"],
        });
        const id = created.subscription.id;

        // Trigger test delivery
        const { status, json } = await request("POST", `/webhooks/subscriptions/${id}/test`);
        assert.equal(status, 200);
        assert.equal(json.ok, true);
        assert.equal(json.delivered, true);
        assert.equal(json.status_code, 200);
        assert.ok(json.response_time_ms >= 0);

        // Verify receiver got the payload
        assert.ok(receivedPayload);
        assert.equal(receivedPayload.event_type, "test");
        assert.ok(receivedPayload.data.message);
        assert.equal(receivedPayload.data.subscription_id, id);
      } finally {
        await new Promise((resolve) => receiver.close(resolve));
      }
    });

    it("should return 404 for non-existent subscription", async () => {
      const { status, json } = await request("POST", "/webhooks/subscriptions/sub_nonexistent/test");
      assert.equal(status, 404);
      assert.equal(json.ok, false);
    });
  });

  // ─── GET /webhooks/status ───────────────────────────────────────────────

  describe("GET /webhooks/status", () => {
    it("should return correct status shape", async () => {
      const { status, json } = await request("GET", "/webhooks/status");
      assert.equal(status, 200);
      assert.equal(json.ok, true);

      // Check structure
      assert.ok("poller" in json);
      assert.ok("subscriptions" in json);
      assert.ok("delivery" in json);

      // Poller fields
      assert.ok("running" in json.poller);
      assert.ok("initialized" in json.poller);
      assert.ok("last_poll_at" in json.poller);
      assert.ok("poll_interval_ms" in json.poller);
      assert.ok("consecutive_errors" in json.poller);

      // Subscription fields
      assert.ok("total" in json.subscriptions);
      assert.ok("by_event" in json.subscriptions);

      // Delivery fields
      assert.ok("total_delivered" in json.delivery);
      assert.ok("total_failed" in json.delivery);
      assert.ok("pending_retries" in json.delivery);
    });
  });

  // ─── GET /webhooks/events ───────────────────────────────────────────────

  describe("GET /webhooks/events", () => {
    it("should list all 14 event types", async () => {
      const { status, json } = await request("GET", "/webhooks/events");
      assert.equal(status, 200);
      assert.equal(json.ok, true);
      assert.equal(json.event_types.length, 14);
    });

    it("each event type should have correct schema shape", async () => {
      const { json } = await request("GET", "/webhooks/events");
      for (const eventType of json.event_types) {
        assert.ok("event_type" in eventType);
        assert.ok("applicable_filters" in eventType);
        assert.ok("default_threshold" in eventType);
      }
    });
  });

  // ─── 404 for unknown webhook route ──────────────────────────────────────

  describe("Unknown routes", () => {
    it("should return 404 for unknown webhook path", async () => {
      const { status, json } = await request("GET", "/webhooks/nonexistent");
      assert.equal(status, 404);
      assert.equal(json.ok, false);
      assert.ok(json.available);
    });
  });
});
