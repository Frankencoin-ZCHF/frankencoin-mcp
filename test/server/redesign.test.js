import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
process.env.CACHE_ENABLED = "false";
const { createHttpServer } = await import("../../src/server/http.js");
const { setFetchImpl } = await import("../../src/upstream/client.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
const site = JSON.parse(readFileSync(new URL("../fixtures/redesign.json", import.meta.url)));
const assessments = JSON.parse(readFileSync(new URL("../fixtures/assessments.json", import.meta.url)));

test("website and collateral research have the same complete content over REST and MCP", async () => {
  setFetchImpl(async (url) => {
    if (url.includes("/git/trees/")) return Response.json(assessments.tree);
    const path = new URL(url).pathname.split("/contents/")[1];
    const text = url.includes("/frankencoin-site-redesign/") ? JSON.stringify(site[path]) : assessments.files[path];
    return text ? Response.json({ content: Buffer.from(text).toString("base64") }) : new Response("missing", { status: 404 });
  });
  const server = createHttpServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = new Client({ name: "redesign-contract-test", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));
    const manifest = await client.listTools();
    const knowledge = manifest.tools.find((t) => t.name === "get_knowledge");
    assert.deepEqual(knowledge.inputSchema.properties.language.enum, ["en", "de"]);
    assert.ok(knowledge.inputSchema.properties.page);
    assert.ok(manifest.tools.find((t) => t.name === "get_collateral_assessments").inputSchema.properties.document);
    for (const [name, args] of [
      ["get_knowledge", { topic: "website", page: "association", language: "de" }],
      ["get_compliance", {}],
      ["get_collateral_assessments", { asset: "WBTC" }],
      ["get_collateral_assessments", { document: "framework" }],
    ]) {
      const mcp = await client.callTool({ name, arguments: args });
      assert.notEqual(mcp.isError, true);
      assert.equal(mcp.structuredContent.status, "available");
      assert.deepEqual(mcp.structuredContent, JSON.parse(mcp.content[0].text));
      const rest = await (await fetch(`${base}/api/${name}?${new URLSearchParams(args)}`)).json();
      // Availability timestamps differ between requests; content does not.
      const { sources: _mcp, ...mcpContent } = mcp.structuredContent;
      const { sources: _rest, ...restContent } = rest.result;
      assert.deepEqual(mcpContent, restContent);
    }
    assert.equal((await fetch(base + "/api/get_collateral_assessments?asset=..%2Fsecrets")).status, 400);
    assert.equal((await client.callTool({ name: "get_collateral_assessments", arguments: { document: "__proto__" } })).isError, true);
    assert.equal((await fetch(base + "/api/get_knowledge?topic=website&language=fr")).status, 400);
    assert.match(await (await fetch(base + "/llms.txt")).text(), /get_collateral_assessments/);
  } finally {
    await client.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); setFetchImpl(null);
  }
});
