/**
 * Number encoding helpers — the single source of truth for unit conversion and
 * peg logic. Pure, no I/O.
 *
 * Units (per CLAUDE.md / SPEC §4):
 *   - Token amounts from Ponder are BigInt strings → fromWei() to a JS float.
 *   - Savings rates are stored as basis-points × 10 (37500 → 3.75%) → bpsToPercent().
 *   - Risk premiums are stored on the same bps-scale here (10000 → 1.0%) → ppmToPercent().
 */

/**
 * Decode a BigInt-string token amount to a float.
 * Note: Number(BigInt(...)) can lose precision for very large raw values before
 * dividing — preserved intentionally to match the prior server's output.
 */
export function fromWei(val, decimals = 18) {
  if (!val || val === "0") return 0;
  return Number(BigInt(val)) / Math.pow(10, decimals);
}

/** Basis-points ×10 → percent: 37500 → 3.75 */
export function bpsToPercent(bps) {
  return bps / 10000;
}

/** PPM (bps-scaled here) → percent: 10000 → 1.0 */
export function ppmToPercent(ppm) {
  return ppm / 10000;
}

/** Peg deviation in percent: (priceChf - 1) * 100. Null-safe → null. */
export function pegDeviation(priceChf) {
  if (priceChf == null) return null;
  return (priceChf - 1) * 100;
}

/**
 * Peg status from a CHF price. THE single implementation (SPEC §4.3):
 *   |dev| < 0.5% → healthy, < 1.0% → warning, else critical, null price → unknown.
 */
export function pegStatus(priceChf) {
  if (priceChf == null) return "unknown";
  const dev = Math.abs(priceChf - 1) * 100;
  if (dev < 0.5) return "healthy";
  if (dev < 1.0) return "warning";
  return "critical";
}

/** Round to N decimals, returning a Number (not a string). Null-safe. */
export function round(n, decimals = 2) {
  if (n == null || !Number.isFinite(n)) return null;
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

/** Convert a unix-seconds value to an ISO-8601 string, or null. */
export function isoFromUnix(sec) {
  if (sec == null || sec === "") return null;
  return new Date(Number(sec) * 1000).toISOString();
}

/** Convert a unix-seconds value to a YYYY-MM-DD date string, or null. */
export function dateFromUnix(sec) {
  const iso = isoFromUnix(sec);
  return iso ? iso.split("T")[0] : null;
}
