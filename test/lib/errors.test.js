import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ValidationError, NotFoundError, RateLimitError, TimeoutError, UpstreamError,
  MissingSecretError, AppError, mapError, sanitizeForLog,
} from "../../src/lib/errors.js";

test("type → HTTP status mapping", () => {
  assert.equal(mapError(new ValidationError()).status, 400);
  assert.equal(mapError(new NotFoundError()).status, 404);
  assert.equal(mapError(new RateLimitError()).status, 429);
  assert.equal(mapError(new TimeoutError("ponder")).status, 504);
  assert.equal(mapError(new UpstreamError("coingecko", 500)).status, 502);
  assert.equal(mapError(new MissingSecretError("dune")).status, 502);
  assert.equal(mapError(new Error("boom")).status, 500);
});

test("client message never leaks internal detail (URLs, secrets, status, source)", () => {
  const cases = [
    new UpstreamError("coingecko", 401),
    new UpstreamError("ponder", 500),
    new TimeoutError("ponder"),
    new MissingSecretError("dune"),
    new Error("Frankencoin API error 500: /positions/open"),
  ];
  for (const e of cases) {
    const { clientMessage } = mapError(e);
    assert.doesNotMatch(clientMessage, /coingecko|dune|ponder|frankencoin\.com|401|500|api key|\/positions/i);
  }
});

test("ValidationError carries its (server-defined) safe reason through as clientMessage", () => {
  const { status, clientMessage } = mapError(new ValidationError("only read-only queries are allowed"));
  assert.equal(status, 400);
  assert.equal(clientMessage, "only read-only queries are allowed");
});

test("unexpected (non-AppError) always maps to generic 500", () => {
  const { status, clientMessage } = mapError(new Error("stack: at foo (/secret/path.js:1)"));
  assert.equal(status, 500);
  assert.equal(clientMessage, "internal server error");
});

test("AppError is the base type", () => {
  assert.ok(new ValidationError() instanceof AppError);
});

test("sanitizeForLog strips CR/LF (log injection) and truncates", () => {
  assert.equal(sanitizeForLog("a\r\n[session] fake"), "a [session] fake");
  assert.equal(sanitizeForLog("x".repeat(500), 10).length, 10);
});
