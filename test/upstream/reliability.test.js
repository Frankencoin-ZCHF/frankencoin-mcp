import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { fetchJson, setFetchImpl } from "../../src/upstream/client.js";

afterEach(() => setFetchImpl(null));
test("an oversized Content-Length cancels the response stream", async () => {
  let cancelled = false;
  setFetchImpl(
    async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-length": "1000000000" } },
      ),
  );
  await assert.rejects(
    fetchJson("https://example.invalid", {
      source: "test",
      timeout: 100,
      retries: 0,
    }),
    { code: "upstream_error" },
  );
  assert.equal(cancelled, true);
});
test("a stream failure after successful headers becomes a typed upstream error", async () => {
  setFetchImpl(
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.error(new Error("private-provider-message"));
          },
        }),
      ),
  );
  await assert.rejects(
    fetchJson("https://example.invalid", {
      source: "test",
      timeout: 100,
      retries: 0,
    }),
    { code: "upstream_error", clientMessage: "upstream data source error" },
  );
});
test("retry-after cannot extend a request outside its total budget", async () => {
  let count = 0;
  setFetchImpl(async () => {
    count++;
    return new Response("", {
      status: 429,
      headers: { "retry-after": "86400" },
    });
  });
  await assert.rejects(
    fetchJson("https://example.invalid", {
      source: "test",
      timeout: 100,
      retries: 1,
    }),
    { code: "upstream_timeout" },
  );
  assert.equal(count, 1);
});

test("a failing origin opens its own circuit, admits one recovery probe and resumes", async () => {
  const { ProviderCircuits } = await import("../../src/upstream/circuit.js");
  const { UpstreamError } = await import("../../src/lib/errors.js");
  let time = 0,
    attempts = 0;
  const c = new ProviderCircuits({
    now: () => time,
    threshold: 2,
    cooldownMs: 10,
  });
  const fail = () =>
    c.run("a", "provider", async () => {
      attempts++;
      throw new UpstreamError("provider", 503);
    });
  await assert.rejects(fail());
  await assert.rejects(fail());
  await assert.rejects(fail());
  assert.equal(attempts, 2);
  assert.equal(await c.run("b", "other", async () => 1), 1);
  time = 11;
  let release;
  const probe = c.run(
    "a",
    "provider",
    () =>
      new Promise((r) => {
        release = r;
      }),
  );
  await assert.rejects(fail());
  release(2);
  assert.equal(await probe, 2);
  assert.equal(await c.run("a", "provider", async () => 3), 3);
});
