import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as LegacyHttp } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { createHttpServer } from "../../src/server/http.js";
import { config } from "../../src/config.js";
import { TOOLS } from "../../src/tools/registry.js";

const identity = { name: "interop", version: "1" };
const revision = "2026-07-28";
let server, url;
before(async () => {
  server = createHttpServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
});
after(() => { server.closeAllConnections(); server.close(); });

for (const transportName of ["HTTP", "stdio"]) {
  test(`current SDK discovers and uses the catalogue over ${transportName}`, async () => {
    const transport = transportName === "HTTP" ? new StreamableHTTPClientTransport(url)
      : new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../../src/index.js", import.meta.url))], stderr: "ignore" });
    const client = new Client(identity, { versionNegotiation: { mode: { pin: revision } } });
    try {
      await client.connect(transport);
      const discovery = await client.discover();
      assert.equal(discovery.capabilities.tools.listChanged, false);
      assert.equal(discovery.ttlMs, 300_000);
      assert.equal(discovery._meta["io.modelcontextprotocol/serverInfo"].version, config.version);
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map(t => t.name).sort(), TOOLS.map(t => t.name).sort());
      assert.ok(tools.every(t => t.annotations.readOnlyHint && t.inputSchema.type === "object"));
      const { resources } = await client.listResources();
      const guide = await client.readResource({ uri: resources.find(r => r.name === "agent-guide").uri });
      assert.match(guide.contents[0].text, /get_protocol_snapshot/);
      const prompts = await client.listPrompts();
      assert.equal(prompts.prompts.length, 2);
      assert.equal((await client.getPrompt({ name: "collateral_review" })).messages[0].role, "user");
      const index = await client.callTool({ name: "get_knowledge", arguments: { topic: "index" } });
      assert.ok(index.structuredContent.availableTopics.includes("fcs"));
      assert.deepEqual(JSON.parse(index.content[0].text), index.structuredContent);
      const bad = await client.callTool({ name: "query_ponder", arguments: { query: "invalid" } });
      assert.equal(bad.isError, true);
    } finally { await client.close(); }
  });
}

for (const kind of ["streamable", "SSE"]) {
  test(`legacy SDK handshakes and lists tools over ${kind}`, async () => {
    const transport = kind === "SSE" ? new SSEClientTransport(new URL("/sse", url)) : new LegacyHttp(url);
    const client = new LegacyClient(identity);
    try {
      await client.connect(transport);
      assert.equal((await client.listTools()).tools.length, TOOLS.length);
      if (kind === "streamable") await transport.terminateSession();
    } finally { await client.close(); }
  });
}

function post(method, version = revision, extra = {}, params = {}) {
  return fetch(url, { method: "POST", headers: {
    Accept: "application/json, text/event-stream", "Content-Type": "application/json",
    "MCP-Protocol-Version": version, "Mcp-Method": method, ...extra,
  }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: {
    "io.modelcontextprotocol/protocolVersion": version, "io.modelcontextprotocol/clientInfo": identity,
    "io.modelcontextprotocol/clientCapabilities": {},
  } } }) });
}
test("direct invocation needs no handshake or session", async () => {
  const reply = await post("tools/list");
  assert.equal(reply.status, 200);
  assert.equal(reply.headers.get("mcp-session-id"), null);
  assert.equal((await reply.json()).result.tools.length, TOOLS.length);
});
test("wire errors preserve HTTP and JSON-RPC semantics", async () => {
  for (const [response, status, code] of [
    [await post("tools/list", "2099-01-01"), 400, -32022],
    [await post("tools/list", revision, { "Mcp-Method": "ping" }), 400, -32020],
    [await post("unknown/method"), 404, -32601],
  ]) {
    assert.equal(response.status, status);
    assert.equal((await response.json()).error.code, code);
  }
  assert.equal((await post("tools/list", revision, { Origin: "https://untrusted.example" })).status, 403);
});

test("browser preflight and session-free HTTP methods", async () => {
  const preflight = await fetch(url, { method: "OPTIONS", headers: { Origin: "http://localhost:6274" } });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get("access-control-allow-headers"), /Mcp-Name/i);
  for (const method of ["GET", "DELETE"]) {
    assert.equal((await fetch(url, { method })).status, 405);
  }
});

test("a streamed body over the configured cap is rejected", async () => {
  async function* chunks() {
    yield Buffer.alloc(config.maxBodyBytes, " ");
    yield "{}";
  }
  const reply = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: chunks(), duplex: "half",
  });
  assert.equal(reply.status, 413);
});

test("independent legacy clients initialize concurrently", async () => {
  const clients = Array.from({ length: 4 }, () => new LegacyClient(identity));
  const transports = clients.map(() => new LegacyHttp(url));
  try {
    await Promise.all(clients.map((client, i) => client.connect(transports[i])));
    assert.equal(new Set(transports.map(t => t.sessionId)).size, clients.length);
  } finally {
    await Promise.all(transports.map(t => t.terminateSession()));
    await Promise.all(clients.map(client => client.close()));
  }
});
