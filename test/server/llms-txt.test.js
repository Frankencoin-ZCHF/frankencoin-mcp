import { test } from "node:test";
import assert from "node:assert/strict";
import { renderLlmsTxt } from "../../src/server/llmsTxt.js";
import { TOOLS } from "../../src/tools/registry.js";

const BASE = "https://mcp.frankencoin.com";

test("renders an H1, blockquote summary, and the base URL", () => {
  const txt = renderLlmsTxt(TOOLS, BASE);
  assert.match(txt, /^# Frankencoin MCP Server/);
  assert.match(txt, /\n> Real-time Frankencoin/);
  assert.ok(txt.includes(`Base URL: ${BASE}`));
  assert.ok(txt.endsWith("\n"));
});

test("lists every registered tool exactly once", () => {
  const txt = renderLlmsTxt(TOOLS, BASE);
  assert.match(txt, new RegExp(`## Tools \\(${TOOLS.length}\\)`));
  for (const t of TOOLS) {
    const occurrences = txt.split(`**${t.name}**`).length - 1;
    assert.equal(occurrences, 1, `${t.name} should appear exactly once`);
    assert.ok(txt.includes(t.description), `${t.name} description present`);
  }
});

test("marks required params with * and omits the note for param-less tools", () => {
  const txt = renderLlmsTxt(TOOLS, BASE);
  // query_ponder has a required `query` param.
  assert.match(txt, /\*\*query_ponder\*\*[^\n]*_Params: `query\*`\._/);
  // get_protocol_snapshot has no params → no _Params:_ suffix on its line.
  const line = txt.split("\n").find((l) => l.includes("**get_protocol_snapshot**"));
  assert.ok(line && !line.includes("_Params:"));
});

test("uses the given base URL everywhere and leaks no secrets", () => {
  const txt = renderLlmsTxt(TOOLS, "http://localhost:9999");
  assert.ok(txt.includes("curl http://localhost:9999/api/get_protocol_snapshot"));
  assert.doesNotMatch(txt, /mcp\.frankencoin\.com/); // base was overridden
  // Must not emit an actual secret value/assignment (prose mentions of CoinGecko/Dune
  // as data sources are fine; the renderer never receives key values anyway).
  assert.doesNotMatch(txt, /_API_KEY\b|Bearer\s+\S|sk-[A-Za-z0-9]{8}|[A-Za-z0-9]{32,}/);
});
