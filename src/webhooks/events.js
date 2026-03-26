/**
 * Event type definitions, thresholds, filter applicability, and payload builders.
 */

import crypto from "crypto";

// ─── Supported event types ───────────────────────────────────────────────────

export const EVENT_TYPES = new Set([
  "mint",
  "burn",
  "large_transfer",
  "challenge_start",
  "challenge_bid",
  "challenge_end",
  "depeg",
  "depeg_resolved",
  "fps_large_trade",
  "minter_proposed",
  "minter_approved",
  "minter_denied",
  "position_proposed",
  "position_active",
  "position_denied",
  "position_closed",
  "rate_change",
  "supply_change",
]);

// ─── Default thresholds (when subscriber sets no min_amount) ─────────────────

export const DEFAULT_THRESHOLDS = {
  mint: 0,
  burn: 0,
  large_transfer: 0, // deferred to v2
  fps_large_trade: 1_000,
  supply_change: 10_000,
};

// ─── Filter applicability per event type ─────────────────────────────────────
// Which filter keys apply to which event types.

export const FILTER_APPLICABILITY = {
  min_amount: new Set([
    "mint", "burn", "large_transfer", "fps_large_trade", "supply_change",
  ]),
  chain_id: new Set([
    "mint", "burn", "large_transfer", "challenge_start", "challenge_bid",
    "challenge_end", "fps_large_trade", "minter_proposed", "minter_approved",
    "minter_denied", "position_proposed", "position_active", "position_denied",
    "position_closed", "rate_change", "supply_change",
  ]),
  address: new Set([
    "mint", "burn", "challenge_start", "challenge_bid", "challenge_end",
    "fps_large_trade", "minter_proposed", "minter_approved", "minter_denied",
    "position_proposed", "position_active", "position_denied", "position_closed",
  ]),
};

// ─── Event ID generator ──────────────────────────────────────────────────────

export function generateEventId() {
  return "evt_" + crypto.randomBytes(8).toString("hex");
}

// ─── Payload builders ────────────────────────────────────────────────────────
// Each builder returns a complete webhook event object.

export function buildEvent(eventType, data, source, serverVersion) {
  return {
    id: generateEventId(),
    event_type: eventType,
    timestamp: new Date().toISOString(),
    data,
    source,
    server_version: serverVersion,
  };
}

// ─── Filter matching ─────────────────────────────────────────────────────────
// Returns true if the event data matches the subscription filters.

export function matchesFilters(eventType, eventData, filters) {
  if (!filters) return true;

  // min_amount filter
  if (
    filters.min_amount != null &&
    FILTER_APPLICABILITY.min_amount.has(eventType)
  ) {
    const amount = getAmountForEvent(eventType, eventData);
    if (amount != null && amount < filters.min_amount) return false;
  }

  // chain_id filter
  if (
    filters.chain_id != null &&
    FILTER_APPLICABILITY.chain_id.has(eventType)
  ) {
    if (eventData.chain_id != null && eventData.chain_id !== filters.chain_id) {
      return false;
    }
  }

  // address filter
  if (
    filters.address != null &&
    FILTER_APPLICABILITY.address.has(eventType)
  ) {
    const addresses = getAddressesForEvent(eventType, eventData);
    const filterAddr = filters.address.toLowerCase();
    if (addresses.length > 0 && !addresses.some((a) => a.toLowerCase() === filterAddr)) {
      return false;
    }
  }

  return true;
}

// ─── Helpers for filter matching ─────────────────────────────────────────────

function getAmountForEvent(eventType, data) {
  switch (eventType) {
    case "mint": return data.minted_zchf;
    case "burn": return data.burned_zchf;
    case "large_transfer": return data.amount_zchf;
    case "fps_large_trade": return data.amount_zchf;
    case "supply_change": return Math.abs(data.change_amount);
    default: return null;
  }
}

function getAddressesForEvent(eventType, data) {
  switch (eventType) {
    case "mint":
    case "burn":
      return [data.position, data.owner].filter(Boolean);
    case "challenge_start":
      return [data.position, data.challenger].filter(Boolean);
    case "challenge_bid":
      return [data.position, data.bidder].filter(Boolean);
    case "challenge_end":
      return [data.position].filter(Boolean);
    case "fps_large_trade":
      return [data.trader].filter(Boolean);
    case "minter_proposed":
    case "minter_approved":
    case "minter_denied":
      return [data.minter_address, data.suggestor].filter(Boolean);
    case "position_proposed":
    case "position_active":
    case "position_denied":
    case "position_closed":
      return [data.position, data.owner].filter(Boolean);
    default:
      return [];
  }
}

// ─── Event type metadata (for GET /webhooks/events) ──────────────────────────

export function getEventTypeSchemas() {
  return Array.from(EVENT_TYPES).map((type) => ({
    event_type: type,
    applicable_filters: {
      min_amount: FILTER_APPLICABILITY.min_amount.has(type),
      chain_id: FILTER_APPLICABILITY.chain_id.has(type),
      address: FILTER_APPLICABILITY.address.has(type),
    },
    default_threshold: DEFAULT_THRESHOLDS[type] ?? null,
  }));
}
