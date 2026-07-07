import { test } from "node:test";
import assert from "node:assert/strict";
import { restSuccess, restError, mcpSuccess, mcpError, pretty } from "../../src/lib/envelope.js";
import { ValidationError, UpstreamError } from "../../src/lib/errors.js";

test("restSuccess shape", () => {
  assert.deepEqual(restSuccess("get_savings", { a: 1 }), { ok: true, tool: "get_savings", result: { a: 1 } });
});

test("restError shape (safe message + code, no leak)", () => {
  const env = restError("query_ponder", new ValidationError("only read-only queries are allowed"));
  assert.deepEqual(env, {
    ok: false, tool: "query_ponder", error: "only read-only queries are allowed", code: "invalid_request",
  });
  const up = restError("get_market_data", new UpstreamError("coingecko", 500));
  assert.equal(up.error, "upstream data source error");
  assert.doesNotMatch(up.error, /coingecko|500/);
});

test("mcpSuccess wraps pretty JSON text content", () => {
  const out = mcpSuccess({ x: 1 });
  assert.equal(out.content[0].type, "text");
  assert.equal(out.content[0].text, JSON.stringify({ x: 1 }, null, 2));
  assert.ok(!out.isError);
});

test("mcpError is a safe text block with isError", () => {
  const out = mcpError(new ValidationError("query too large"));
  assert.equal(out.isError, true);
  assert.equal(out.content[0].text, "Error: query too large");
});

test("pretty is 2-space", () => {
  assert.equal(pretty({ a: 1 }), '{\n  "a": 1\n}');
});
