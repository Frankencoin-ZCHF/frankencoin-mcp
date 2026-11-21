import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { clear } from "../../src/cache.js";
import { setFetchImpl } from "../../src/upstream/client.js";
import { dispatchTool } from "../../src/tools/dispatch.js";

const address = "0x" + "1".repeat(40);
const other = "0x" + "2".repeat(40);
afterEach(() => { clear(); setFetchImpl(null); });

test("a previously unknown chain and counter-token can produce a correctly scaled DEX quote", async () => {
  const chainId = 123456;
  setFetchImpl(async (url) => {
    const { pathname, searchParams } = new URL(url);
    if (pathname === "/godeye/tokens") return Response.json({ tokens: [{ chainId, token: address, symbol: "ZCHF" }] });
    if (pathname === "/tokens/" + chainId) return Response.json({ tokens: [{ network: chainId, address: other, decimals: 8, symbol: "NEW" }] });
    if (pathname === "/prices") {
      assert.equal(searchParams.get("destDecimals"), "8");
      return Response.json({ priceRoute: { network: chainId, srcToken: address, destToken: other,
        srcAmount: "1000000000000000000", destAmount: "123000000" } });
    }
    return new Response(null, { status: 404 });
  });
  const result = await dispatchTool("get_liquidity", { chainId, asset: "ZCHF", side: "sell", amount: "1", quoteToken: other });
  assert.equal(result.venues[0].quoteAmount, "1.23");
  assert.equal(result.venues[0].quoteAsset, "NEW");
  assert.equal(result.venues[0].quoteToken, other);
});

test("missing collateral decimals propagate through position values without erasing reported zero terms", async () => {
  setFetchImpl(async (url) => {
    if (url.endsWith("/prices/list")) return Response.json([{ chainId: 1, address, timestamp: Date.now(), source: "test", price: { chf: 20 } }]);
    if (url.endsWith("/ecosystem/collateral/list")) return Response.json({ list: [] });
    if (url.includes("ponder.")) return Response.json({ data: { mintingHubV2PositionV2s: { items: [
      { collateral: address, collateralBalance: "1", minted: "0", price: "100", reserveContribution: 0 }
    ] } } });
    return new Response(null, { status: 404 });
  });
  const { positions: [position] } = await dispatchTool("get_positions", { detail: true });
  assert.equal(position.collateral.balance, null);
  assert.equal(position.collateral.valueChf, null);
  assert.equal(position.collateralRatioPercent, null);
  assert.equal(position.liquidationPriceZchf, null);
  assert.equal(position.minted, 0);
  assert.equal(position.reserveContributionPercent, 0);
  assert.equal(position.riskPremiumPercent, null);
});

test("a new documentation file can be listed and retrieved through its discovered selector", async () => {
  setFetchImpl(async (url) => {
    if (url.includes("/git/trees/")) return Response.json({ tree: [{ mode: "100644", type: "blob", path: "governance/new-rule.md" }] });
    if (url.includes("/contents/governance/new-rule.md?")) return Response.json({ content: Buffer.from("# Changed rule").toString("base64") });
    return new Response(null, { status: 404 });
  });
  const catalogue = await dispatchTool("get_knowledge", { topic: "index" });
  assert.ok(catalogue.availableTopics.includes("doc:governance/new-rule"));
  const doc = await dispatchTool("get_knowledge", { topic: "doc:governance/new-rule" });
  assert.equal(doc.content, "# Changed rule");
});
