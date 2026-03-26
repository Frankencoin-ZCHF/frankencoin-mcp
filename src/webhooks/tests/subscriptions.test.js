/**
 * Unit tests for src/webhooks/subscriptions.js
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { SubscriptionStore } from "../subscriptions.js";

const VALID_SECRET = "a".repeat(32);
const VALID_URL = "https://example.com/webhook";

function validPayload(overrides = {}) {
  return {
    url: VALID_URL,
    secret: VALID_SECRET,
    events: ["mint"],
    filters: {},
    ...overrides,
  };
}

describe("SubscriptionStore", () => {
  let store;

  beforeEach(() => {
    store = new SubscriptionStore();
  });

  afterEach(() => {
    store.destroy();
  });

  // ─── Create subscription (valid) ─────────────────────────────────────────

  describe("create — valid", () => {
    it("should create a subscription with valid inputs", () => {
      const result = store.create(validPayload());
      assert.equal(result.ok, true);
      assert.equal(result.status, 201);
      assert.ok(result.subscription);
      assert.ok(result.subscription.id.startsWith("sub_"));
      assert.equal(result.subscription.url, VALID_URL);
      assert.deepStrictEqual(result.subscription.events, ["mint"]);
    });

    it("should allow http://localhost URLs", () => {
      const result = store.create(validPayload({ url: "http://localhost:3000/hook" }));
      assert.equal(result.ok, true);
      assert.equal(result.status, 201);
    });

    it("should allow http://127.0.0.1 URLs", () => {
      const result = store.create(validPayload({ url: "http://127.0.0.1:8080/hook" }));
      assert.equal(result.ok, true);
      assert.equal(result.status, 201);
    });

    it("should accept multiple event types", () => {
      const result = store.create(validPayload({ events: ["mint", "burn", "depeg"] }));
      assert.equal(result.ok, true);
      assert.equal(result.subscription.events.length, 3);
    });

    it("should accept filters", () => {
      const result = store.create(validPayload({
        filters: { min_amount: 1000, chain_id: 1 },
      }));
      assert.equal(result.ok, true);
      assert.deepStrictEqual(result.subscription.filters, { min_amount: 1000, chain_id: 1 });
    });
  });

  // ─── Reject missing URL ──────────────────────────────────────────────────

  describe("create — reject missing URL", () => {
    it("should reject when url is missing", () => {
      const result = store.create(validPayload({ url: undefined }));
      assert.equal(result.ok, false);
      assert.equal(result.status, 400);
      assert.match(result.error, /url/i);
    });

    it("should reject when url is empty string", () => {
      const result = store.create(validPayload({ url: "" }));
      assert.equal(result.ok, false);
      assert.equal(result.status, 400);
    });
  });

  // ─── Reject non-HTTPS URL (except localhost) ─────────────────────────────

  describe("create — reject non-HTTPS URL", () => {
    it("should reject http:// URLs that aren't localhost", () => {
      const result = store.create(validPayload({ url: "http://example.com/hook" }));
      assert.equal(result.ok, false);
      assert.equal(result.status, 400);
      assert.match(result.error, /https/i);
    });

    it("should reject invalid URLs", () => {
      const result = store.create(validPayload({ url: "not-a-url" }));
      assert.equal(result.ok, false);
      assert.equal(result.status, 400);
    });

    it("should reject URLs exceeding 2048 characters", () => {
      const longUrl = "https://example.com/" + "a".repeat(2048);
      const result = store.create(validPayload({ url: longUrl }));
      assert.equal(result.ok, false);
      assert.equal(result.status, 400);
    });
  });

  // ─── Reject secret < 32 chars ────────────────────────────────────────────

  describe("create — reject short secret", () => {
    it("should reject secret shorter than 32 characters", () => {
      const result = store.create(validPayload({ secret: "short" }));
      assert.equal(result.ok, false);
      assert.equal(result.status, 400);
      assert.match(result.error, /32/);
    });

    it("should reject missing secret", () => {
      const result = store.create(validPayload({ secret: undefined }));
      assert.equal(result.ok, false);
      assert.equal(result.status, 400);
    });

    it("should reject secret of exactly 31 characters", () => {
      const result = store.create(validPayload({ secret: "a".repeat(31) }));
      assert.equal(result.ok, false);
      assert.equal(result.status, 400);
    });

    it("should accept secret of exactly 32 characters", () => {
      const result = store.create(validPayload({ secret: "a".repeat(32) }));
      assert.equal(result.ok, true);
    });
  });

  // ─── Reject unknown event types ──────────────────────────────────────────

  describe("create — reject unknown event types", () => {
    it("should reject unknown event type", () => {
      const result = store.create(validPayload({ events: ["totally_fake_event"] }));
      assert.equal(result.ok, false);
      assert.equal(result.status, 400);
      assert.match(result.error, /unknown/i);
    });

    it("should reject when events array contains a mix of valid and invalid", () => {
      const result = store.create(validPayload({ events: ["mint", "invalid_event"] }));
      assert.equal(result.ok, false);
      assert.equal(result.status, 400);
    });

    it("should reject empty events array", () => {
      const result = store.create(validPayload({ events: [] }));
      assert.equal(result.ok, false);
      assert.equal(result.status, 400);
    });

    it("should reject non-array events", () => {
      const result = store.create(validPayload({ events: "mint" }));
      assert.equal(result.ok, false);
      assert.equal(result.status, 400);
    });
  });

  // ─── Accept wildcard ─────────────────────────────────────────────────────

  describe("create — accept wildcard", () => {
    it('should accept ["*"] wildcard and resolve to all event types', () => {
      const result = store.create(validPayload({ events: ["*"] }));
      assert.equal(result.ok, true);
      assert.equal(result.status, 201);
      assert.equal(result.subscription.events.length, 14);
    });
  });

  // ─── Max 100 global subscriptions cap ─────────────────────────────────────

  describe("create — max global subscriptions", () => {
    it("should reject when global cap of 100 is reached", () => {
      // Create 100 subscriptions with different URLs to avoid per-URL cap
      for (let i = 0; i < 100; i++) {
        const result = store.create(validPayload({
          url: `https://example${i}.com/hook`,
        }));
        assert.equal(result.ok, true, `Failed to create subscription ${i}`);
      }
      // 101st should fail
      const result = store.create(validPayload({
        url: "https://overflow.com/hook",
      }));
      assert.equal(result.ok, false);
      assert.equal(result.status, 429);
      assert.match(result.error, /100/);
    });
  });

  // ─── Max 5 per-URL cap ────────────────────────────────────────────────────

  describe("create — max per-URL subscriptions", () => {
    it("should reject when per-URL cap of 5 is reached", () => {
      for (let i = 0; i < 5; i++) {
        const result = store.create(validPayload());
        assert.equal(result.ok, true, `Failed to create subscription ${i}`);
      }
      // 6th for same URL should fail
      const result = store.create(validPayload());
      assert.equal(result.ok, false);
      assert.equal(result.status, 429);
      assert.match(result.error, /5/);
    });
  });

  // ─── TTL expiry ───────────────────────────────────────────────────────────

  describe("TTL expiry", () => {
    it("should expire subscriptions after TTL", () => {
      const result = store.create(validPayload());
      assert.equal(result.ok, true);
      const subId = result.subscription.id;

      // Get the sub and manually set expiresAt to the past
      const sub = store.subs.get(subId);
      sub.expiresAt = Date.now() - 1;

      // Trigger purge via list()
      const listed = store.list();
      assert.equal(listed.subscriptions.length, 0);

      // get() should also return null
      assert.equal(store.get(subId), null);
    });

    it("should set correct expiry time (~7 days)", () => {
      const before = Date.now();
      const result = store.create(validPayload());
      const after = Date.now();

      const sub = store.subs.get(result.subscription.id);
      const expectedTtl = 7 * 24 * 60 * 60 * 1000;

      assert.ok(sub.expiresAt >= before + expectedTtl);
      assert.ok(sub.expiresAt <= after + expectedTtl);
    });
  });

  // ─── Auto-delete after 10 consecutive failures ────────────────────────────

  describe("auto-delete after consecutive failures", () => {
    it("should auto-delete subscription after 10 consecutive failures", () => {
      const result = store.create(validPayload());
      const subId = result.subscription.id;

      for (let i = 0; i < 10; i++) {
        store.recordFailure(subId, 500);
      }

      // Should be auto-deleted
      assert.equal(store.subs.has(subId), false);
    });

    it("should NOT auto-delete before 10 failures", () => {
      const result = store.create(validPayload());
      const subId = result.subscription.id;

      for (let i = 0; i < 9; i++) {
        store.recordFailure(subId, 500);
      }

      assert.equal(store.subs.has(subId), true);
    });

    it("should reset consecutive failures on success", () => {
      const result = store.create(validPayload());
      const subId = result.subscription.id;

      // Fail 8 times
      for (let i = 0; i < 8; i++) {
        store.recordFailure(subId, 500);
      }

      // One success resets the counter
      store.recordSuccess(subId, 200);

      // Now fail 9 more times — should NOT trigger deletion (counter reset)
      for (let i = 0; i < 9; i++) {
        store.recordFailure(subId, 500);
      }

      assert.equal(store.subs.has(subId), true);
    });
  });

  // ─── getMatching filter matching ──────────────────────────────────────────

  describe("getMatching — filter matching", () => {
    it("should match subscriptions by event type", () => {
      store.create(validPayload({ events: ["mint"] }));
      store.create(validPayload({
        url: "https://other.com/hook",
        events: ["burn"],
      }));

      const mintMatches = store.getMatching("mint", { minted_zchf: 100 });
      assert.equal(mintMatches.length, 1);

      const burnMatches = store.getMatching("burn", { burned_zchf: 100 });
      assert.equal(burnMatches.length, 1);

      const depegMatches = store.getMatching("depeg", { price_chf: 0.98 });
      assert.equal(depegMatches.length, 0);
    });

    it("should filter by min_amount", () => {
      store.create(validPayload({
        events: ["mint"],
        filters: { min_amount: 5000 },
      }));

      const big = store.getMatching("mint", { minted_zchf: 10000 });
      assert.equal(big.length, 1);

      const small = store.getMatching("mint", { minted_zchf: 1000 });
      assert.equal(small.length, 0);
    });

    it("should filter by chain_id", () => {
      store.create(validPayload({
        events: ["mint"],
        filters: { chain_id: 1 },
      }));

      const eth = store.getMatching("mint", { chain_id: 1, minted_zchf: 100 });
      assert.equal(eth.length, 1);

      const base = store.getMatching("mint", { chain_id: 8453, minted_zchf: 100 });
      assert.equal(base.length, 0);
    });

    it("should filter by address", () => {
      store.create(validPayload({
        events: ["mint"],
        filters: { address: "0xABCDEF" },
      }));

      const match = store.getMatching("mint", { position: "0xabcdef", minted_zchf: 100 });
      assert.equal(match.length, 1);

      const noMatch = store.getMatching("mint", { position: "0x999999", minted_zchf: 100 });
      assert.equal(noMatch.length, 0);
    });
  });

  // ─── Secret stored as hash, not returned ──────────────────────────────────

  describe("secret handling", () => {
    it("should store secret as SHA-256 hash internally", () => {
      const secret = "my-super-secret-that-is-at-least-32-characters-long";
      const result = store.create(validPayload({ secret }));
      const sub = store.subs.get(result.subscription.id);

      const expectedHash = crypto.createHash("sha256").update(secret).digest("hex");
      assert.equal(sub.secretHash, expectedHash);
    });

    it("should NOT include secretHash or secretRaw in public output (list)", () => {
      store.create(validPayload());
      const listed = store.list();
      const pub = listed.subscriptions[0];

      assert.ok(!("secretHash" in pub), "secretHash should not be in public output");
      assert.ok(!("secretRaw" in pub), "secretRaw should not be in public output");
      assert.ok(!("secret" in pub), "secret should not be in public output");
    });

    it("should preserve raw secret for HMAC signing", () => {
      const secret = "a".repeat(32);
      const result = store.create(validPayload({ secret }));
      const sub = store.subs.get(result.subscription.id);
      assert.equal(sub.secretRaw, secret);
    });
  });

  // ─── Delete ──────────────────────────────────────────────────────────────

  describe("delete", () => {
    it("should delete an existing subscription", () => {
      const result = store.create(validPayload());
      const deleteResult = store.delete(result.subscription.id);
      assert.equal(deleteResult.ok, true);
      assert.equal(deleteResult.deleted, result.subscription.id);
    });

    it("should return 404 for non-existent subscription", () => {
      const result = store.delete("sub_nonexistent");
      assert.equal(result.ok, false);
      assert.equal(result.status, 404);
    });
  });

  // ─── List ─────────────────────────────────────────────────────────────────

  describe("list", () => {
    it("should list all subscriptions", () => {
      store.create(validPayload());
      store.create(validPayload({ url: "https://other.com/hook" }));

      const listed = store.list();
      assert.equal(listed.ok, true);
      assert.equal(listed.total, 2);
      assert.equal(listed.subscriptions.length, 2);
    });

    it("should filter by URL", () => {
      store.create(validPayload());
      store.create(validPayload({ url: "https://other.com/hook" }));

      const filtered = store.list(VALID_URL);
      assert.equal(filtered.total, 1);
      assert.equal(filtered.subscriptions[0].url, VALID_URL);
    });
  });

  // ─── Delivery stats ──────────────────────────────────────────────────────

  describe("delivery stats", () => {
    it("should track total delivered across all subscriptions", () => {
      const r1 = store.create(validPayload());
      const r2 = store.create(validPayload({ url: "https://other.com/hook" }));

      store.recordSuccess(r1.subscription.id, 200);
      store.recordSuccess(r1.subscription.id, 200);
      store.recordSuccess(r2.subscription.id, 200);

      const stats = store.getDeliveryStats();
      assert.equal(stats.totalDelivered, 3);
      assert.equal(stats.totalFailed, 0);
    });

    it("should track event counts by type", () => {
      store.create(validPayload({ events: ["mint", "burn"] }));
      store.create(validPayload({ url: "https://other.com/hook", events: ["mint"] }));

      const counts = store.getEventCounts();
      assert.equal(counts.mint, 2);
      assert.equal(counts.burn, 1);
    });
  });
});
