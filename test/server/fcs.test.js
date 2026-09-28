import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

process.env.CACHE_ENABLED = "false";
delete process.env.DUNE_API_KEY;
delete process.env.COINGECKO_API_KEY;
const { setFetchImpl } = await import("../../src/upstream/client.js");
const { createHttpServer } = await import("../../src/server/http.js");
const { FCS_REFERENCE } = await import("../../src/lib/fcs.js");
const response = (data) => new Response(JSON.stringify(data));
let sourceDown = false;
const outbound = [];
setFetchImpl(async (url) => {
  outbound.push(url);
  if (url.includes("api.github.com/")) return response({ content: Buffer.from("{}").toString("base64") });
  if (url.endsWith("/fcs/info")) return sourceDown ? new Response("down", { status: 404 }) : response({
    erc20: { decimals: 18 }, chain: { chainId: 1, address: FCS_REFERENCE.address },
    token: { totalSupply: 200, totalAssets: 80000, ask: 1200, bid: 1200, isBinding: false },
  });
  if (url.includes("ponder.frankencoin.com")) return response({ data: {} });
  if (url.endsWith("/prices/list")) return response([]);
  if (url.includes("api.frankencoin.com/")) return response({});
  throw new Error("Unexpected network destination");
});

let server, base;
before(async () => {
  server = createHttpServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); setFetchImpl(null); });
async function get(path) {
  const res = await fetch(base + path);
  assert.equal(res.status, 200, path);
  return res.json();
}

test("REST manifest and llms discover FCS without adding a tool or relabeling FPS", async () => {
  assert.equal((await get("/health")).toolCount, 16);
  const manifest = await get("/api");
  assert.equal(manifest.tools.length, 16);
  for (const name of ["get_governance", "get_protocol_snapshot", "get_knowledge"]) {
    assert.match(manifest.tools.find((t) => t.name === name).description, /FCS/);
  }
  const gov = manifest.tools.find((t) => t.name === "get_governance");
  assert.match(gov.params.find((p) => p.name === "type").description, /fcs/);
  const llms = await (await fetch(base + "/llms.txt")).text();
  assert.match(llms, /canonical holder-facing governance and share token/i);
  assert.match(llms, /underlying Equity token/);
  assert.ok(llms.includes(FCS_REFERENCE.address));
  for (const url of Object.values(FCS_REFERENCE.links)) assert.ok(llms.includes(url), url);
  assert.match(llms, /planned_not_live.*https:\/\/fcs\.frankencoin\.com/);
});

test("REST knowledge, governance and snapshot agree on FCS identity, links and unavailable state", async () => {
  for (const topic of ["token_addresses", "links", "fcs", "fcs_migration", "governance", "pool_shares"]) {
    const j = await get(`/api/get_knowledge?topic=${topic}`);
    assert.equal(j.ok, true);
    assert.deepEqual(j.result.fcs, FCS_REFERENCE);
  }
  for (const suffix of ["get_governance", "get_governance?type=fcs", "get_protocol_snapshot"]) {
    const j = await get(`/api/${suffix}`);
    assert.equal(j.ok, true);
    assert.equal(j.result.fcs.state.totalSupply, 200);
    assert.equal(j.result.fcs.state.isBinding, false);
    assert.deepEqual(j.result.fcs.mechanics, FCS_REFERENCE.mechanics);
  }
  sourceDown = true;
  for (const suffix of ["get_governance", "get_governance?type=fcs", "get_protocol_snapshot"]) {
    const j = await get(`/api/${suffix}`);
    assert.equal(j.ok, true);
    assert.equal(j.result.fcs.state.status, "unavailable");
    assert.equal(j.result.fcs.state.totalSupply, null);
  }
  assert.ok(outbound.every((url) => !url.includes("fcs.frankencoin.com")), "planned CTA must never be fetched");
});

test("CLI help exposes FCS state and documentation selectors", () => {
  const root = new URL("../../", import.meta.url);
  const gov = execFileSync(process.execPath, ["src/cli.js", "governance", "--help"], { cwd: root, encoding: "utf8" });
  const knowledge = execFileSync(process.execPath, ["src/cli.js", "knowledge", "--help"], { cwd: root, encoding: "utf8" });
  assert.match(gov, /all\|fcs\|/);
  assert.match(knowledge, /fcs\|fcs_migration/);
});

test("CLI snapshot displays unavailable FCS separately from underlying FPS economics", () => {
  const client = new URL("../../src/upstream/client.js", import.meta.url).href;
  const preload = `import { setFetchImpl } from ${JSON.stringify(client)};
    setFetchImpl(async (url) => new Response(JSON.stringify(url.endsWith('/prices/list') ? [] : {})));`;
  const output = execFileSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, "src/cli.js", "snapshot"], {
    cwd: new URL("../../", import.meta.url), encoding: "utf8",
  });
  assert.match(output, /FCS.*canonical.*1:1.*FPS/);
  assert.match(output, /FCS State.*unavailable/);
  assert.match(output, /Underlying FPS/);
});

test("no nonexistent legacy FPS hostname in repository text", () => {
  const forbidden = ["fps", "frankencoin", "com"].join(".");
  const root = new URL("../../", import.meta.url);
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".git")) continue;
      const path = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
      if (entry.isDirectory()) walk(path);
      else assert.ok(!readFileSync(path, "utf8").includes(forbidden), path.pathname);
    }
  }
  walk(root);
});
