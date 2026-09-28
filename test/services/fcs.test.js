import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.CACHE_ENABLED = "false";
delete process.env.DUNE_API_KEY;
const { setFetchImpl } = await import("../../src/upstream/client.js");
const { dispatchTool } = await import("../../src/tools/dispatch.js");

const FCS = "0xdb861830d9ae2d1fcf99fa0cfd3973de382b0b5b";
const FPS = "0x1bA26788dfDe592fec8bcB0Eaff472a42BE341B2";
const response = (data) => new Response(JSON.stringify(data));
const github = (data) => response({ content: Buffer.from(typeof data === "string" ? data : JSON.stringify(data)).toString("base64") });
afterEach(() => setFetchImpl(null));

// Representative documented /fcs/info shape, already scaled (not wei).
const info = () => ({
  erc20: { name: "Frankencoin Share", symbol: "FCS", decimals: 18 },
  chain: { chainId: 1, address: FCS },
  token: { totalSupply: 246.5, totalAssets: 103600, ask: 1260.8, bid: 1250.1, isBinding: false },
});

test("governance type=fcs returns API-reported wrapper state without inventing votes or rescaling", async () => {
  const calls = [];
  setFetchImpl(async (url) => { calls.push(url); return response(info()); });
  const out = await dispatchTool("get_governance", { type: "fcs" });
  assert.equal(out.fcs.address, FCS);
  assert.equal(out.fcs.state.status, "available");
  assert.equal(out.fcs.state.totalSupply, 246.5);
  assert.equal(out.fcs.state.totalAssetsZchf, 103600);
  assert.equal(out.fcs.state.isBinding, false);
  assert.deepEqual(out.fcs.state.referencePriceZchf, { ask: 1260.8, bid: 1250.1 });
  assert.equal(out.fcs.state.source.kind, "api_reported_contract_reads");
  assert.equal(out.fcs.state.source.blockNumber, null);
  assert.equal(out.fcs.state.source.updatedAt, null);
  assert.ok(out.fcs.state.notProvided.includes("internalFcsVotes"));
  assert.ok(out.fcs.state.notProvided.includes("wrapperHeldFps"));
  assert.deepEqual(calls, ["https://api.frankencoin.com/fcs/info"]);
  assert.equal(out.equityTrades, undefined);
});

test("FCS state fails closed on unavailable, malformed or wrong-deployment API data", async () => {
  const wrong = [null, {}, { ...info(), chain: { chainId: 8453, address: FCS } },
    { ...info(), chain: { chainId: 1, address: FPS } },
    { ...info(), chain: { chainId: 1, address: FCS + " " } },
    { ...info(), erc20: { decimals: 6 } }];
  for (const data of wrong) {
    setFetchImpl(async () => response(data));
    const { fcs } = await dispatchTool("get_governance", { type: "fcs" });
    assert.equal(fcs.state.status, "unavailable");
    assert.equal(fcs.state.totalSupply, null);
    assert.equal(fcs.state.isBinding, null);
    assert.equal(fcs.address, FCS);
  }
  for (const fail of [() => new Response("private upstream detail", { status: 404 }), () => new Response("bad json")]) {
    setFetchImpl(async () => fail());
    const { fcs } = await dispatchTool("get_governance", { type: "fcs" });
    assert.equal(fcs.state.status, "unavailable");
    assert.match(fcs.state.note, /unavailable/i);
    assert.doesNotMatch(JSON.stringify(fcs), /private upstream detail|bad json/);
  }
});

test("partial FCS data preserves real zero/false but hides the API bid failure sentinel", async () => {
  setFetchImpl(async () => response({ ...info(), token: { totalSupply: 0, totalAssets: 0, ask: 0, bid: 0, isBinding: false } }));
  let { fcs } = await dispatchTool("get_governance", { type: "fcs" });
  assert.equal(fcs.state.status, "partial");
  assert.equal(fcs.state.totalSupply, 0);
  assert.equal(fcs.state.totalAssetsZchf, 0);
  assert.equal(fcs.state.isBinding, false);
  assert.equal(fcs.state.referencePriceZchf.bid, null);
  assert.match(fcs.state.note, /bid.*0.*failed read/);
  setFetchImpl(async () => response({ ...info(), token: { totalSupply: "100", totalAssets: -1, ask: null, bid: {}, isBinding: "false" } }));
  ({ fcs } = await dispatchTool("get_governance", { type: "fcs" }));
  assert.equal(fcs.state.status, "unavailable");
  assert.equal(fcs.state.totalSupply, null);
  assert.equal(fcs.state.totalAssetsZchf, null);
  assert.equal(fcs.state.isBinding, null);
});

test("snapshot keeps underlying FPS economics separate from the shared FCS state", async () => {
  let failFcs = false;
  setFetchImpl(async (url) => {
    if (url.endsWith("/fcs/info")) return failFcs ? new Response("down", { status: 404 }) : response(info());
    if (url.endsWith("/ecosystem/frankencoin/info")) return response({ fps: { totalSupply: 10000, marketCap: 5000000 } });
    if (url.endsWith("/ecosystem/fps/info")) return response({ erc20: { symbol: "FPS" }, earnings: { profit: 500, loss: 200 }, reserve: { equity: 100000 } });
    if (url.endsWith("/prices/list")) return response([{ symbol: "FPS", address: FPS, price: { chf: 500, usd: 600 } }, { symbol: "ZCHF", address: "0xb58e61c3098d85632df34eecfb899a1ed80921cb", price: { chf: 1, usd: 1.2 } }]);
    return response({});
  });
  const snapshot = await dispatchTool("get_protocol_snapshot", {});
  const governance = await dispatchTool("get_governance", { type: "fcs" });
  assert.deepEqual(snapshot.fcs, governance.fcs);
  assert.equal(snapshot.fcs?.state.totalSupply, 246.5);
  assert.equal(snapshot.fps.totalSupply, 10000);
  assert.equal(snapshot.fps.price.chf, 500);
  assert.equal(snapshot.fps.earnings.net.chf, 300);
  assert.equal(snapshot.fps.reserve.equity.chf, 100000);
  assert.match(snapshot.fps.role, /underlying Equity/i);
  failFcs = true;
  const degraded = await dispatchTool("get_protocol_snapshot", {});
  assert.deepEqual(degraded.fps, snapshot.fps);
  assert.equal(degraded.fcs.state.status, "unavailable");
  assert.equal(degraded.fcs.state.isBinding, null);
});

test("governance identifies wrapper-originated FPS trades without claiming FCS holder counts", async () => {
  setFetchImpl(async (url) => {
    if (url.endsWith("/fcs/info")) return response(info());
    if (url.includes("ponder.frankencoin.com")) return response({ data: {
      leadrateRateChangeds: { items: [] }, frankencoinMinters: { items: [] },
      equityTrades: { items: [{ trader: "0xDb861830D9Ae2d1fCF99fA0cfd3973de382B0B5b", kind: "Buy", shares: "2000000000000000000", created: "1720000000" }] },
    } });
    throw new Error("unexpected external request");
  });
  const out = await dispatchTool("get_governance", {});
  assert.equal(out.fcs.state.totalSupply, 246.5);
  assert.equal(out.equityTrades[0].shareToken, "FPS");
  assert.equal(out.equityTrades[0].traderRole, "FCS wrapper");
  assert.equal(out.equityTrades[0].sharesTraded, 2);
  assert.match(out.activityNote, /not.*FCS.*trade.*history/);
  assert.equal(out.holders.fcs.count, null);
  assert.match(out.holders.fcs.note, /not.*FCS holder/);
  const filtered = await dispatchTool("get_governance", { type: "equity_trades" });
  assert.equal(filtered.fcs.address, FCS);
  assert.deepEqual(filtered.equityTrades, out.equityTrades);
});

test("curated FCS reference and links survive unavailable GitHub without fabricated docs", async () => {
  setFetchImpl(async () => new Response("unavailable", { status: 403 }));
  for (const topic of ["token_addresses", "links", "fcs", "fcs_migration", "governance", "pool_shares"]) {
    const out = await dispatchTool("get_knowledge", { topic });
    assert.equal(out.fcs.address, FCS);
    assert.equal(out.fcs.links.legacyFps, "https://frankencoin.com/fps");
    assert.equal(out.fcs.plannedLinks.website.status, "planned_not_live");
    assert.match(out.note, /unavailable/i);
    if (["fcs", "fcs_migration", "governance", "pool_shares"].includes(topic)) assert.equal(out.content, null);
    if (topic === "links") assert.equal(out.app.fcs, undefined);
  }
});

test("FCS knowledge topics expose exact mechanics, current links and a separately planned CTA", async () => {
  const calls = [];
  setFetchImpl(async (url) => { calls.push(url); return github("# Official documentation"); });
  const mechanics = await dispatchTool("get_knowledge", { topic: "fcs" });
  assert.equal(mechanics.docsUrl, "https://docs.frankencoin.com/pool-shares/fcs");
  assert.ok(calls.some((url) => url.endsWith("/contents/fcs.md")));
  assert.match(mechanics.fcs.mechanics.qualification, /more than 1%.*internal FCS.*underlying FPS quorum/);
  assert.match(mechanics.fcs.mechanics.binding, /more than two thirds.*underlying FPS votes/);
  assert.match(mechanics.fcs.mechanics.delegation, /non-subtractive and transitive/);
  assert.match(mechanics.fcs.mechanics.exit, /binding.*wrapper.*90-day/);
  assert.match(mechanics.fcs.mechanics.exit, /at least.*average.*either binding state/);
  assert.equal(mechanics.fcs.sources.website.repository, "Frankencoin-ZCHF/frankencoin-site");
  assert.equal(mechanics.fcs.sources.website.branch, "fcs-launch-homepage");
  assert.equal(mechanics.fcs.sources.website.commit, "18a55400de54956b3355a2a8929f98550164cd96");
  assert.equal(mechanics.fcs.sources.mechanics.commit, "c1f229e3b26050367aafcb55da294342b4cae382");
  assert.ok(mechanics.fcs.links.explorer.endsWith(FCS));
  assert.equal(mechanics.fcs.links.mechanics, mechanics.docsUrl);
  assert.equal(mechanics.fcs.links.migration, "https://docs.frankencoin.com/pool-shares/fcs-migration");
  assert.equal(mechanics.fcs.links.governance, "https://docs.frankencoin.com/governance");
  assert.equal(mechanics.fcs.links.governancePage, "https://frankencoin.com/governance");
  assert.equal(mechanics.fcs.links.trade, "https://swap.cow.fi/#/1/swap/USDT/FCS");
  assert.equal(mechanics.fcs.links.legacyFps, "https://frankencoin.com/fps");
  assert.equal(mechanics.fcs.plannedLinks.website.url, "https://fcs.frankencoin.com");
  assert.equal(mechanics.fcs.plannedLinks.website.status, "planned_not_live");
  assert.ok(!JSON.stringify(mechanics.fcs.links).includes("https://fcs.frankencoin.com"));
  for (const topic of ["fcs_migration", "governance", "pool_shares"]) {
    const out = await dispatchTool("get_knowledge", { topic });
    assert.deepEqual(out.fcs, mechanics.fcs);
    assert.ok(out.availableTopics.includes("fcs_migration"));
  }
  assert.ok(calls.some((url) => url.endsWith("/contents/fcs-migration.md")));
});

test("token addresses distinguish canonical FCS from underlying FPS despite stale site copy", async () => {
  setFetchImpl(async () => github({ fps: { subtitle: "Governance token" } }));
  const out = await dispatchTool("get_knowledge", { topic: "token_addresses" });
  assert.equal(out.fcs?.address, FCS);
  assert.equal(out.fcs.chainId, 1);
  assert.equal(out.fcs.chain, "Ethereum");
  assert.match(out.fcs.role, /canonical.*governance.*share/i);
  assert.equal(out.fcs.underlying.address, FPS);
  assert.equal(out.fcs.underlying.wrapRatio, "1 FPS : 1 FCS");
  assert.equal(out.fps.address, FPS);
  assert.match(out.fps.description, /underlying Equity token/);
  assert.match(out.fcs.mechanics.entry, /not.*1:1.*ZCHF/);
  assert.match(out.fcs.mechanics.crossChain, /vote snapshots, not.*tokens/);
});
