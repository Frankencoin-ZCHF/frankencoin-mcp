// Read-only release smoke test. One request at a time against the public MCP.
// node scripts/verify-live.mjs [http(s)://host/mcp]
import assert from "node:assert/strict";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { config } from "../src/config.js";
import { TOOLS } from "../src/tools/registry.js";

const url = new URL(process.argv[2] ?? "https://mcp.frankencoin.com/mcp");
const client = new Client(
  { name: "frankencoin-release-probe", version: config.version },
  {
    versionNegotiation: { mode: { pin: "2026-07-28" } },
  },
);
let serverTiming;
async function timedFetch(url, init) {
  const response = await fetch(url, init);
  serverTiming = response.headers.get("server-timing");
  return response;
}
async function measure(operation) {
  serverTiming = null;
  const start = performance.now();
  const value = await operation();
  return { value, ms: Math.round(performance.now() - start), serverTiming };
}
try {
  await client.connect(new StreamableHTTPClientTransport(url, {fetch: timedFetch}));
  const discovery = await measure(() => client.discover());
  const version =
    discovery.value._meta["io.modelcontextprotocol/serverInfo"].version;
  const catalogue = await measure(() => client.listTools());
  assert.deepEqual(
    catalogue.value.tools.map((t) => t.name).sort(),
    TOOLS.map((t) => t.name).sort(),
  );
  console.log({
    url: url.href,
    version,
    discoveryMs: discovery.ms,
    catalogueMs: catalogue.ms,
    discoveryServerTiming: discovery.serverTiming,
    catalogueServerTiming: catalogue.serverTiming,
  });
  for (const [tool, args, check] of [
    [
      "get_knowledge",
      { topic: "index" },
      (d) => d.availableTopics.includes("fcs"),
    ],
    [
      "get_protocol_snapshot",
      { view: "overview" },
      (d) => d.zchf.totalSupply > 0,
    ],
    [
      "get_token_ledger",
      { view: "holders", limit: 5 },
      (d) => d.data.holdersPage.length === 5,
    ],
    [
      "get_liquidity",
      { asset: "ZCHF", amount: "1000", side: "sell" },
      (d) => d.venues.some((v) => v.status === "quoted"),
    ],
  ]) {
    const times = [];
    for (let i = 0; i < 6; i++) {
      const { value, ms } = await measure(() =>
        client.callTool({ name: tool, arguments: args }),
      );
      assert.ok(
        !value.isError && check(value.structuredContent),
        tool + " failed its data check",
      );
      times.push(ms);
    }
    console.log({ tool, firstMs: times[0], repeatMs: times.slice(1) });
  }
} finally {
  await client.close();
}
