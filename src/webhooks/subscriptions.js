/**
 * Subscription store with file-backed persistence.
 *
 * Subscriptions survive process restarts and Railway redeploys.
 * Persistence path: WEBHOOK_DATA_DIR env var (default: /data) → subscriptions.json
 * Falls back to ./data/subscriptions.json if /data is not writable.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { EVENT_TYPES, matchesFilters } from "./events.js";

const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_SUBSCRIPTIONS = 100;
const MAX_PER_URL = 5;
const MAX_CONSECUTIVE_FAILURES = 10;

function resolveDataPath() {
  const candidates = [
    process.env.WEBHOOK_DATA_DIR,
    "/data",
    path.join(process.cwd(), "data"),
  ].filter(Boolean);

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      // Test write access
      const testFile = path.join(dir, ".write_test");
      fs.writeFileSync(testFile, "");
      fs.unlinkSync(testFile);
      return path.join(dir, "subscriptions.json");
    } catch {
      // try next
    }
  }
  // Final fallback: in-process temp (no persistence, but won't crash)
  console.warn("[webhook] No writable data directory found — subscriptions will not persist across restarts");
  return null;
}

export class SubscriptionStore {
  constructor() {
    /** @type {Map<string, object>} */
    this.subs = new Map();

    this._persistPath = resolveDataPath();
    if (this._persistPath) {
      console.log(`[webhook] Persisting subscriptions to ${this._persistPath}`);
      this._load();
    }

    // Expiry check every 60s + persist after purge
    this._expiryTimer = setInterval(() => {
      const before = this.subs.size;
      this._purgeExpired();
      if (this.subs.size !== before) this._save();
    }, 60_000);
    if (this._expiryTimer.unref) this._expiryTimer.unref();
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  _save() {
    if (!this._persistPath) return;
    try {
      const data = [];
      for (const sub of this.subs.values()) {
        data.push({
          id: sub.id,
          url: sub.url,
          secretHash: sub.secretHash,
          secretRaw: sub.secretRaw,
          events: [...sub.events],
          filters: sub.filters,
          createdAt: sub.createdAt,
          expiresAt: sub.expiresAt,
          deliveryStats: sub.deliveryStats,
        });
      }
      const tmp = this._persistPath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
      fs.renameSync(tmp, this._persistPath);
    } catch (err) {
      console.error("[webhook] Failed to persist subscriptions:", err.message);
    }
  }

  _load() {
    if (!this._persistPath) return;
    try {
      if (!fs.existsSync(this._persistPath)) return;
      const raw = fs.readFileSync(this._persistPath, "utf8");
      const data = JSON.parse(raw);
      const now = Date.now();
      let loaded = 0;
      for (const item of data) {
        if (item.expiresAt < now) continue; // skip expired
        this.subs.set(item.id, {
          ...item,
          events: new Set(item.events),
        });
        loaded++;
      }
      console.log(`[webhook] Loaded ${loaded} subscription(s) from disk`);
    } catch (err) {
      console.error("[webhook] Failed to load subscriptions from disk:", err.message);
    }
  }

  /**
   * Create a new subscription.
   * @returns {{ ok: boolean, subscription?: object, error?: string, status?: number }}
   */
  create({ url, secret, events, filters }) {
    // Validate URL
    if (!url || typeof url !== "string") {
      return { ok: false, error: "url is required", status: 400 };
    }
    if (url.length > 2048) {
      return { ok: false, error: "url exceeds 2048 characters", status: 400 };
    }
    try {
      const parsed = new URL(url);
      const isLocalhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
      if (parsed.protocol !== "https:" && !isLocalhost) {
        return { ok: false, error: "url must be HTTPS (HTTP allowed only for localhost)", status: 400 };
      }
    } catch {
      return { ok: false, error: "url is not a valid URL", status: 400 };
    }

    // Validate secret
    if (!secret || typeof secret !== "string" || secret.length < 32) {
      return { ok: false, error: "secret must be at least 32 characters", status: 400 };
    }

    // Validate events
    if (!events || !Array.isArray(events) || events.length === 0) {
      return { ok: false, error: "events must be a non-empty array", status: 400 };
    }
    const isWildcard = events.length === 1 && events[0] === "*";
    const resolvedEvents = isWildcard ? [...EVENT_TYPES] : events;
    for (const e of resolvedEvents) {
      if (!EVENT_TYPES.has(e)) {
        return { ok: false, error: `Unknown event type: ${e}`, status: 400 };
      }
    }

    // Check global cap
    this._purgeExpired();
    if (this.subs.size >= MAX_SUBSCRIPTIONS) {
      return { ok: false, error: `Maximum ${MAX_SUBSCRIPTIONS} subscriptions reached`, status: 429 };
    }

    // Check per-URL cap
    const urlCount = this._countByUrl(url);
    if (urlCount >= MAX_PER_URL) {
      return { ok: false, error: `Maximum ${MAX_PER_URL} subscriptions per URL reached`, status: 429 };
    }

    const now = Date.now();
    const id = "sub_" + crypto.randomBytes(6).toString("hex");
    const sub = {
      id,
      url,
      secretHash: crypto.createHash("sha256").update(secret).digest("hex"),
      secretRaw: secret,
      events: new Set(resolvedEvents),
      filters: filters || {},
      createdAt: now,
      expiresAt: now + TTL_MS,
      deliveryStats: {
        totalDelivered: 0,
        totalFailed: 0,
        lastDeliveredAt: null,
        lastStatusCode: null,
        consecutiveFailures: 0,
      },
    };

    this.subs.set(id, sub);
    this._save();

    return {
      ok: true,
      subscription: this._toPublic(sub),
      status: 201,
    };
  }

  /**
   * Delete a subscription by ID.
   * @returns {{ ok: boolean, deleted?: string, error?: string, status?: number }}
   */
  delete(id) {
    if (!this.subs.has(id)) {
      return { ok: false, error: "Subscription not found", status: 404 };
    }
    this.subs.delete(id);
    this._save();
    return { ok: true, deleted: id };
  }

  /**
   * List subscriptions, optionally filtered by URL.
   */
  list(filterUrl) {
    this._purgeExpired();
    const results = [];
    for (const sub of this.subs.values()) {
      if (filterUrl && sub.url !== filterUrl) continue;
      results.push(this._toPublic(sub));
    }
    return { ok: true, subscriptions: results, total: results.length };
  }

  /**
   * Get a single subscription by ID.
   */
  get(id) {
    const sub = this.subs.get(id);
    if (!sub) return null;
    if (sub.expiresAt < Date.now()) {
      this.subs.delete(id);
      return null;
    }
    return sub;
  }

  /**
   * Get all subscriptions matching an event type + data.
   */
  getMatching(eventType, eventData) {
    this._purgeExpired();
    const matched = [];
    for (const sub of this.subs.values()) {
      if (!sub.events.has(eventType) && !sub.events.has("*")) continue;
      if (!matchesFilters(eventType, eventData, sub.filters)) continue;
      matched.push(sub);
    }
    return matched;
  }

  /**
   * Record a successful delivery.
   */
  recordSuccess(id, statusCode) {
    const sub = this.subs.get(id);
    if (!sub) return;
    sub.deliveryStats.totalDelivered++;
    sub.deliveryStats.lastDeliveredAt = Date.now();
    sub.deliveryStats.lastStatusCode = statusCode;
    sub.deliveryStats.consecutiveFailures = 0;
  }

  /**
   * Record a failed delivery (after all retries exhausted for one event).
   */
  recordFailure(id, statusCode) {
    const sub = this.subs.get(id);
    if (!sub) return;
    sub.deliveryStats.totalFailed++;
    sub.deliveryStats.lastStatusCode = statusCode;
    sub.deliveryStats.consecutiveFailures++;

    if (sub.deliveryStats.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      console.error(`[webhook] Auto-deleting subscription ${id} (${sub.url}) after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`);
      this.subs.delete(id);
    }
    this._save();
  }

  /**
   * Get aggregate delivery stats across all subscriptions.
   */
  getDeliveryStats() {
    let totalDelivered = 0;
    let totalFailed = 0;
    for (const sub of this.subs.values()) {
      totalDelivered += sub.deliveryStats.totalDelivered;
      totalFailed += sub.deliveryStats.totalFailed;
    }
    return { totalDelivered, totalFailed };
  }

  /**
   * Get subscription counts grouped by event type.
   */
  getEventCounts() {
    const counts = {};
    for (const sub of this.subs.values()) {
      for (const evt of sub.events) {
        counts[evt] = (counts[evt] || 0) + 1;
      }
    }
    return counts;
  }

  /**
   * Destroy the store (stop timers).
   */
  destroy() {
    clearInterval(this._expiryTimer);
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  _purgeExpired() {
    const now = Date.now();
    for (const [id, sub] of this.subs) {
      if (sub.expiresAt < now) {
        this.subs.delete(id);
      }
    }
  }

  _countByUrl(url) {
    let count = 0;
    for (const sub of this.subs.values()) {
      if (sub.url === url) count++;
    }
    return count;
  }

  _toPublic(sub) {
    return {
      id: sub.id,
      url: sub.url,
      events: [...sub.events],
      filters: sub.filters,
      created_at: new Date(sub.createdAt).toISOString(),
      expires_at: new Date(sub.expiresAt).toISOString(),
      delivery_stats: {
        total_delivered: sub.deliveryStats.totalDelivered,
        total_failed: sub.deliveryStats.totalFailed,
        last_delivered_at: sub.deliveryStats.lastDeliveredAt
          ? new Date(sub.deliveryStats.lastDeliveredAt).toISOString()
          : null,
        last_status_code: sub.deliveryStats.lastStatusCode,
        consecutive_failures: sub.deliveryStats.consecutiveFailures,
      },
    };
  }
}
