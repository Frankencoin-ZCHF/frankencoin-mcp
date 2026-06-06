/**
 * Unit tests for src/webhooks/events.js
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EVENT_TYPES,
  DEFAULT_THRESHOLDS,
  FILTER_APPLICABILITY,
  generateEventId,
  buildEvent,
  matchesFilters,
  getEventTypeSchemas,
} from "../events.js";

// ─── SUPPORTED_EVENTS ─────────────────────────────────────────────────────────

describe("EVENT_TYPES", () => {
  const EXPECTED = [
    "mint", "burn", "large_transfer",
    "challenge_start", "challenge_bid", "challenge_end",
    "depeg", "depeg_resolved",
    "fps_large_trade",
    "minter_proposed", "minter_approved",
    "rate_change", "supply_change",
  ];

  it("should contain exactly 18 event types", () => {
    assert.equal(EVENT_TYPES.size, 18, `Expected 18 event types, got ${EVENT_TYPES.size}`);
  });

  for (const type of EXPECTED) {
    it(`should include "${type}"`, () => {
      assert.ok(EVENT_TYPES.has(type), `Missing event type: ${type}`);
    });
  }
});

// ─── generateEventId ──────────────────────────────────────────────────────────

describe("generateEventId", () => {
  it("should return a string starting with 'evt_'", () => {
    const id = generateEventId();
    assert.ok(id.startsWith("evt_"));
  });

  it("should return unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateEventId()));
    assert.equal(ids.size, 100, "Generated IDs should be unique");
  });
});

// ─── buildEvent ───────────────────────────────────────────────────────────────

describe("buildEvent", () => {
  it("should return correct shape for any event type", () => {
    const event = buildEvent("mint", { minted_zchf: 1000 }, "test", "2.0.0");
    assert.ok(event.id.startsWith("evt_"));
    assert.equal(event.event_type, "mint");
    assert.ok(event.timestamp);
    assert.deepStrictEqual(event.data, { minted_zchf: 1000 });
    assert.equal(event.source, "test");
    assert.equal(event.server_version, "2.0.0");
  });

  it("should generate ISO 8601 timestamp", () => {
    const event = buildEvent("burn", {}, "test", "2.0.0");
    // Should be parseable as a date
    const parsed = new Date(event.timestamp);
    assert.ok(!isNaN(parsed.getTime()), "Timestamp should be valid ISO date");
  });

  it("should include all required top-level fields", () => {
    const event = buildEvent("depeg", { price_chf: 0.98 }, "coingecko", "2.0.0");
    const requiredFields = ["id", "event_type", "timestamp", "data", "source", "server_version"];
    for (const field of requiredFields) {
      assert.ok(field in event, `Missing required field: ${field}`);
    }
  });
});

// ─── Payload builder shapes per event type ────────────────────────────────────

describe("Payload shapes for each event type", () => {
  it("mint event payload", () => {
    const event = buildEvent("mint", {
      chain_id: 1, chain_name: "Ethereum", position: "0xabc",
      owner: "0xdef", collateral_symbol: "WETH",
      minted_zchf: 5000, minted_raw: "5000000000000000000000", tx_hash: "0x123",
    }, "ponder", "2.0.0");
    assert.equal(event.event_type, "mint");
    assert.equal(event.data.chain_id, 1);
    assert.equal(event.data.minted_zchf, 5000);
  });

  it("burn event payload", () => {
    const event = buildEvent("burn", {
      chain_id: 1, chain_name: "Ethereum", position: "0xabc",
      owner: "0xdef", collateral_symbol: "WBTC",
      burned_zchf: 3000, burned_raw: "3000000000000000000000", tx_hash: "0x456",
    }, "ponder", "2.0.0");
    assert.equal(event.event_type, "burn");
    assert.equal(event.data.burned_zchf, 3000);
  });

  it("challenge_start event payload", () => {
    const event = buildEvent("challenge_start", {
      chain_id: 1, chain_name: "Ethereum", position: "0xpos",
      challenger: "0xch", size: 100, liquidation_price_zchf: 950,
    }, "ponder", "2.0.0");
    assert.equal(event.event_type, "challenge_start");
    assert.equal(event.data.position, "0xpos");
  });

  it("challenge_bid event payload", () => {
    const event = buildEvent("challenge_bid", {
      chain_id: 1, position: "0xpos", bidder: "0xbid",
      bid_amount_zchf: 500,
    }, "ponder", "2.0.0");
    assert.equal(event.event_type, "challenge_bid");
  });

  it("challenge_end event payload", () => {
    const event = buildEvent("challenge_end", {
      chain_id: 1, position: "0xpos", outcome: "success",
      collateral_acquired: 10, amount_zchf: 9500,
    }, "ponder", "2.0.0");
    assert.equal(event.event_type, "challenge_end");
    assert.equal(event.data.outcome, "success");
  });

  it("depeg event payload", () => {
    const event = buildEvent("depeg", {
      price_chf: 0.98, deviation_percent: 2.0,
      direction: "below", threshold_percent: 0.5,
    }, "coingecko", "2.0.0");
    assert.equal(event.event_type, "depeg");
    assert.equal(event.data.direction, "below");
  });

  it("depeg_resolved event payload", () => {
    const event = buildEvent("depeg_resolved", {
      price_chf: 1.001, deviation_percent: 0.1,
      resolved_from: "below", threshold_percent: 0.3,
    }, "coingecko", "2.0.0");
    assert.equal(event.event_type, "depeg_resolved");
  });

  it("fps_large_trade event payload", () => {
    const event = buildEvent("fps_large_trade", {
      kind: "buy", trader: "0xtrader",
      shares_traded: 10, price_chf: 50, amount_zchf: 5000,
    }, "ponder", "2.0.0");
    assert.equal(event.event_type, "fps_large_trade");
    assert.equal(event.data.kind, "buy");
  });

  it("minter_proposed event payload", () => {
    const event = buildEvent("minter_proposed", {
      chain_id: 1, minter_address: "0xminter", suggestor: "0xsug",
      application_fee_zchf: 100, apply_message: "test",
    }, "ponder", "2.0.0");
    assert.equal(event.event_type, "minter_proposed");
  });

  it("minter_approved event payload", () => {
    const event = buildEvent("minter_approved", {
      chain_id: 1, minter_address: "0xminter", suggestor: "0xsug",
    }, "ponder", "2.0.0");
    assert.equal(event.event_type, "minter_approved");
  });

  it("rate_change event payload", () => {
    const event = buildEvent("rate_change", {
      chain_id: 1, module: "0xmod",
      old_rate_percent: 3.5, new_rate_percent: 4.0,
    }, "ponder", "2.0.0");
    assert.equal(event.event_type, "rate_change");
  });

  it("supply_change event payload", () => {
    const event = buildEvent("supply_change", {
      chain_id: 1, chain_name: "Ethereum",
      old_supply: 100000, new_supply: 120000,
      change_amount: 20000, change_percent: 20.0,
    }, "api", "2.0.0");
    assert.equal(event.event_type, "supply_change");
    assert.equal(event.data.change_amount, 20000);
  });

  it("large_transfer event payload", () => {
    const event = buildEvent("large_transfer", {
      amount_zchf: 50000, from: "0xfrom", to: "0xto",
    }, "ponder", "2.0.0");
    assert.equal(event.event_type, "large_transfer");
  });
});

// ─── matchesFilters ───────────────────────────────────────────────────────────

describe("matchesFilters", () => {
  it("should match when no filters are specified", () => {
    assert.ok(matchesFilters("mint", { minted_zchf: 100 }, null));
    assert.ok(matchesFilters("mint", { minted_zchf: 100 }, {}));
  });

  // min_amount filter
  it("should filter by min_amount for mint events", () => {
    assert.ok(matchesFilters("mint", { minted_zchf: 5000 }, { min_amount: 1000 }));
    assert.ok(!matchesFilters("mint", { minted_zchf: 500 }, { min_amount: 1000 }));
  });

  it("should filter by min_amount for burn events", () => {
    assert.ok(matchesFilters("burn", { burned_zchf: 2000 }, { min_amount: 1000 }));
    assert.ok(!matchesFilters("burn", { burned_zchf: 500 }, { min_amount: 1000 }));
  });

  it("should filter by min_amount for fps_large_trade", () => {
    assert.ok(matchesFilters("fps_large_trade", { amount_zchf: 5000 }, { min_amount: 1000 }));
    assert.ok(!matchesFilters("fps_large_trade", { amount_zchf: 500 }, { min_amount: 1000 }));
  });

  it("should filter by min_amount for supply_change", () => {
    assert.ok(matchesFilters("supply_change", { change_amount: 20000 }, { min_amount: 10000 }));
    assert.ok(!matchesFilters("supply_change", { change_amount: 5000 }, { min_amount: 10000 }));
  });

  it("should ignore min_amount for event types where it doesn't apply", () => {
    // depeg doesn't have min_amount applicability
    assert.ok(matchesFilters("depeg", { price_chf: 0.98 }, { min_amount: 999999 }));
  });

  // chain_id filter
  it("should filter by chain_id", () => {
    assert.ok(matchesFilters("mint", { chain_id: 1, minted_zchf: 100 }, { chain_id: 1 }));
    assert.ok(!matchesFilters("mint", { chain_id: 8453, minted_zchf: 100 }, { chain_id: 1 }));
  });

  it("should pass chain_id filter when event has no chain_id", () => {
    // If event data doesn't have chain_id, filter passes (no data to reject on)
    assert.ok(matchesFilters("mint", { minted_zchf: 100 }, { chain_id: 1 }));
  });

  it("should ignore chain_id for event types where it doesn't apply", () => {
    assert.ok(matchesFilters("depeg", { chain_id: 999 }, { chain_id: 1 }));
  });

  // address filter
  it("should filter by address for mint events (position/owner)", () => {
    assert.ok(matchesFilters("mint", { position: "0xABC", owner: "0xDEF" }, { address: "0xabc" }));
    assert.ok(matchesFilters("mint", { position: "0xABC", owner: "0xDEF" }, { address: "0xdef" }));
    assert.ok(!matchesFilters("mint", { position: "0xABC", owner: "0xDEF" }, { address: "0x999" }));
  });

  it("should filter by address for challenge_start (position/challenger)", () => {
    assert.ok(matchesFilters("challenge_start", { position: "0xpos", challenger: "0xch" }, { address: "0xpos" }));
    assert.ok(!matchesFilters("challenge_start", { position: "0xpos", challenger: "0xch" }, { address: "0xother" }));
  });

  it("should filter by address case-insensitively", () => {
    assert.ok(matchesFilters("mint", { position: "0xAbCdEf" }, { address: "0xABCDEF" }));
  });

  it("should pass address filter when event has no matching address fields", () => {
    // fps_large_trade uses 'trader' — if trader is absent, addresses = empty → passes
    assert.ok(matchesFilters("fps_large_trade", { amount_zchf: 5000 }, { address: "0xabc" }));
  });

  it("should ignore address filter for event types where it doesn't apply", () => {
    assert.ok(matchesFilters("depeg", { position: "0xwrong" }, { address: "0xabc" }));
    assert.ok(matchesFilters("supply_change", {}, { address: "0xabc" }));
  });
});

// ─── FILTER_APPLICABILITY ─────────────────────────────────────────────────────

describe("FILTER_APPLICABILITY", () => {
  it("min_amount should apply to 5 event types", () => {
    const expected = ["mint", "burn", "large_transfer", "fps_large_trade", "supply_change"];
    for (const type of expected) {
      assert.ok(FILTER_APPLICABILITY.min_amount.has(type), `min_amount should apply to ${type}`);
    }
    assert.equal(FILTER_APPLICABILITY.min_amount.size, 5);
  });

  it("chain_id should apply to most event types except depeg/depeg_resolved/large_transfer", () => {
    assert.ok(!FILTER_APPLICABILITY.chain_id.has("depeg"));
    assert.ok(!FILTER_APPLICABILITY.chain_id.has("depeg_resolved"));
    assert.ok(FILTER_APPLICABILITY.chain_id.has("mint"));
    assert.ok(FILTER_APPLICABILITY.chain_id.has("challenge_start"));
  });

  it("address should apply to position-related event types", () => {
    assert.ok(FILTER_APPLICABILITY.address.has("mint"));
    assert.ok(FILTER_APPLICABILITY.address.has("challenge_start"));
    assert.ok(!FILTER_APPLICABILITY.address.has("depeg"));
    assert.ok(!FILTER_APPLICABILITY.address.has("supply_change"));
  });
});

// ─── getEventTypeSchemas ──────────────────────────────────────────────────────

describe("getEventTypeSchemas", () => {
  it("should return an array of 13 schemas", () => {
    const schemas = getEventTypeSchemas();
    assert.equal(schemas.length, 18);
  });

  it("each schema should have event_type, applicable_filters, default_threshold", () => {
    const schemas = getEventTypeSchemas();
    for (const schema of schemas) {
      assert.ok("event_type" in schema);
      assert.ok("applicable_filters" in schema);
      assert.ok("default_threshold" in schema);
      assert.ok("min_amount" in schema.applicable_filters);
      assert.ok("chain_id" in schema.applicable_filters);
      assert.ok("address" in schema.applicable_filters);
    }
  });

  it("should have correct default thresholds", () => {
    const schemas = getEventTypeSchemas();
    const mintSchema = schemas.find((s) => s.event_type === "mint");
    assert.equal(mintSchema.default_threshold, 0);
    const fpsSchema = schemas.find((s) => s.event_type === "fps_large_trade");
    assert.equal(fpsSchema.default_threshold, 1000);
    const supplySchema = schemas.find((s) => s.event_type === "supply_change");
    assert.equal(supplySchema.default_threshold, 10000);
    const depegSchema = schemas.find((s) => s.event_type === "depeg");
    assert.equal(depegSchema.default_threshold, null);
  });
});
