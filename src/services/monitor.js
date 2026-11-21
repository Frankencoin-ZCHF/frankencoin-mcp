import { fetchJson } from "../upstream/client.js";
import { apiObservation } from "../upstream/frankencoin.js";
import { getOrLoad } from "../cache.js";
import { UpstreamError, ValidationError } from "../lib/errors.js";

// Kraken's final candle is in progress. Use closed CHF-denominated candles only.
export async function pegHistory({ from, to, interval, thresholdBps, limit }) {
  if (from == null || to == null || from >= to)
    throw new ValidationError("Supply a closed-candle time window");
  const url =
    "https://api.kraken.com/0/public/OHLC?pair=ZCHFCHF&interval=" +
    interval +
    "&since=" +
    Math.max(0, from - interval * 60);
  const observation = await getOrLoad("peg:" + url, 15_000, async () => {
    const json = await fetchJson(url, {
      source: "kraken",
      timeout: 6000,
      retries: 0,
    });
    if (json?.error?.length || !Array.isArray(json?.result?.ZCHFCHF))
      throw new UpstreamError("kraken");
    return {
      rows: json.result.ZCHFCHF.slice(0, -1),
      retrievedAt: new Date().toISOString(),
    };
  });
  const earliest = observation.rows[0]?.[0] ?? null;
  const rows = observation.rows
    .filter((r) => r[0] >= from && r[0] + interval * 60 <= to)
    .map(([start, open, high, low, close, , , trades]) => {
      const prices = [open, high, low, close].map(Number);
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(trades) ||
        prices.some((p) => !Number.isFinite(p) || p <= 0)
      )
        throw new UpstreamError("kraken");
      const deviationBps =
        Math.max(Math.abs(prices[1] - 1), Math.abs(prices[2] - 1)) * 10000;
      return {
        start,
        open,
        high,
        low,
        close,
        trades,
        deviationBps,
        thresholdReached: trades > 0 && deviationBps >= thresholdBps,
      };
    });
  return {
    pair: "ZCHF/CHF",
    venue: "Kraken",
    intervalMinutes: interval,
    from,
    to,
    thresholdBps,
    retrievedAt: observation.retrievedAt,
    earliestReturnedStart: earliest,
    candleCount: rows.length,
    observedBreaches: rows.filter((r) => r.thresholdReached).length,
    candles: rows.slice(-limit),
    scope:
      "Observed trades in closed candles. Kraken limits history to its latest 720 intervals. Missing intervals have unknown peg behaviour.",
  };
}

// A collateral-level sensitivity. Aggregation can conceal undercollateralised individual positions.
export async function stress({ shockPercent, address }) {
  const { data, retrievedAt } = await apiObservation(
    "/ecosystem/collateral/stats",
  );
  if (!data?.map || Array.isArray(data.map) || typeof data.map !== "object")
    throw new UpstreamError("frankencoin");
  const positions = Object.entries(data.map)
    .filter(([key]) => !address || key.toLowerCase() === address)
    .map(([key, r]) => {
      const debt = r.totalMinted,
        value = r.totalValueLocked?.chf;
      if (
        !/^0x[\da-f]{40}$/i.test(key) ||
        !Number.isFinite(debt) ||
        debt < 0 ||
        !Number.isFinite(value) ||
        value < 0
      )
        throw new UpstreamError("frankencoin");
      const stressedValueChf = value * (1 - shockPercent / 100);
      return {
        collateral: key,
        debtZchf: debt,
        valueChf: value,
        stressedValueChf,
        stressedCoverage: debt > 0 ? stressedValueChf / debt : null,
        aggregateShortfallChf: Math.max(0, debt - stressedValueChf),
      };
    });
  return {
    retrievedAt,
    shockPercent,
    positions,
    scope:
      "Static aggregate collateral sensitivity at 1 CHF per ZCHF. Excludes liquidation costs, timing, price feedback and individual-position shortfalls.",
  };
}
