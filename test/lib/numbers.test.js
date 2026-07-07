import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fromWei, bpsToPercent, ppmToPercent, pegDeviation, pegStatus, round, isoFromUnix, dateFromUnix,
} from "../../src/lib/numbers.js";

test("fromWei: zero / falsy", () => {
  assert.equal(fromWei("0"), 0);
  assert.equal(fromWei(null), 0);
  assert.equal(fromWei(undefined), 0);
  assert.equal(fromWei(""), 0);
});

test("fromWei: 18 decimals default", () => {
  assert.equal(fromWei("1000000000000000000"), 1);
  assert.equal(fromWei("2500000000000000000"), 2.5);
});

test("fromWei: custom decimals (6-dp CHFAU-style, 36-decimals liq price)", () => {
  assert.equal(fromWei("1500000", 6), 1.5);
  // liquidation price scaled to 36 total decimals with 18-dp collateral → 36-18=18
  assert.equal(fromWei("2000000000000000000", 36 - 18), 2);
});

test("fromWei: very large value still returns a finite number (precision boundary)", () => {
  const v = fromWei("27195555478609416088678148");
  assert.ok(Number.isFinite(v));
  assert.ok(v > 27_000_000 && v < 27_200_000);
});

test("bpsToPercent / ppmToPercent", () => {
  assert.equal(bpsToPercent(37500), 3.75);
  assert.equal(bpsToPercent(10000), 1);
  assert.equal(ppmToPercent(10000), 1);
});

test("pegDeviation", () => {
  assert.equal(pegDeviation(1), 0);
  assert.equal(round(pegDeviation(1.005), 4), 0.5);
  assert.equal(pegDeviation(null), null);
});

test("pegStatus thresholds (0.5 / 1.0 / null)", () => {
  assert.equal(pegStatus(1), "healthy");
  assert.equal(pegStatus(1.004), "healthy"); // 0.4%
  assert.equal(pegStatus(1.007), "warning"); // 0.7% → in [0.5, 1.0)
  assert.equal(pegStatus(0.994), "warning"); // -0.6%
  assert.equal(pegStatus(1.02), "critical"); // 2.0%
  assert.equal(pegStatus(0.98), "critical");
  assert.equal(pegStatus(null), "unknown");
});

test("round returns numbers and null-safes", () => {
  assert.equal(round(1.23456, 2), 1.23);
  assert.equal(typeof round(1.23456, 2), "number");
  assert.equal(round(null), null);
  assert.equal(round(Infinity), null);
});

test("isoFromUnix / dateFromUnix", () => {
  assert.equal(isoFromUnix(0), "1970-01-01T00:00:00.000Z");
  assert.equal(dateFromUnix(0), "1970-01-01");
  assert.equal(isoFromUnix(null), null);
  assert.equal(dateFromUnix(null), null);
});
