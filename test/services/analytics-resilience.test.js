import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { clear } from "../../src/cache.js";
import { setFetchImpl, ledgerToken } from "../fixtures/catalogue-fetch.js";
import { dispatchTool } from "../../src/tools/dispatch.js";
import { Semaphore } from "../../src/lib/concurrency.js";
import { walkBook, atoms } from "../../src/services/quotes.js";


const wallet = "0x" + "1".repeat(40);
const tx = "0x" + "2".repeat(64);
afterEach(() => {
  clear();
  setFetchImpl(null);
});
test("200 concurrent holder calls share one read and discard nested provider identity fields", async () => {
  let reads = 0;
  setFetchImpl(async (url) => {
    assert.equal(new URL(url).pathname, "/godeye/holders");
    reads++;
    return Response.json({
      holders: 1,
      list: [
        {
          address: wallet,
          label: "hidden-name",
          kind: "person",
          balance: 5,
          share: "hidden-name",
        },
      ],
    });
  });
  const results = await Promise.all(
    Array.from({ length: 200 }, () =>
      dispatchTool("get_token_ledger", { view: "holders" }),
    ),
  );
  assert.equal(reads, 1);
  assert.deepEqual(results[0].data.holdersPage, [
    { address: wallet, balance: 5, share: null, since: null },
  ]);
  assert.doesNotMatch(JSON.stringify(results), /hidden-name|person|label/);
});
test("missing chain data leaves portfolio total unknown even with seven successful ledgers", async () => {
  setFetchImpl(async (url) => {
    const id = Number(new URL(url).searchParams.get("chainId"));
    if (id === 10) return new Response("", { status: 404 });
    return Response.json({
      address: wallet,
      balance: 2,
      sources: [],
      destinations: [],
      token: { chainId: id, token: ledgerToken(id, "ZCHF") },
    });
  });
  const r = await dispatchTool("get_token_ledger", {
    view: "portfolio",
    wallet,
  });
  assert.equal(r.balances.length, 8);
  assert.equal(r.total, null);
  assert.equal(r.balances.filter((b) => b.balance === 2).length, 7);
});
test("malformed ledger counterparties fail closed", async () => {
  setFetchImpl(async () =>
    Response.json({ list: [{ address: "hidden-name", balance: 2 }] }),
  );
  await assert.rejects(dispatchTool("get_token_ledger", { view: "holders" }), {
    code: "upstream_error",
  });
});
test("event projection ignores additional fields and rejects repeated page cursors", async () => {
  setFetchImpl(async () =>
    Response.json({
      data: {
        transfers: {
          items: [
            {
              amount: "15",
              from: wallet,
              to: wallet,
              created: "1",
              txHash: tx,
              chainId: 1,
              token: ledgerToken(1, "ZCHF"),
              blockheight: "10",
              label: "hidden-name",
            },
          ],
          pageInfo: { hasNextPage: true, endCursor: "next" },
        },
      },
    }),
  );
  const args = { view: "events", from: 1, to: 2 };
  const result = await dispatchTool("get_protocol_activity", args);
  assert.doesNotMatch(JSON.stringify(result), /hidden-name/);
  await assert.rejects(
    dispatchTool("get_protocol_activity", { ...args, after: "next" }),
    { code: "upstream_error" },
  );
});
test("sized book fills correctly and flags insufficient and unordered depth", () => {
  const levels = [
    ["0.99", "1.5"],
    ["1.01", "4"],
  ];
  assert.equal(walkBook(levels, atoms("2"), "buy").quoteAmount, "1.99");
  assert.equal(walkBook(levels, atoms("10"), "buy").unfilled, "4.5");
  assert.throws(() => walkBook(levels, atoms("2"), "sell"));
});
test("one failed venue leaves other quotes available, preserves partial fills", async () => {
  setFetchImpl(async (url) => {
    if (url.endsWith("/AssetPairs"))
      return Response.json({
        error: [],
        result: {
          ZCHFUSD: { base: "ZCHF", wsname: "ZCHF/USD", status: "online" },
          ZCHFCHF: { base: "ZCHF", wsname: "ZCHF/CHF", status: "online" },
        },
      });
    if (url.includes("kraken")) {
      const pair = new URL(url).searchParams.get("pair");
      return Response.json({
        error: [],
        result: { [pair]: { bids: [["0.99", "0.5"]] } },
      });
    }
    return new Response("", { status: 403 });
  });
  const r = await dispatchTool("get_liquidity", { side: "sell", amount: "1" });
  assert.equal(r.venues.filter((v) => v.status === "unavailable").length, 1);
  assert.equal(
    r.venues.filter(
      (v) => v.status === "insufficient_depth" && v.quoteAmount === null,
    ).length,
    2,
  );
});
test("FCS scenario and wallet limit share a canonical block including the all-primary comparison", async () => {
  const calls = [];
  setFetchImpl(async (url, opt) => {
    const { method, params } = JSON.parse(opt.body);
    let result;
    if (method === "eth_chainId") result = "0x1";
    else if (method === "eth_getBlockByNumber")
      result = {
        hash: tx,
        timestamp: "0x" + Math.floor(Date.now() / 1000).toString(16),
        number: "0x11",
      };
    else {
      calls.push(params);
      result =
        "0x" +
        (params[0].data.startsWith("0x402d267d") ? 0n : atoms("2"))
          .toString(16)
          .padStart(64, "0");
    }
    return Response.json({ result });
  });
  const r = await dispatchTool("preview_fcs", {
    operation: "deposit",
    amount: "1000",
    wallet,
    secondaryBudget: "250",
    secondaryPrice: "125",
  });
  assert.equal(r.withinAccountMaximum, false);
  assert.equal(r.scenario.combinedShares, "4");
  assert.equal(r.scenario.averagePriceZchf, "312.5");
  assert.equal(calls.length, 3);
  assert.ok(
    calls.every(
      ([, block]) => block.blockHash === tx && block.requireCanonical,
    ),
  );
});
test("CCIP cannot attach an unrelated source token to a ZCHF transfer", async () => {
  setFetchImpl(async () =>
    Response.json({
      messageId: tx,
      sourceNetworkInfo: { chainId: "1" },
      destNetworkInfo: { chainId: "10" },
      tokenAmounts: [
        {
          sourceTokenAddress: wallet,
          destTokenAddress: ledgerToken(10, "ZCHF"),
          amount: "10",
        },
      ],
    }),
  );
  await assert.rejects(dispatchTool("get_bridge_message", { messageId: tx }), {
    code: "invalid_request",
  });
});
test("CCIP preserves pending delivery, excludes private annotations", async () => {
  setFetchImpl(async () =>
    Response.json({
      messageId: tx,
      sourceNetworkInfo: { chainId: "1" },
      destNetworkInfo: { chainId: "10" },
      sender: wallet,
      receiver: wallet,
      status: "SENT",
      sendTransactionHash: tx,
      label: "hidden",
      tokenAmounts: [
        {
          sourceTokenAddress: ledgerToken(1, "ZCHF"),
          destTokenAddress: ledgerToken(10, "ZCHF"),
          amount: "10",
        },
      ],
    }),
  );
  const r = await dispatchTool("get_bridge_message", { messageId: tx });
  assert.equal(r.destinationTx, null);
  assert.equal(r.status, "SENT");
  assert.doesNotMatch(JSON.stringify(r), /hidden/);
});
test("overloaded queue rejects immediately, expires waiters and recovers all capacity", async () => {
  const gate = new Semaphore(1, { maxQueue: 1, waitMs: 12 });
  await gate.acquire();
  const waiting = gate.acquire();
  await assert.rejects(gate.acquire(), { code: "busy" });
  await assert.rejects(waiting, { code: "busy" });
  gate.release();
  assert.equal(await gate.run(() => 42), 42);
  assert.equal(gate.active, 0);
});

test("receipt remains available when indexed history is offline", async () => {
  setFetchImpl(async (url, opt) => {
    if (url.includes("ponder")) return new Response("", { status: 403 });
    const { method } = JSON.parse(opt.body);
    const results = {
      eth_chainId: "0x1",
      eth_getBlockByNumber: { hash: tx },
      eth_getTransactionReceipt: {
        transactionHash: tx,
        from: wallet,
        blockHash: tx,
        blockNumber: "0x51",
        status: "0x1",
        logs: [],
      },
    };
    return Response.json({ result: results[method] });
  });
  const result = await dispatchTool("get_protocol_activity", {
    view: "transaction",
    txHash: tx,
  });
  assert.equal(result.indexStatus, "unavailable");
  assert.equal(result.receipt.status, "success");
  assert.equal(result.sections, null);
});
test("reorganised receipt is discarded while independent indexed results survive", async () => {
  setFetchImpl(async (url, opt) => {
    const body = JSON.parse(opt.body);
    if (url.includes("ponder")) {
      const data = {};
      for (const match of body.query.matchAll(/(\w+):\w+\(where:/g))
        data[match[1]] = { items: [], pageInfo: { hasNextPage: false } };
      return Response.json({ data });
    }
    const results = {
      eth_chainId: "0x1",
      eth_getBlockByNumber: { hash: "0x" + "3".repeat(64) },
      eth_getTransactionReceipt: {
        transactionHash: tx,
        from: wallet,
        blockHash: tx,
        blockNumber: "0x51",
        status: "0x1",
        logs: [],
      },
    };
    return Response.json({ result: results[body.method] });
  });
  const r = await dispatchTool("get_protocol_activity", {
    view: "transaction",
    txHash: tx,
  });
  assert.equal(r.receipt.status, "unavailable");
  assert.equal(r.indexStatus, "available");
});
test("peg monitoring excludes in-progress trades and empty candles", async () => {
  const row = (t, high, n) => [t, "1", high, "0.99", "1", "1", "1", n];
  setFetchImpl(async (url) => url.endsWith("AssetPairs") ? Response.json({ error: [], result: { ZCHFCHF: { base: "ZCHF", status: "online", wsname: "ZCHF/CHF" } } }) :
    Response.json({
      error: [],
      result: {
        ZCHFCHF: [row(600, "1.1", 0), row(660, "1.1", 1), row(720, "1.9", 10)],
      },
    }),
  );
  const r = await dispatchTool("get_peg_history", {
    from: 600,
    to: 1000,
    interval: 1,
    thresholdBps: 50,
  });
  assert.equal(r.candleCount, 2);
  assert.equal(r.observedBreaches, 1);
});
test("route quote for a different destination is unavailable", async () => {
  setFetchImpl(async () =>
    Response.json({
      priceRoute: {
        network: 1,
        srcToken: ledgerToken(1, "FCS"),
        destToken: wallet,
        srcAmount: String(atoms("1")),
        destAmount: "1000000",
      },
    }),
  );
  const result = await dispatchTool("get_liquidity", {
    asset: "FCS",
    side: "sell",
    amount: "1",
  });
  assert.equal(result.venues[0].status, "unavailable");
});

test("FCS previews reject a stale latest block on every fallback", async () => {
  setFetchImpl(async (url, opt) => {
    const { method } = JSON.parse(opt.body);
    const result =
      method === "eth_chainId"
        ? "0x1"
        : method === "eth_getBlockByNumber"
          ? { number: "0x1", hash: tx, timestamp: "0x1" }
          : "0x" + "1".repeat(64);
    return Response.json({ result });
  });
  await assert.rejects(
    dispatchTool("preview_fcs", { operation: "deposit", amount: "10" }),
    { code: "upstream_error" },
  );
});

test("borrower history accepts string timestamps and reports a signed interval to indexed maturity", async () => {
  setFetchImpl(async (url) =>
    url.includes("ponder")
      ? Response.json({
          data: {
            position: {
              items: [
                {
                  position: wallet,
                  expiration: "200",
                  minted: "5",
                  availableForPosition: "10",
                  closed: false,
                  denied: false,
                },
              ],
            },
          },
        })
      : Response.json({
          num: 1,
          list: [
            {
              position: wallet,
              created: "190",
              mintedAdjusted: "-3",
              minted: "5",
              txHash: tx,
              owner: wallet,
            },
          ],
        }),
  );
  const r = await dispatchTool("get_protocol_report", {
    report: "position_lifecycle",
    version: 1,
    address: wallet,
  });
  assert.equal(r.updates[0].action, "loan_repayment");
  assert.equal(r.updates[0].secondsBeforeCurrentRecordedExpiry, 10);
});

test("CEX snapshots coalesce across sizes, sides and chains and retry a failed book at expiry", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const counts = new Map();
  setFetchImpl(async (url) => {
    counts.set(url, (counts.get(url) ?? 0) + 1);
    if (url.endsWith("/AssetPairs"))
      return Response.json({
        error: [],
        result: {
          ZCHFUSD: { base: "ZCHF", wsname: "ZCHF/USD", status: "online" },
          ZCHFCHF: { base: "ZCHF", wsname: "ZCHF/CHF", status: "online" },
        },
      });
    if (url.includes("kraken")) {
      const pair = new URL(url).searchParams.get("pair");
      if (pair === "ZCHFUSD" && counts.get(url) === 1)
        return new Response("", { status: 403 });
      return Response.json({
        error: [],
        result: { [pair]: { asks: [["1.1", "8"]], bids: [["1", "8"]] } },
      });
    }
    return new Response("", { status: 404 });
  });
  const quote = (amount, side, chainId) =>
    dispatchTool("get_liquidity", { asset: "ZCHF", side, chainId, amount });
  const [a, b] = await Promise.all([
    quote("1", "sell", 1),
    quote("2", "buy", 8453),
  ]);
  assert.equal(a.venues[1].quoteAmount, "1");
  assert.equal(b.venues[1].quoteAmount, "2.2");
  assert.equal(a.venues[1].retrievedAt, b.venues[1].retrievedAt);
  assert.deepEqual(
    b.venues.map((v) => [v.venue, v.quoteAsset]),
    [
      ["Velora", "USDC"],
      ["Kraken", "CHF"],
      ["Kraken", "USD"],
    ],
  );
  assert.ok([...counts.keys()].every((url) => !url.includes("mexc")));
  assert.equal(b.venues[2].status, "unavailable");
  for (const [url, count] of counts)
    if (url.includes("kraken")) assert.equal(count, 1);
  t.mock.timers.tick(5001);
  assert.equal((await quote("1", "buy", 1)).venues[2].status, "quoted");
});

test("market discovery refreshes renamed books, picks up new venues, and distinguishes an outage from an empty listing", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  let stage = 0;
  const requested = [];
  setFetchImpl(async (url) => {
    requested.push(url);
    if (url.includes("/AssetPairs")) {
      if (stage === 2) return new Response("", { status: 403 });
      const result = {
        BTCUSD: { base: "XXBT", wsname: "XBT/USD", status: "online" },
      };
      if (stage < 2)
        result[stage === 0 ? "OLDKEY" : "NEWKEY"] = {
          base: "ZCHF",
          wsname: stage === 0 ? "ZCHF/CHF" : "ZCHF/EUR",
          status: "online",
        };
      return Response.json({ error: [], result });
    }
    if (url.includes("/tickers"))
      return Response.json({
        tickers: [
          {
            market: { identifier: "new_venue" },
            base: "ZCHF",
            target: "EUR",
            coin_id: "frankencoin",
            is_anomaly: false,
            is_stale: false,
          },
        ],
      });
    if (url.includes("/Depth")) {
      const key = new URL(url).searchParams.get("pair");
      return Response.json({
        error: [],
        result: { [key]: { bids: [["1", "5"]] } },
      });
    }
    return new Response("", { status: 404 });
  });
  const read = () =>
    dispatchTool("get_liquidity", { side: "sell", amount: "1" });
  const a = await read();
  assert.equal(a.venues[1].quoteAsset, "CHF");
  assert.equal(a.discovery.indexed.markets[0].exchange, "new_venue");
  await read();
  assert.equal(requested.filter((u) => u.endsWith("/AssetPairs")).length, 1);
  for (stage = 1; stage <= 3; stage++) {
    t.mock.timers.tick(600001);
    const b = await read();
    if (stage === 1) {
      assert.deepEqual(
        b.venues.map((v) => v.quoteAsset),
        ["USDC", "EUR"],
      );
      assert.ok(requested.some((u) => u.includes("pair=NEWKEY")));
    }
    if (stage === 2) {
      assert.equal(b.discovery.kraken.status, "unavailable");
      assert.equal(b.discovery.kraken.markets, null);
    }
    if (stage === 3) {
      assert.equal(b.discovery.kraken.status, "available");
      assert.deepEqual(b.discovery.kraken.markets, []);
    }
  }
});
