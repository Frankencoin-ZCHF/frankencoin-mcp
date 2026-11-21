import assert from "node:assert/strict";
import { test } from "node:test";

process.env.CACHE_ENABLED = "false";
const { dispatchTool } = await import("../../src/tools/dispatch.js");
const { setFetchImpl } = await import("../fixtures/catalogue-fetch.js");
const wallet = "0x" + "1".repeat(40);
const peer = "0x" + "2".repeat(40);
const zero = "0x" + "0".repeat(40);
const report = (params = {}) => dispatchTool("get_analytics", { type: "wallet_flows", wallet, days: 1, ...params });
const page = (items, next = null) => ({ items, pageInfo: { hasNextPage: next !== null, endCursor: next } });
function mock(handler) {
  setFetchImpl(async (_url, options) => Response.json({ data: handler(JSON.parse(options.body).query) }));
}

test("wallet totals use exact token units across both directions and all pages", async () => {
  let calls = 0;
  mock(query => {
    calls++;
    assert.match(query, /chainId:1,token:"0xb58e61c3098d85632df34eecfb899a1ed80921cb"/);
    assert.ok(query.includes(`from_not:"${wallet}"`));
    if (calls === 2) {
      assert.match(query, /after:"next"/);
      assert.doesNotMatch(query, /outgoing:/);
      return { incoming: page([{ from: zero, amount: "1" }]) };
    }
    assert.ok(query.includes(`to_not:"${wallet}"`));
    return {
      incoming: page([{ from: peer, amount: "9007199254740993123456789" }], "next"),
      outgoing: page([{ to: peer, amount: "9007199254740993123456799" }, { to: zero, amount: "2" }]),
    };
  });
  const result = await report({ limit: 1 });
  assert.equal(calls, 2);
  assert.equal(result.netZchf, "-0.000000000000000011");
  assert.equal(result.mintedToWalletZchf, "0.000000000000000001");
  assert.equal(result.burnedFromWalletZchf, "0.000000000000000002");
  assert.equal(result.counterpartyCount, 2);
  assert.deepEqual(result.counterparties.map(x => x.address), [peer]);
  assert.equal(result.incomingTransfers, 2);
});

test("empty, unavailable and over-limit flows have distinguishable outcomes", async () => {
  mock(() => ({ incoming: page([]), outgoing: page([]) }));
  assert.equal((await report()).incomingZchf, "0");
  mock(() => ({ incoming: page([]) }));
  await assert.rejects(report(), { code: "upstream_error" });
  let cursor = 0;
  mock(() => ({ incoming: page([{ from: peer, amount: "1" }], String(++cursor)), outgoing: page([]) }));
  await assert.rejects(report(), { code: "invalid_request" });
  assert.equal(cursor, 5);
  await assert.rejects(report({ wallet: undefined }), { code: "invalid_request" });
});

test("snapshot overview uses one upstream and preserves true zero values", async () => {
  const urls = [];
  setFetchImpl(async url => {
    urls.push(url);
    return Response.json({ erc20: { symbol: "ZCHF" }, token: { supply: 0 }, tvl: { chf: 0 }, chains: {} });
  });
  const overview = await dispatchTool("get_protocol_snapshot", { view: "overview" });
  assert.equal(urls.length, 1);
  assert.ok(urls[0].endsWith("/ecosystem/frankencoin/info"));
  assert.equal(overview.zchf.totalSupply, 0);
  assert.deepEqual(overview.zchf.tvl, { chf: 0, usd: null });
  setFetchImpl(async () => Response.json({}));
  await assert.rejects(dispatchTool("get_protocol_snapshot", { view: "overview" }), { code: "upstream_error" });
});
