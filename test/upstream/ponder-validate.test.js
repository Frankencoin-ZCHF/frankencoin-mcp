import { test } from "node:test";
import assert from "node:assert/strict";
import { validateGraphqlQuery } from "../../src/upstream/ponderValidate.js";
import { ValidationError } from "../../src/lib/errors.js";

function reject(query, expected) {
  try {
    validateGraphqlQuery(query);
    assert.fail(`expected rejection for: ${query.slice(0, 40)}`);
  } catch (e) {
    assert.ok(e instanceof ValidationError, "must be ValidationError");
    if (expected) assert.equal(e.message, expected);
    return e;
  }
}

// ── T1 — read-only enforcement ──────────────────────────────────────────────
test("T1: mutation rejected", () => {
  reject("mutation { setRate(bps:0){ ok } }", "only read-only queries are allowed");
});
test("T1: subscription rejected", () => {
  reject("subscription { onThing { id } }", "only read-only queries are allowed");
});

// ── T1a — malformed cleanly ─────────────────────────────────────────────────
test("T1a: malformed GraphQL → generic invalid, no parser text", () => {
  const e = reject("{ this is (not valid", "invalid GraphQL query");
  assert.doesNotMatch(e.message, /Syntax|line|column|not valid/i);
});

// ── T2 — batched ────────────────────────────────────────────────────────────
test("T2: multiple operations rejected", () => {
  reject("query A { mintingHubV2PositionV2s { items { position } } } query B { equityTrades { items { kind } } }",
    "batched queries are not allowed");
});

// ── T3 — introspection ──────────────────────────────────────────────────────
test("T3: __schema rejected", () => {
  reject("{ __schema { types { name } } }", "introspection is not permitted");
});
test("T3: __type rejected", () => {
  reject("{ __type(name:\"X\"){ name } }", "introspection is not permitted");
});
test("T3: __typename allowed", () => {
  assert.doesNotThrow(() => validateGraphqlQuery("{ __typename }"));
  assert.doesNotThrow(() => validateGraphqlQuery("{ mintingHubV2PositionV2s { items { __typename position } } }"));
});

// ── T4 — depth / field / alias bombs ────────────────────────────────────────
test("T4: depth > 8 rejected", () => {
  const deep = "{ mintingHubV2PositionV2s { items { a { b { c { d { e { f { g { h } } } } } } } } } }";
  reject(deep, "query too deeply nested");
});
test("T4: field count > 200 rejected", () => {
  const fields = Array.from({ length: 205 }, (_, i) => `f${i}`).join(" ");
  reject(`{ eRC20Balances { items { ${fields} } } }`, "query too complex");
});
test("T4: alias count > 20 rejected", () => {
  const aliases = Array.from({ length: 25 }, (_, i) => `a${i}: balance`).join(" ");
  reject(`{ eRC20Balances { items { ${aliases} } } }`, "query too complex");
});

// ── T5 — limit / result caps ────────────────────────────────────────────────
test("T5: limit > 1000 rejected", () => {
  reject("{ eRC20Balances(limit: 100000){ items { balance } } }", "limit argument may not exceed 1000");
});

// oversize query
test("oversize query rejected before parse", () => {
  const big = `{ eRC20Balances(where:{a:"${"x".repeat(8100)}"}){ items { balance } } }`;
  reject(big, "query too large");
});

// non-allowlisted root field
test("non-allowlisted root field rejected", () => {
  reject("{ notARealEntity { items { x } } }", "query too complex");
});

// ── accept cases ────────────────────────────────────────────────────────────
test("valid documented entity query passes", () => {
  const q = "{ mintingHubV2PositionV2s(limit: 5){ items { position owner minted } } }";
  assert.equal(validateGraphqlQuery(q), q);
});
test("valid multi-entity query with args passes", () => {
  const q = `{ analyticDailyLogs(limit: 3, orderBy: "timestamp", orderDirection: "desc"){ items { date totalSupply } } leadrateRateChangeds(limit: 5){ items { approvedRate } } }`;
  assert.equal(validateGraphqlQuery(q), q);
});

// ── T6 — errors hide internals ──────────────────────────────────────────────
test("T6: rejection messages never leak internals", () => {
  const bad = [
    "mutation { x }",
    "{ __schema { types { name } } }",
    "{ eRC20Balances(limit: 100000){ items { balance } } }",
    "{ nope { items { x } } }",
  ];
  for (const q of bad) {
    const e = reject(q);
    assert.doesNotMatch(e.message, /ponder\.frankencoin|graphql|\bponder\b|stack|http|400|500/i);
  }
});
