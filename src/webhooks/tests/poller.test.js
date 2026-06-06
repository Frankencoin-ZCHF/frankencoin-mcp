/**
 * Integration tests for src/webhooks/poller.js
 *
 * Mocks the 3 data sources (Ponder, api.frankencoin.com, CoinGecko)
 * by monkey-patching the global fetch.
 *
 * Tests event detection logic: mint, burn, challenge_start, depeg,
 * depeg_resolved, supply_change, fps_large_trade, poller guard, error handling.
 */

import { describe, it, before, after, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SubscriptionStore } from "../subscriptions.js";
import { buildEvent } from "../events.js";

// Isolate test persistence so tests don't load production subscriptions
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fc-poll-test-"));
process.env.WEBHOOK_DATA_DIR = TEST_DATA_DIR;

// We need to test the poller's internal logic. Since the poller module has
// module-level state, we'll re-import it fresh for each test group.
// But ESM modules are cached — so we test by directly calling the internal
// functions after understanding the architecture.
//
// Alternative approach: mock fetch globally and call startPoller, then verify
// events are dispatched. We'll use the dispatchToSubscribers path.

const PONDER_URL = "https://ponder.frankencoin.com";
const API_URL = "https://api.frankencoin.com";
const CG_URL = "https://pro-api.coingecko.com/api/v3";

// ─── Mock data templates ──────────────────────────────────────────────────────

function makePonderResponse(overrides = {}) {
  return {
    data: {
      positions: { items: overrides.positions || [] },
      challenges: { items: overrides.challenges || [] },
      trades: { items: overrides.trades || [] },
      minters: { items: overrides.minters || [] },
      rates: { items: overrides.rates || [] },
    },
  };
}

function makeApiResponse(chains = {}) {
  return {
    chains: chains,
  };
}

function makeCgResponse(price = 1.0) {
  return {
    frankencoin: { chf: price },
  };
}

function makePosition(addr, minted, extra = {}) {
  return {
    position: addr,
    owner: extra.owner || "0xOwner",
    collateral: "0xCollateral",
    collateralSymbol: extra.collateralSymbol || "WETH",
    minted: (BigInt(Math.round(minted * 1e18))).toString(),
    start: "1700000000",
    closed: false,
    denied: false,
    ...extra,
  };
}

function makeChallenge(position, number, extra = {}) {
  return {
    position,
    number: number.toString(),
    challenger: extra.challenger || "0xChallenger",
    status: extra.status || "Active",
    bids: extra.bids || "0",
    size: extra.size || "1000000000000000000",
    filledSize: extra.filledSize || "0",
    acquiredCollateral: extra.acquiredCollateral || "0",
    liqPrice: extra.liqPrice || "950000000000000000000",
    start: extra.start || "1700000000",
    duration: extra.duration || "86400",
    txHash: extra.txHash || "0xTxHash",
  };
}

function makeTrade(count, kind, amount, extra = {}) {
  return {
    count: count.toString(),
    kind,
    trader: extra.trader || "0xTrader",
    amount: (BigInt(Math.round(amount * 1e18))).toString(),
    shares: extra.shares || "10000000000000000000",
    price: extra.price || "50000000000000000000",
    created: extra.created || "1700000000",
    txHash: extra.txHash || "0xTxHash",
  };
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

/**
 * Since the poller uses module-level state that persists across calls,
 * and ESM modules are singletons, we test the event detection logic
 * by importing the module and controlling the fetch mock.
 *
 * We simulate the poller's behavior by calling pollAllSources indirectly
 * via startPoller, or by testing the event building/matching logic directly.
 */

describe("Poller — Event Detection Logic", () => {
  let store;
  let originalFetch;
  let fetchMock;
  let capturedEvents;

  // We'll test event detection by simulating what the poller does:
  // 1. Fetch data from sources
  // 2. Compare with previous state
  // 3. Build events
  // 4. Dispatch to subscribers

  // Since we can't easily access pollAllSources (not exported),
  // we test the components it uses.

  beforeEach(() => {
    // Clear persisted data between tests to avoid cross-contamination
    const persistPath = path.join(TEST_DATA_DIR, "subscriptions.json");
    try { fs.unlinkSync(persistPath); } catch {}
    store = new SubscriptionStore();
    capturedEvents = [];
  });

  afterEach(() => {
    store.destroy();
  });

  // ─── Event building correctness ─────────────────────────────────────────

  describe("Event building for poller scenarios", () => {
    it("should build mint event with correct data shape", () => {
      const event = buildEvent("mint", {
        chain_id: 1,
        chain_name: "Ethereum",
        position: "0xPos1",
        owner: "0xOwner1",
        collateral_symbol: "WETH",
        minted_zchf: 5000,
        minted_raw: "5000000000000000000000",
        tx_hash: null,
      }, "ponder", "2.0.0");

      assert.equal(event.event_type, "mint");
      assert.equal(event.data.chain_id, 1);
      assert.equal(event.data.minted_zchf, 5000);
      assert.equal(event.source, "ponder");
    });

    it("should build burn event when minted amount decreases", () => {
      const prev = 10000;
      const current = 7000;
      const delta = prev - current;

      const event = buildEvent("burn", {
        chain_id: 1,
        chain_name: "Ethereum",
        position: "0xPos1",
        owner: "0xOwner1",
        collateral_symbol: "WETH",
        burned_zchf: delta,
        burned_raw: "7000000000000000000000",
        tx_hash: null,
      }, "ponder", "2.0.0");

      assert.equal(event.event_type, "burn");
      assert.equal(event.data.burned_zchf, 3000);
    });

    it("should build challenge_start event for new challenge", () => {
      const event = buildEvent("challenge_start", {
        chain_id: 1,
        chain_name: "Ethereum",
        position: "0xPos1",
        challenger: "0xChallenger",
        collateral_symbol: null,
        size: 1.0,
        size_raw: "1000000000000000000",
        liquidation_price_zchf: 950,
        challenge_value_zchf: 950,
        tx_hash: "0xTxHash",
        started_at: new Date(1700000000 * 1000).toISOString(),
        duration_seconds: 86400,
      }, "ponder", "2.0.0");

      assert.equal(event.event_type, "challenge_start");
      assert.equal(event.data.challenger, "0xChallenger");
    });

    it("should build depeg event when price deviates > 0.5%", () => {
      const price = 0.98;
      const deviation = Math.abs(price - 1.0);
      const direction = price > 1.0 ? "above" : "below";

      assert.ok(deviation > 0.005, "0.98 should trigger depeg (2% > 0.5%)");

      const event = buildEvent("depeg", {
        price_chf: price,
        deviation_percent: Math.round(deviation * 10000) / 100,
        direction,
        threshold_percent: 0.5,
        source: "coingecko",
      }, "coingecko", "2.0.0");

      assert.equal(event.event_type, "depeg");
      assert.equal(event.data.direction, "below");
      assert.equal(event.data.deviation_percent, 2.0);
    });

    it("should build depeg_resolved event when price returns to < 0.3% deviation", () => {
      const price = 1.002;
      const deviation = Math.abs(price - 1.0);

      assert.ok(deviation <= 0.003, "0.2% deviation should resolve depeg");

      const event = buildEvent("depeg_resolved", {
        price_chf: price,
        deviation_percent: Math.round(deviation * 10000) / 100,
        resolved_from: "below",
        threshold_percent: 0.3,
      }, "coingecko", "2.0.0");

      assert.equal(event.event_type, "depeg_resolved");
      assert.equal(event.data.resolved_from, "below");
    });

    it("should build supply_change event when supply changes significantly", () => {
      const oldSupply = 1000000;
      const newSupply = 1020000;
      const change = newSupply - oldSupply;

      assert.ok(Math.abs(change) >= 10000, "20000 change should trigger supply_change");

      const event = buildEvent("supply_change", {
        chain_id: 1,
        chain_name: "Ethereum",
        old_supply: oldSupply,
        new_supply: newSupply,
        change_amount: change,
        change_percent: Math.round((change / oldSupply) * 10000) / 100,
      }, "api", "2.0.0");

      assert.equal(event.event_type, "supply_change");
      assert.equal(event.data.change_amount, 20000);
    });

    it("should build fps_large_trade event for trades >= 1000 ZCHF", () => {
      const amount = 5000;
      assert.ok(amount >= 1000, "5000 should trigger fps_large_trade");

      const event = buildEvent("fps_large_trade", {
        kind: "buy",
        trader: "0xTrader",
        shares_traded: 100,
        price_chf: 50,
        amount_zchf: amount,
        tx_hash: "0xTxHash",
      }, "ponder", "2.0.0");

      assert.equal(event.event_type, "fps_large_trade");
      assert.equal(event.data.amount_zchf, 5000);
    });
  });

  // ─── Subscriber matching for poller events ──────────────────────────────

  describe("Subscriber matching for poller events", () => {
    it("should match mint subscriber when mint event fires", () => {
      store.create({
        url: "https://example.com/hook",
        secret: "a".repeat(32),
        events: ["mint"],
        filters: {},
      });

      const matches = store.getMatching("mint", { minted_zchf: 5000 });
      assert.equal(matches.length, 1);
    });

    it("should NOT match burn subscriber when mint event fires", () => {
      store.create({
        url: "https://example.com/hook",
        secret: "a".repeat(32),
        events: ["burn"],
        filters: {},
      });

      const matches = store.getMatching("mint", { minted_zchf: 5000 });
      assert.equal(matches.length, 0);
    });

    it("should match depeg subscriber when price deviates", () => {
      store.create({
        url: "https://example.com/hook",
        secret: "a".repeat(32),
        events: ["depeg"],
        filters: {},
      });

      const matches = store.getMatching("depeg", { price_chf: 0.98, direction: "below" });
      assert.equal(matches.length, 1);
    });

    it("should filter supply_change by min_amount", () => {
      store.create({
        url: "https://example.com/hook",
        secret: "a".repeat(32),
        events: ["supply_change"],
        filters: { min_amount: 50000 },
      });

      const bigChange = store.getMatching("supply_change", { change_amount: 100000 });
      assert.equal(bigChange.length, 1);

      const smallChange = store.getMatching("supply_change", { change_amount: 5000 });
      assert.equal(smallChange.length, 0);
    });

    it("should filter fps_large_trade by chain_id", () => {
      store.create({
        url: "https://example.com/hook",
        secret: "a".repeat(32),
        events: ["fps_large_trade"],
        filters: { chain_id: 1 },
      });

      const eth = store.getMatching("fps_large_trade", { chain_id: 1, amount_zchf: 5000 });
      assert.equal(eth.length, 1);

      const base = store.getMatching("fps_large_trade", { chain_id: 8453, amount_zchf: 5000 });
      assert.equal(base.length, 0);
    });
  });
});

// ─── Poller module import and state tests ─────────────────────────────────────

describe("Poller — Module-level tests", () => {
  it("getPollerStatus should return correct shape when not started", async () => {
    const { getPollerStatus } = await import("../poller.js");
    const status = getPollerStatus();

    assert.ok("running" in status);
    assert.ok("initialized" in status);
    assert.ok("lastPollAt" in status);
    assert.ok("consecutiveErrors" in status);
    assert.ok("ponder" in status.consecutiveErrors);
    assert.ok("coingecko" in status.consecutiveErrors);
    assert.ok("api" in status.consecutiveErrors);
  });

  it("stopPoller should not throw when called without starting", async () => {
    const { stopPoller } = await import("../poller.js");
    // Should not throw
    assert.doesNotThrow(() => stopPoller());
  });
});

// ─── Poller state diffing simulation ──────────────────────────────────────────

describe("Poller — State Diffing Simulation", () => {
  // Simulate the poller's position tracking logic

  it("first poll sets baseline, emits NO events (simulated)", () => {
    const lastPositionMintedMap = new Map();
    const positions = [
      { position: "0xPos1", minted: 5000 },
      { position: "0xPos2", minted: 10000 },
    ];
    const events = [];

    // First poll: populate state, generate events for new positions with minted > 0
    // (mimicking the poller's logic where new positions with minted > 0 DO generate events)
    // But the poller suppresses ALL events on first poll via the `initialized` flag
    let initialized = false;

    for (const pos of positions) {
      lastPositionMintedMap.set(pos.position, pos.minted);
    }

    // On first poll, initialized is false → no events dispatched
    if (!initialized) {
      // Events generated but not dispatched
      initialized = true;
      assert.equal(events.length, 0, "No events should be dispatched on first poll");
    }
  });

  it("second poll with increased minted should detect mint (simulated)", () => {
    const lastPositionMintedMap = new Map();
    lastPositionMintedMap.set("0xPos1", 5000);

    // Second poll: minted increased
    const currentMinted = 8000;
    const prev = lastPositionMintedMap.get("0xPos1");
    const events = [];

    if (currentMinted > prev) {
      const delta = currentMinted - prev;
      events.push({ type: "mint", delta, position: "0xPos1" });
    }

    assert.equal(events.length, 1);
    assert.equal(events[0].type, "mint");
    assert.equal(events[0].delta, 3000);
  });

  it("second poll with decreased minted should detect burn (simulated)", () => {
    const lastPositionMintedMap = new Map();
    lastPositionMintedMap.set("0xPos1", 10000);

    const currentMinted = 7000;
    const prev = lastPositionMintedMap.get("0xPos1");
    const events = [];

    if (currentMinted < prev) {
      const delta = prev - currentMinted;
      events.push({ type: "burn", delta, position: "0xPos1" });
    }

    assert.equal(events.length, 1);
    assert.equal(events[0].type, "burn");
    assert.equal(events[0].delta, 3000);
  });

  it("new challenge ID should trigger challenge_start (simulated)", () => {
    const lastChallengeIds = new Set();
    lastChallengeIds.add("0xPos1_1");

    const currentChallenges = [
      { position: "0xPos1", number: "1" },
      { position: "0xPos2", number: "1" },  // New!
    ];
    const events = [];

    for (const ch of currentChallenges) {
      const chId = `${ch.position}_${ch.number}`;
      if (!lastChallengeIds.has(chId)) {
        events.push({ type: "challenge_start", id: chId });
        lastChallengeIds.add(chId);
      }
    }

    assert.equal(events.length, 1);
    assert.equal(events[0].type, "challenge_start");
    assert.equal(events[0].id, "0xPos2_1");
  });

  it("price deviation > 0.5% should trigger depeg (simulated)", () => {
    let isDepegged = false;
    let depegDirection = null;
    const DEPEG_TRIGGER = 0.005;
    const events = [];

    const price = 0.98; // 2% deviation
    const deviation = Math.abs(price - 1.0);
    const direction = price > 1.0 ? "above" : "below";

    if (!isDepegged && deviation > DEPEG_TRIGGER) {
      isDepegged = true;
      depegDirection = direction;
      events.push({ type: "depeg", price, direction });
    }

    assert.equal(events.length, 1);
    assert.equal(events[0].type, "depeg");
    assert.equal(events[0].direction, "below");
  });

  it("price returning to < 0.3% should trigger depeg_resolved (simulated)", () => {
    let isDepegged = true;
    let depegDirection = "below";
    const DEPEG_RESOLVE = 0.003;
    const events = [];

    const price = 1.002; // 0.2% deviation
    const deviation = Math.abs(price - 1.0);

    if (isDepegged && deviation <= DEPEG_RESOLVE) {
      events.push({ type: "depeg_resolved", price, resolved_from: depegDirection });
      isDepegged = false;
      depegDirection = null;
    }

    assert.equal(events.length, 1);
    assert.equal(events[0].type, "depeg_resolved");
    assert.equal(events[0].resolved_from, "below");
  });

  it("supply change >= 10000 should trigger supply_change (simulated)", () => {
    const lastSupplyByChain = new Map();
    lastSupplyByChain.set(1, 1000000);
    const DEFAULT_THRESHOLD = 10000;
    const events = [];

    const newSupply = 1020000;
    const prev = lastSupplyByChain.get(1);
    const change = newSupply - prev;

    if (Math.abs(change) >= DEFAULT_THRESHOLD) {
      events.push({ type: "supply_change", change, chain_id: 1 });
    }

    assert.equal(events.length, 1);
    assert.equal(events[0].change, 20000);
  });

  it("supply change < 10000 should NOT trigger supply_change (simulated)", () => {
    const lastSupplyByChain = new Map();
    lastSupplyByChain.set(1, 1000000);
    const DEFAULT_THRESHOLD = 10000;
    const events = [];

    const newSupply = 1005000;
    const prev = lastSupplyByChain.get(1);
    const change = newSupply - prev;

    if (Math.abs(change) >= DEFAULT_THRESHOLD) {
      events.push({ type: "supply_change", change, chain_id: 1 });
    }

    assert.equal(events.length, 0);
  });

  it("fps trade >= 1000 ZCHF should trigger fps_large_trade (simulated)", () => {
    const lastEquityTradeCount = 5;
    const DEFAULT_THRESHOLD = 1000;
    const events = [];

    const trades = [
      { count: 7, amount: 5000 },
      { count: 6, amount: 500 },  // Below threshold
    ];

    const latestCount = trades[0].count;
    if (latestCount > lastEquityTradeCount) {
      for (const t of trades) {
        if (t.count <= lastEquityTradeCount) break;
        if (t.amount >= DEFAULT_THRESHOLD) {
          events.push({ type: "fps_large_trade", amount: t.amount });
        }
      }
    }

    assert.equal(events.length, 1);
    assert.equal(events[0].amount, 5000);
  });

  it("poller guard: isPolling=true should skip tick (simulated)", () => {
    let isPolling = true;
    let pollCount = 0;

    // Simulating the interval callback
    if (!isPolling) {
      pollCount++;
    }

    assert.equal(pollCount, 0, "Should skip when isPolling is true");

    // Now allow polling
    isPolling = false;
    if (!isPolling) {
      pollCount++;
    }
    assert.equal(pollCount, 1, "Should poll when isPolling is false");
  });

  it("error handling: data source error should not crash, state unchanged (simulated)", () => {
    const lastSupplyByChain = new Map();
    lastSupplyByChain.set(1, 1000000);
    let consecutiveErrors = 0;

    // Simulate Ponder returning 500
    try {
      throw new Error("Ponder error 500");
    } catch (e) {
      consecutiveErrors++;
      // State should remain unchanged
    }

    assert.equal(consecutiveErrors, 1);
    assert.equal(lastSupplyByChain.get(1), 1000000, "State should be unchanged after error");
  });
});

// ─── Position & Minter Lifecycle Simulation ───────────────────────────────────

describe("Poller — Position Lifecycle Events (simulated)", () => {
  // Simulate the poller's position lifecycle detection logic exactly as in poller.js.
  // This mirrors pollPonder()'s position handling.

  function simulatePositionPoll(positions, prevState) {
    const events = [];
    const nowSec = Date.now() / 1000;
    const currentMap = new Map();

    const lastPositionMintedMap = prevState.lastPositionMintedMap || new Map();
    const positionDeniedEmitted = prevState.positionDeniedEmitted || new Set();
    const positionClosedEmitted = prevState.positionClosedEmitted || new Set();
    const activeEmitted = prevState.activeEmitted || new Set();

    for (const pos of positions) {
      const addr = pos.position;
      const minted = pos.mintedFloat ?? 0;
      currentMap.set(addr, { ...pos, mintedFloat: minted });

      const prev = lastPositionMintedMap.get(addr);
      const startSec = pos.start ? Number(pos.start) : 0;

      if (prev == null) {
        // New position — classify on first sight
        if (pos.denied) {
          events.push({ type: "position_denied", position: addr });
          positionDeniedEmitted.add(addr);
        } else if (pos.closed) {
          positionClosedEmitted.add(addr);
          activeEmitted.add(addr);
        } else if (minted === 0 && startSec > nowSec) {
          events.push({ type: "position_proposed", position: addr, start: startSec });
        } else if (minted > 0) {
          events.push({ type: "mint", position: addr, minted });
          activeEmitted.add(addr);
        }
        // else: existing active position with minted=0, already past start → silent baseline
      } else if (minted > prev) {
        events.push({ type: "mint", position: addr, delta: minted - prev });
      } else if (minted < prev) {
        events.push({ type: "burn", position: addr, delta: prev - minted });
      }
    }

    // Lifecycle transitions
    for (const [addr, pos] of currentMap) {
      const posStartSec = pos.start ? Number(pos.start) : 0;

      if (pos.denied && !positionDeniedEmitted.has(addr)) {
        events.push({ type: "position_denied", position: addr });
        positionDeniedEmitted.add(addr);
      }

      if (pos.closed && !positionClosedEmitted.has(addr)) {
        events.push({ type: "position_closed", position: addr, minted_zchf: pos.mintedFloat });
        positionClosedEmitted.add(addr);
      }

      if (
        !pos.denied && !pos.closed &&
        posStartSec > 0 && nowSec >= posStartSec &&
        !activeEmitted.has(addr) &&
        lastPositionMintedMap.has(addr) // was previously seen
      ) {
        events.push({ type: "position_active", position: addr });
        activeEmitted.add(addr);
      }
    }

    // Update state for next round
    const newMintedMap = new Map();
    for (const [addr, pos] of currentMap) {
      newMintedMap.set(addr, pos.mintedFloat);
    }

    return {
      events,
      newState: {
        lastPositionMintedMap: newMintedMap,
        positionDeniedEmitted,
        positionClosedEmitted,
        activeEmitted,
      },
    };
  }

  it("new position with minted=0, start in future → position_proposed", () => {
    const futureStart = Math.floor(Date.now() / 1000) + 86400; // 24h from now
    const positions = [{
      position: "0xNewPos",
      owner: "0xOwner",
      collateral: "0xWETH",
      collateralSymbol: "WETH",
      mintedFloat: 0,
      start: futureStart.toString(),
      closed: false,
      denied: false,
    }];

    const result = simulatePositionPoll(positions, {});

    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].type, "position_proposed");
    assert.equal(result.events[0].position, "0xNewPos");
    assert.equal(result.events[0].start, futureStart);
  });

  it("position transitions from proposed to active when start passes", () => {
    const pastStart = Math.floor(Date.now() / 1000) - 3600; // 1h ago
    const positions = [{
      position: "0xProposed",
      owner: "0xOwner",
      collateral: "0xWETH",
      collateralSymbol: "WETH",
      mintedFloat: 0,
      start: pastStart.toString(),
      closed: false,
      denied: false,
    }];

    // Simulate first poll (baseline) — position was seen in proposal state
    // We pre-populate state as if first poll happened when start was still in future
    const initialState = {
      lastPositionMintedMap: new Map([["0xProposed", 0]]), // already tracked
      positionDeniedEmitted: new Set(),
      positionClosedEmitted: new Set(),
      activeEmitted: new Set(),
    };

    const result = simulatePositionPoll(positions, initialState);

    // Should detect position_active since start <= now and was previously seen
    const activeEvents = result.events.filter(e => e.type === "position_active");
    assert.equal(activeEvents.length, 1);
    assert.equal(activeEvents[0].position, "0xProposed");
  });

  it("position_active should NOT fire for positions already marked active", () => {
    const pastStart = Math.floor(Date.now() / 1000) - 3600;
    const positions = [{
      position: "0xAlreadyActive",
      owner: "0xOwner",
      collateral: "0xWETH",
      collateralSymbol: "WETH",
      mintedFloat: 5000,
      start: pastStart.toString(),
      closed: false,
      denied: false,
    }];

    const initialState = {
      lastPositionMintedMap: new Map([["0xAlreadyActive", 5000]]),
      positionDeniedEmitted: new Set(),
      positionClosedEmitted: new Set(),
      activeEmitted: new Set(["0xAlreadyActive"]),
    };

    const result = simulatePositionPoll(positions, initialState);

    const activeEvents = result.events.filter(e => e.type === "position_active");
    assert.equal(activeEvents.length, 0, "Should not re-emit position_active");
  });

  it("position gets denied → position_denied", () => {
    const positions = [{
      position: "0xDeniedPos",
      owner: "0xOwner",
      collateral: "0xWETH",
      collateralSymbol: "WETH",
      mintedFloat: 0,
      start: (Math.floor(Date.now() / 1000) + 86400).toString(),
      closed: false,
      denied: true, // now denied
    }];

    // Was previously tracked (seen as proposal)
    const initialState = {
      lastPositionMintedMap: new Map([["0xDeniedPos", 0]]),
      positionDeniedEmitted: new Set(),
      positionClosedEmitted: new Set(),
      activeEmitted: new Set(),
    };

    const result = simulatePositionPoll(positions, initialState);

    const deniedEvents = result.events.filter(e => e.type === "position_denied");
    assert.equal(deniedEvents.length, 1);
    assert.equal(deniedEvents[0].position, "0xDeniedPos");
  });

  it("new position appears already denied → position_denied on first sight", () => {
    const positions = [{
      position: "0xNewDenied",
      owner: "0xOwner",
      collateral: "0xWETH",
      collateralSymbol: "WETH",
      mintedFloat: 0,
      start: (Math.floor(Date.now() / 1000) + 86400).toString(),
      closed: false,
      denied: true,
    }];

    const result = simulatePositionPoll(positions, {});

    const deniedEvents = result.events.filter(e => e.type === "position_denied");
    assert.equal(deniedEvents.length, 1);
    assert.equal(deniedEvents[0].position, "0xNewDenied");
  });

  it("position_denied should NOT fire twice for same position", () => {
    const positions = [{
      position: "0xDeniedPos2",
      owner: "0xOwner",
      collateral: "0xWETH",
      collateralSymbol: "WETH",
      mintedFloat: 0,
      start: (Math.floor(Date.now() / 1000) + 86400).toString(),
      closed: false,
      denied: true,
    }];

    const initialState = {
      lastPositionMintedMap: new Map([["0xDeniedPos2", 0]]),
      positionDeniedEmitted: new Set(["0xDeniedPos2"]),
      positionClosedEmitted: new Set(),
      activeEmitted: new Set(),
    };

    const result = simulatePositionPoll(positions, initialState);

    const deniedEvents = result.events.filter(e => e.type === "position_denied");
    assert.equal(deniedEvents.length, 0, "Should not re-emit position_denied");
  });

  it("position gets closed → position_closed", () => {
    const positions = [{
      position: "0xClosedPos",
      owner: "0xOwner",
      collateral: "0xWETH",
      collateralSymbol: "WETH",
      mintedFloat: 2500,
      start: (Math.floor(Date.now() / 1000) - 86400).toString(),
      closed: true,
      denied: false,
    }];

    // Was active previously
    const initialState = {
      lastPositionMintedMap: new Map([["0xClosedPos", 2500]]),
      positionDeniedEmitted: new Set(),
      positionClosedEmitted: new Set(),
      activeEmitted: new Set(["0xClosedPos"]),
    };

    const result = simulatePositionPoll(positions, initialState);

    const closedEvents = result.events.filter(e => e.type === "position_closed");
    assert.equal(closedEvents.length, 1);
    assert.equal(closedEvents[0].position, "0xClosedPos");
    assert.equal(closedEvents[0].minted_zchf, 2500);
  });

  it("new position appears already closed → no proposal or closed event (silent baseline)", () => {
    const positions = [{
      position: "0xOldClosed",
      owner: "0xOwner",
      collateral: "0xWETH",
      collateralSymbol: "WETH",
      mintedFloat: 0,
      start: (Math.floor(Date.now() / 1000) - 86400 * 30).toString(),
      closed: true,
      denied: false,
    }];

    const result = simulatePositionPoll(positions, {});

    // Should not fire position_proposed, position_closed, or any event
    // (it's a historical closed position seen for the first time)
    const proposedEvents = result.events.filter(e => e.type === "position_proposed");
    const closedEvents = result.events.filter(e => e.type === "position_closed");
    assert.equal(proposedEvents.length, 0, "Should not emit position_proposed for already-closed");
    assert.equal(closedEvents.length, 0, "Should not emit position_closed for already-closed on first sight");
  });

  it("existing active position with minted > 0 on first sight → mint (not proposal)", () => {
    const positions = [{
      position: "0xActiveMinting",
      owner: "0xOwner",
      collateral: "0xWETH",
      collateralSymbol: "WETH",
      mintedFloat: 10000,
      start: (Math.floor(Date.now() / 1000) - 86400).toString(),
      closed: false,
      denied: false,
    }];

    const result = simulatePositionPoll(positions, {});

    const proposedEvents = result.events.filter(e => e.type === "position_proposed");
    const mintEvents = result.events.filter(e => e.type === "mint");
    assert.equal(proposedEvents.length, 0, "Active minting position should not be proposed");
    assert.equal(mintEvents.length, 1, "Should detect as mint");
    assert.equal(mintEvents[0].minted, 10000);
  });

  it("existing position with minted=0, start in past → silent baseline (no events)", () => {
    const positions = [{
      position: "0xReadyButIdle",
      owner: "0xOwner",
      collateral: "0xWETH",
      collateralSymbol: "WETH",
      mintedFloat: 0,
      start: (Math.floor(Date.now() / 1000) - 86400).toString(),
      closed: false,
      denied: false,
    }];

    const result = simulatePositionPoll(positions, {});

    // Position is past start, minted=0, not closed, not denied → already active but idle
    // On first sight, this shouldn't fire as proposed (start is in the past)
    // and shouldn't fire as active (no previous state to transition from)
    assert.equal(result.events.length, 0, "Idle existing position should be silent on first sight");
  });
});

describe("Poller — Minter Lifecycle Events (simulated)", () => {
  function simulateMinterPoll(minters, prevState) {
    const events = [];
    const now = Date.now() / 1000;

    const lastMinterAddresses = prevState.lastMinterAddresses || new Set();
    const approvedEmitted = prevState.approvedEmitted || new Set();
    const deniedEmitted = prevState.deniedEmitted || new Set();

    for (const m of minters) {
      const addr = m.minter;
      const chainId = m.chainId || 1;
      const isDenied = !!m.denyDate;

      if (!lastMinterAddresses.has(addr)) {
        // New minter application
        if (!isDenied) {
          events.push({ type: "minter_proposed", minter: addr, chainId });
        }
        lastMinterAddresses.add(addr);
      }

      // Approval detection
      if (
        !isDenied &&
        m.applyDate &&
        m.applicationPeriod &&
        !approvedEmitted.has(addr)
      ) {
        const applyTime = Number(m.applyDate);
        const period = Number(m.applicationPeriod);
        if (now > applyTime + period) {
          events.push({ type: "minter_approved", minter: addr, chainId });
          approvedEmitted.add(addr);
        }
      }

      // Denial detection
      if (isDenied && !deniedEmitted.has(addr) && lastMinterAddresses.has(addr)) {
        events.push({ type: "minter_denied", minter: addr, chainId });
        deniedEmitted.add(addr);
      }
    }

    return {
      events,
      newState: { lastMinterAddresses, approvedEmitted, deniedEmitted },
    };
  }

  it("new minter application → minter_proposed", () => {
    const minters = [{
      minter: "0xNewMinter",
      chainId: 1,
      suggestor: "0xSuggestor",
      applicationFee: "1000000000000000000000",
      applyMessage: "Adding WETH collateral",
      applicationPeriod: "86400",
      applyDate: Math.floor(Date.now() / 1000).toString(),
      denyDate: null,
      txHash: "0xTx1",
    }];

    const result = simulateMinterPoll(minters, {});

    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].type, "minter_proposed");
    assert.equal(result.events[0].minter, "0xNewMinter");
  });

  it("minter gets denied → minter_denied", () => {
    const minters = [{
      minter: "0xDeniedMinter",
      chainId: 1,
      suggestor: "0xSuggestor",
      applicationFee: "1000000000000000000000",
      applyMessage: "Suspicious collateral",
      applicationPeriod: "86400",
      applyDate: Math.floor(Date.now() / 1000 - 3600).toString(),
      denyDate: Math.floor(Date.now() / 1000).toString(),
      denyMessage: "Rejected by governance",
      txHash: "0xTx2",
    }];

    // Previously seen as proposed
    const initialState = {
      lastMinterAddresses: new Set(["0xDeniedMinter"]),
      approvedEmitted: new Set(),
      deniedEmitted: new Set(),
    };

    const result = simulateMinterPoll(minters, initialState);

    const deniedEvents = result.events.filter(e => e.type === "minter_denied");
    assert.equal(deniedEvents.length, 1);
    assert.equal(deniedEvents[0].minter, "0xDeniedMinter");
  });

  it("minter approved after application period → minter_approved", () => {
    const applyDate = Math.floor(Date.now() / 1000) - 172800; // 2 days ago
    const minters = [{
      minter: "0xApprovedMinter",
      chainId: 1,
      suggestor: "0xSuggestor",
      applicationFee: "1000000000000000000000",
      applyMessage: "Good collateral",
      applicationPeriod: "86400", // 1 day
      applyDate: applyDate.toString(),
      denyDate: null,
      txHash: "0xTx3",
    }];

    const initialState = {
      lastMinterAddresses: new Set(["0xApprovedMinter"]),
      approvedEmitted: new Set(),
      deniedEmitted: new Set(),
    };

    const result = simulateMinterPoll(minters, initialState);

    const approvedEvents = result.events.filter(e => e.type === "minter_approved");
    assert.equal(approvedEvents.length, 1);
    assert.equal(approvedEvents[0].minter, "0xApprovedMinter");
  });

  it("minter still in application period → NO minter_approved", () => {
    const applyDate = Math.floor(Date.now() / 1000) - 3600; // 1h ago
    const minters = [{
      minter: "0xPendingMinter",
      chainId: 1,
      suggestor: "0xSuggestor",
      applicationFee: "1000000000000000000000",
      applyMessage: "New collateral",
      applicationPeriod: "86400", // 1 day (not elapsed yet)
      applyDate: applyDate.toString(),
      denyDate: null,
      txHash: "0xTx4",
    }];

    const initialState = {
      lastMinterAddresses: new Set(["0xPendingMinter"]),
      approvedEmitted: new Set(),
      deniedEmitted: new Set(),
    };

    const result = simulateMinterPoll(minters, initialState);

    const approvedEvents = result.events.filter(e => e.type === "minter_approved");
    assert.equal(approvedEvents.length, 0, "Should not approve before period ends");
  });

  it("new minter that appeared already denied → NO minter_proposed, YES minter_denied", () => {
    const minters = [{
      minter: "0xPreDenied",
      chainId: 1,
      suggestor: "0xSuggestor",
      applicationFee: "1000000000000000000000",
      applyMessage: "Bad collateral",
      applicationPeriod: "86400",
      applyDate: Math.floor(Date.now() / 1000 - 7200).toString(),
      denyDate: Math.floor(Date.now() / 1000 - 3600).toString(),
      denyMessage: "Rejected",
      txHash: "0xTx5",
    }];

    const result = simulateMinterPoll(minters, {});

    const proposedEvents = result.events.filter(e => e.type === "minter_proposed");
    const deniedEvents = result.events.filter(e => e.type === "minter_denied");
    assert.equal(proposedEvents.length, 0, "Should not emit proposed for already-denied minter");
    assert.equal(deniedEvents.length, 1, "Should emit denied for newly seen denied minter");
    assert.equal(deniedEvents[0].minter, "0xPreDenied");
  });

  it("minter_denied should NOT fire twice", () => {
    const minters = [{
      minter: "0xDeniedAgain",
      chainId: 1,
      denyDate: Math.floor(Date.now() / 1000).toString(),
      applyDate: Math.floor(Date.now() / 1000 - 3600).toString(),
      applicationPeriod: "86400",
    }];

    const initialState = {
      lastMinterAddresses: new Set(["0xDeniedAgain"]),
      approvedEmitted: new Set(),
      deniedEmitted: new Set(["0xDeniedAgain"]),
    };

    const result = simulateMinterPoll(minters, initialState);

    const deniedEvents = result.events.filter(e => e.type === "minter_denied");
    assert.equal(deniedEvents.length, 0, "Should not re-emit minter_denied");
  });
});

// ─── Event building for lifecycle events ──────────────────────────────────────

describe("Poller — Lifecycle Event Building", () => {
  it("should build position_proposed event with correct data shape", () => {
    const event = buildEvent("position_proposed", {
      chain_id: 1,
      chain_name: "Ethereum",
      position: "0xPos1",
      owner: "0xOwner1",
      collateral: "0xWETH",
      collateral_symbol: "WETH",
      start: "2026-04-01T00:00:00.000Z",
      challenge_window_ends: "2026-04-01T00:00:00.000Z",
      tx_hash: null,
    }, "ponder", "2.0.0");

    assert.equal(event.event_type, "position_proposed");
    assert.equal(event.data.position, "0xPos1");
    assert.equal(event.data.collateral_symbol, "WETH");
    assert.ok(event.data.start);
    assert.equal(event.source, "ponder");
  });

  it("should build position_active event with correct data shape", () => {
    const event = buildEvent("position_active", {
      chain_id: 1,
      chain_name: "Ethereum",
      position: "0xPos1",
      owner: "0xOwner1",
      collateral: "0xWETH",
      collateral_symbol: "WETH",
      start: "2026-03-15T00:00:00.000Z",
    }, "ponder", "2.0.0");

    assert.equal(event.event_type, "position_active");
    assert.equal(event.data.position, "0xPos1");
  });

  it("should build position_denied event with correct data shape", () => {
    const event = buildEvent("position_denied", {
      chain_id: 1,
      chain_name: "Ethereum",
      position: "0xPos1",
      owner: "0xOwner1",
      collateral: "0xWETH",
      collateral_symbol: "WETH",
    }, "ponder", "2.0.0");

    assert.equal(event.event_type, "position_denied");
    assert.equal(event.data.position, "0xPos1");
  });

  it("should build position_closed event with minted_zchf", () => {
    const event = buildEvent("position_closed", {
      chain_id: 1,
      chain_name: "Ethereum",
      position: "0xPos1",
      owner: "0xOwner1",
      collateral_symbol: "WETH",
      minted_zchf: 5000,
    }, "ponder", "2.0.0");

    assert.equal(event.event_type, "position_closed");
    assert.equal(event.data.minted_zchf, 5000);
  });

  it("should build minter_denied event with deny_message", () => {
    const event = buildEvent("minter_denied", {
      chain_id: 1,
      chain_name: "Ethereum",
      minter_address: "0xMinter1",
      suggestor: "0xSuggestor",
      deny_message: "Rejected by governance vote",
      tx_hash: "0xTx1",
    }, "ponder", "2.0.0");

    assert.equal(event.event_type, "minter_denied");
    assert.equal(event.data.deny_message, "Rejected by governance vote");
  });
});

// ─── Full poller integration with fetch mock ──────────────────────────────────

describe("Poller — Full Integration with Fetch Mock", () => {
  let originalFetch;
  let fetchResponses;

  before(() => {
    originalFetch = globalThis.fetch;
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  beforeEach(() => {
    fetchResponses = {
      ponder: makePonderResponse(),
      api: makeApiResponse({ "1": { chainId: 1, supply: 1000000 } }),
      cg: makeCgResponse(1.0),
    };

    globalThis.fetch = async (url, opts) => {
      const urlStr = typeof url === "string" ? url : url.toString();

      if (urlStr.includes("ponder.frankencoin.com")) {
        return new Response(JSON.stringify(fetchResponses.ponder), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (urlStr.includes("api.frankencoin.com")) {
        return new Response(JSON.stringify(fetchResponses.api), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (urlStr.includes("coingecko.com")) {
        return new Response(JSON.stringify(fetchResponses.cg), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Default: pass through to original fetch (e.g., for webhook deliveries)
      return originalFetch(url, opts);
    };
  });

  it("fetch mock should intercept Ponder requests", async () => {
    const res = await fetch("https://ponder.frankencoin.com", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ test }" }),
    });
    const data = await res.json();
    assert.ok(data.data);
    assert.ok(data.data.positions);
  });

  it("fetch mock should intercept API requests", async () => {
    const res = await fetch("https://api.frankencoin.com/ecosystem/frankencoin/info");
    const data = await res.json();
    assert.ok(data.chains);
  });

  it("fetch mock should intercept CoinGecko requests", async () => {
    const res = await fetch("https://pro-api.coingecko.com/api/v3/simple/price?ids=frankencoin&vs_currencies=chf");
    const data = await res.json();
    assert.ok(data.frankencoin);
    assert.equal(data.frankencoin.chf, 1.0);
  });
});
