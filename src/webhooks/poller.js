/**
 * 60-second interval poller: batched Ponder GraphQL + api.frankencoin.com + CoinGecko.
 * State diffing and event detection for all 13 event types.
 */

import { ponderQuery, apiFetch, cgFetch, fromWei, CHAIN_NAMES } from "../api/helpers.js";
import { buildEvent, DEFAULT_THRESHOLDS } from "./events.js";
import { dispatchToSubscribers } from "./delivery.js";

const POLL_INTERVAL = 60_000;
const DEPEG_TRIGGER = 0.005; // 0.5%
const DEPEG_RESOLVE = 0.003; // 0.3%

// ─── Poller State ─────────────────────────────────────────────────────────────

const state = {
  // Ponder cursor-based
  lastPositionMintedMap: new Map(),  // position_address → minted (float)
  lastChallengeIds: new Set(),
  lastChallengeStatusMap: new Map(), // challenge_id → status
  lastChallengeBidsMap: new Map(),   // challenge_id → bids count
  lastEquityTradeCount: null,
  lastMinterAddresses: new Set(),
  lastMinterDeniedMap: new Map(),    // address → isDenied
  approvedEmitted: new Set(),        // minters already emitted as approved
  lastRateMap: new Map(),            // chainId:module → approvedRate
  lastRateCreated: null,

  // API-based
  lastSupplyByChain: new Map(),      // chain_id → supply (float)
  lastTotalSupply: null,

  // CoinGecko-based
  lastZchfPriceChf: null,
  isDepegged: false,
  depegDirection: null,

  // Bookkeeping
  initialized: false,
  lastPollAt: null,
  consecutivePonderErrors: 0,
  consecutiveCgErrors: 0,
  consecutiveApiErrors: 0,
};

let pollTimer = null;
let isPolling = false;
let shutdownRequested = false;
let store = null;
let serverVersion = "2.0.0";

// ─── Public API ───────────────────────────────────────────────────────────────

export function startPoller(subscriptionStore, version = "2.0.0") {
  store = subscriptionStore;
  serverVersion = version;

  console.error("[poller] Starting event poller (60s interval)");

  // First poll immediately (baseline)
  pollAllSources().catch((e) => console.error("[poller] Initial poll error:", e.message));

  pollTimer = setInterval(async () => {
    if (isPolling || shutdownRequested) return;
    isPolling = true;
    try {
      await pollAllSources();
    } catch (e) {
      console.error("[poller] Error:", e.message);
    } finally {
      isPolling = false;
    }
  }, POLL_INTERVAL);
}

export function stopPoller() {
  shutdownRequested = true;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  console.error("[poller] Stopped");
}

export function getPollerStatus() {
  return {
    running: pollTimer !== null,
    initialized: state.initialized,
    lastPollAt: state.lastPollAt,
    consecutiveErrors: {
      ponder: state.consecutivePonderErrors,
      coingecko: state.consecutiveCgErrors,
      api: state.consecutiveApiErrors,
    },
  };
}

// ─── Core poll logic ──────────────────────────────────────────────────────────

async function pollAllSources() {
  const events = [];

  // 3 parallel fetch batches
  const [ponderResult, apiResult, cgResult] = await Promise.allSettled([
    pollPonder(),
    pollApi(),
    pollCoinGecko(),
  ]);

  // Process Ponder results
  if (ponderResult.status === "fulfilled" && ponderResult.value) {
    events.push(...ponderResult.value);
    state.consecutivePonderErrors = 0;
  } else if (ponderResult.status === "rejected") {
    state.consecutivePonderErrors++;
    const level = state.consecutivePonderErrors >= 5 ? "warn" : "error";
    console.error(
      `[poller] Ponder error (${state.consecutivePonderErrors} consecutive): ${ponderResult.reason?.message || "unknown"}`
    );
  }

  // Process API results
  if (apiResult.status === "fulfilled" && apiResult.value) {
    events.push(...apiResult.value);
    state.consecutiveApiErrors = 0;
  } else if (apiResult.status === "rejected") {
    state.consecutiveApiErrors++;
    console.error(
      `[poller] API error (${state.consecutiveApiErrors} consecutive): ${apiResult.reason?.message || "unknown"}`
    );
  }

  // Process CoinGecko results
  if (cgResult.status === "fulfilled" && cgResult.value) {
    events.push(...cgResult.value);
    state.consecutiveCgErrors = 0;
  } else if (cgResult.status === "rejected") {
    state.consecutiveCgErrors++;
    console.error(
      `[poller] CoinGecko error (${state.consecutiveCgErrors} consecutive): ${cgResult.reason?.message || "unknown"}`
    );
  }

  state.lastPollAt = Date.now();

  // First poll = baseline only (no events dispatched)
  if (!state.initialized) {
    state.initialized = true;
    console.error(`[poller] Baseline established — ${events.length} state items captured, no events emitted`);
    return;
  }

  // Dispatch events to subscribers
  if (events.length > 0) {
    console.error(`[poller] Detected ${events.length} event(s)`);
    for (const event of events) {
      if (shutdownRequested) break;
      dispatchToSubscribers(store, event);
    }
  }
}

// ─── Batch 1: Ponder GraphQL ──────────────────────────────────────────────────

const PONDER_QUERY = `{
  positions: mintingHubV2PositionV2s(limit: 100, orderBy: "start", orderDirection: "desc") {
    items { position owner collateral collateralSymbol minted start closed denied }
  }
  challenges: mintingHubV2ChallengeV2s(limit: 50, orderBy: "start", orderDirection: "desc") {
    items { position number challenger status bids size filledSize acquiredCollateral liqPrice start duration txHash }
  }
  trades: equityTrades(limit: 20, orderBy: "created", orderDirection: "desc") {
    items { count kind trader amount shares price created txHash }
  }
  minters: frankencoinMinters(limit: 50) {
    items { chainId minter applicationPeriod applicationFee applyMessage applyDate suggestor denyMessage denyDate txHash }
  }
  rates: leadrateRateChangeds(limit: 20, orderBy: "created", orderDirection: "desc") {
    items { chainId module approvedRate created txHash }
  }
}`;

async function pollPonder() {
  const data = await ponderQuery(PONDER_QUERY);
  const events = [];

  // ── Positions: detect mint/burn ─────────────────────────────────────────
  // Note: Ponder v2 positions don't have chainId — they're Ethereum mainnet (chain 1)
  if (data.positions?.items) {
    const currentMap = new Map();
    for (const pos of data.positions.items) {
      const addr = pos.position;
      const minted = fromWei(pos.minted);
      currentMap.set(addr, { ...pos, mintedFloat: minted });

      const prev = state.lastPositionMintedMap.get(addr);
      if (prev == null) {
        // New position
        if (minted > 0) {
          events.push(buildEvent("mint", {
            chain_id: 1,
            chain_name: "Ethereum",
            position: addr,
            owner: pos.owner,
            collateral_symbol: pos.collateralSymbol || "Unknown",
            minted_zchf: minted,
            minted_raw: pos.minted,
            tx_hash: null,
          }, "ponder", serverVersion));
        }
      } else if (minted > prev) {
        // Minted more
        const delta = minted - prev;
        events.push(buildEvent("mint", {
          chain_id: 1,
          chain_name: "Ethereum",
          position: addr,
          owner: pos.owner,
          collateral_symbol: pos.collateralSymbol || "Unknown",
          minted_zchf: delta,
          minted_raw: pos.minted,
          tx_hash: null,
        }, "ponder", serverVersion));
      } else if (minted < prev) {
        // Burned
        const delta = prev - minted;
        events.push(buildEvent("burn", {
          chain_id: 1,
          chain_name: "Ethereum",
          position: addr,
          owner: pos.owner,
          collateral_symbol: pos.collateralSymbol || "Unknown",
          burned_zchf: delta,
          burned_raw: pos.minted,
          tx_hash: null,
        }, "ponder", serverVersion));
      }
    }

    // Update state
    state.lastPositionMintedMap.clear();
    for (const [addr, pos] of currentMap) {
      state.lastPositionMintedMap.set(addr, pos.mintedFloat);
    }
  }

  // ── Challenges: detect start, bid, end ──────────────────────────────────
  // Note: Challenges don't have `id` or `chainId` — use position+number as composite key
  if (data.challenges?.items) {
    for (const ch of data.challenges.items) {
      const chId = `${ch.position}_${ch.number}`;

      if (!state.lastChallengeIds.has(chId)) {
        // New challenge
        events.push(buildEvent("challenge_start", {
          chain_id: 1,
          chain_name: "Ethereum",
          position: ch.position,
          challenger: ch.challenger,
          collateral_symbol: null,
          size: fromWei(ch.size),
          size_raw: ch.size,
          liquidation_price_zchf: fromWei(ch.liqPrice),
          challenge_value_zchf: fromWei(ch.size) * fromWei(ch.liqPrice),
          tx_hash: ch.txHash || null,
          started_at: ch.start ? new Date(Number(ch.start) * 1000).toISOString() : null,
          duration_seconds: ch.duration ? Number(ch.duration) : null,
        }, "ponder", serverVersion));
        state.lastChallengeIds.add(chId);
      }

      // Bid detection
      const prevBids = state.lastChallengeBidsMap.get(chId) || 0;
      const currentBids = Number(ch.bids || 0);
      if (currentBids > prevBids && state.lastChallengeBidsMap.has(chId)) {
        events.push(buildEvent("challenge_bid", {
          chain_id: 1,
          chain_name: "Ethereum",
          position: ch.position,
          challenge_number: ch.number,
          bidder: null, // Ponder doesn't expose individual bidders
          bid_amount_zchf: null,
          filled_size: fromWei(ch.filledSize),
          tx_hash: ch.txHash || null,
        }, "ponder", serverVersion));
      }
      state.lastChallengeBidsMap.set(chId, currentBids);

      // Challenge end detection
      const prevStatus = state.lastChallengeStatusMap.get(chId);
      if (prevStatus && prevStatus !== ch.status && (ch.status === "Success" || ch.status === "Averted")) {
        events.push(buildEvent("challenge_end", {
          chain_id: 1,
          chain_name: "Ethereum",
          position: ch.position,
          challenge_number: ch.number,
          outcome: ch.status === "Success" ? "success" : "averted",
          collateral_acquired: fromWei(ch.acquiredCollateral),
          amount_zchf: fromWei(ch.filledSize) * fromWei(ch.liqPrice),
          tx_hash: ch.txHash || null,
        }, "ponder", serverVersion));
      }
      state.lastChallengeStatusMap.set(chId, ch.status);
    }
  }

  // ── Equity trades: detect fps_large_trade ───────────────────────────────
  if (data.trades?.items) {
    const trades = data.trades.items;
    if (trades.length > 0) {
      const latestCount = Number(trades[0].count || 0);

      if (state.lastEquityTradeCount != null && latestCount > state.lastEquityTradeCount) {
        // New trades since last poll
        for (const t of trades) {
          const count = Number(t.count || 0);
          if (count <= state.lastEquityTradeCount) break;

          const amount = fromWei(t.amount);
          if (amount >= DEFAULT_THRESHOLDS.fps_large_trade) {
            events.push(buildEvent("fps_large_trade", {
              kind: t.kind?.toLowerCase() === "buy" ? "buy" : "sell",
              trader: t.trader,
              shares_traded: fromWei(t.shares),
              price_chf: fromWei(t.price),
              amount_zchf: amount,
              tx_hash: t.txHash,
            }, "ponder", serverVersion));
          }
        }
      }
      state.lastEquityTradeCount = latestCount;
    }
  }

  // ── Minters: detect proposed / approved ─────────────────────────────────
  if (data.minters?.items) {
    const now = Date.now() / 1000;
    for (const m of data.minters.items) {
      const addr = m.minter;
      const chainId = m.chainId || 1;
      const isDenied = !!m.denyDate;

      if (!state.lastMinterAddresses.has(addr)) {
        // New minter application
        if (!isDenied) {
          events.push(buildEvent("minter_proposed", {
            chain_id: chainId,
            chain_name: CHAIN_NAMES[chainId] || `Chain ${chainId}`,
            minter_address: addr,
            suggestor: m.suggestor,
            application_fee_zchf: fromWei(m.applicationFee),
            apply_message: m.applyMessage || "",
            application_period_seconds: m.applicationPeriod ? Number(m.applicationPeriod) : null,
            tx_hash: m.txHash,
          }, "ponder", serverVersion));
        }
        state.lastMinterAddresses.add(addr);
      }

      // Approval detection: past application period, not denied, not yet emitted
      if (
        !isDenied &&
        m.applyDate &&
        m.applicationPeriod &&
        !state.approvedEmitted.has(addr)
      ) {
        const applyTime = Number(m.applyDate);
        const period = Number(m.applicationPeriod);
        if (now > applyTime + period) {
          events.push(buildEvent("minter_approved", {
            chain_id: chainId,
            chain_name: CHAIN_NAMES[chainId] || `Chain ${chainId}`,
            minter_address: addr,
            suggestor: m.suggestor,
            tx_hash: m.txHash,
            applied_at: new Date(applyTime * 1000).toISOString(),
          }, "ponder", serverVersion));
          state.approvedEmitted.add(addr);
        }
      }

      state.lastMinterDeniedMap.set(addr, isDenied);
    }
  }

  // ── Rate changes ────────────────────────────────────────────────────────
  if (data.rates?.items) {
    for (const r of data.rates.items) {
      const key = `${r.chainId || 1}:${r.module}`;
      const created = Number(r.created || 0);

      if (state.lastRateCreated != null && created > state.lastRateCreated) {
        const oldRate = state.lastRateMap.get(key);
        const newRate = Number(r.approvedRate || 0);
        const chainId = r.chainId || 1;

        events.push(buildEvent("rate_change", {
          chain_id: chainId,
          chain_name: CHAIN_NAMES[chainId] || `Chain ${chainId}`,
          module: r.module,
          old_rate_percent: oldRate != null ? oldRate / 10000 : null,
          new_rate_percent: newRate / 10000,
          tx_hash: r.txHash,
        }, "ponder", serverVersion));
      }

      const currentRate = Number(r.approvedRate || 0);
      state.lastRateMap.set(key, currentRate);
    }

    // Update latest created timestamp
    if (data.rates.items.length > 0) {
      const latestCreated = Math.max(...data.rates.items.map((r) => Number(r.created || 0)));
      if (state.lastRateCreated == null || latestCreated > state.lastRateCreated) {
        state.lastRateCreated = latestCreated;
      }
    }
  }

  return events;
}

// ─── Batch 2: api.frankencoin.com ─────────────────────────────────────────────

async function pollApi() {
  const info = await apiFetch("/ecosystem/frankencoin/info");
  const events = [];

  // Extract per-chain supply data
  // The API returns chains as an object keyed by chain ID: { "1": { chainId, supply, ... }, "8453": ... }
  if (info && info.chains && typeof info.chains === "object") {
    let totalSupply = 0;

    for (const [key, chain] of Object.entries(info.chains)) {
      const chainId = chain.chainId || Number(key);
      const supply = Number(chain.supply || 0);
      if (!chainId || isNaN(supply)) continue;

      totalSupply += supply;

      const prev = state.lastSupplyByChain.get(chainId);
      if (prev != null) {
        const change = supply - prev;
        const changePercent = prev > 0 ? (change / prev) * 100 : 0;

        if (Math.abs(change) >= DEFAULT_THRESHOLDS.supply_change) {
          events.push(buildEvent("supply_change", {
            chain_id: chainId,
            chain_name: CHAIN_NAMES[chainId] || `Chain ${chainId}`,
            old_supply: prev,
            new_supply: supply,
            change_amount: change,
            change_percent: Math.round(changePercent * 100) / 100,
          }, "api", serverVersion));
        }
      }
      state.lastSupplyByChain.set(chainId, supply);
    }

    // Total supply across all chains
    if (state.lastTotalSupply != null) {
      const change = totalSupply - state.lastTotalSupply;
      if (Math.abs(change) >= DEFAULT_THRESHOLDS.supply_change) {
        events.push(buildEvent("supply_change", {
          chain_id: null,
          chain_name: "All Chains",
          old_supply: state.lastTotalSupply,
          new_supply: totalSupply,
          change_amount: change,
          change_percent: state.lastTotalSupply > 0
            ? Math.round((change / state.lastTotalSupply) * 10000) / 100
            : 0,
        }, "api", serverVersion));
      }
    }
    state.lastTotalSupply = totalSupply;
  }

  return events;
}

// ─── Batch 3: CoinGecko ──────────────────────────────────────────────────────

async function pollCoinGecko() {
  const data = await cgFetch("/simple/price?ids=frankencoin&vs_currencies=chf");
  const events = [];

  const price = data?.frankencoin?.chf;
  if (price == null) return events;

  const deviation = Math.abs(price - 1.0);
  const direction = price > 1.0 ? "above" : "below";

  // Depeg detection
  if (!state.isDepegged && deviation > DEPEG_TRIGGER) {
    state.isDepegged = true;
    state.depegDirection = direction;

    events.push(buildEvent("depeg", {
      price_chf: price,
      deviation_percent: Math.round(deviation * 10000) / 100,
      direction,
      threshold_percent: DEPEG_TRIGGER * 100,
      source: "coingecko",
    }, "coingecko", serverVersion));
  }

  // Depeg resolved detection
  if (state.isDepegged && deviation <= DEPEG_RESOLVE) {
    events.push(buildEvent("depeg_resolved", {
      price_chf: price,
      deviation_percent: Math.round(deviation * 10000) / 100,
      resolved_from: state.depegDirection,
      threshold_percent: DEPEG_RESOLVE * 100,
    }, "coingecko", serverVersion));

    state.isDepegged = false;
    state.depegDirection = null;
  }

  state.lastZchfPriceChf = price;
  return events;
}
