// Source time is distinct from retrieval/response time. Reject future/invalid
// timestamps; a recent HTTP response cannot make an old measurement fresh.
export function sourceTime(value, now = Date.now()) {
  const ms = typeof value === "number" ? value * 1000 : typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && ms > 0 && ms <= now + 60_000 ? new Date(ms).toISOString() : null;
}
export function freshness(measuredAt, staleAfterSeconds, now = Date.now()) {
  const asOf = sourceTime(measuredAt, now);
  const ageSeconds = asOf ? Math.max(0, Math.floor((now - Date.parse(asOf)) / 1000)) : null;
  return { status: ageSeconds == null ? "unknown" : ageSeconds > staleAfterSeconds ? "stale" : "fresh", asOf, ageSeconds, staleAfterSeconds };
}
