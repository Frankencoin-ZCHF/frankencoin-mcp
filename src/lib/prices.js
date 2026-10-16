// Public feed timestamps are milliseconds. This is a freshness policy, not an execution guarantee.
export function priceQuality(row, now = Date.now()) {
  const timestamp = row?.timestamp;
  const validTime = typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0 && timestamp <= now + 300000;
  const validPrice = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;
  const usable = validTime && !!row.source && (validPrice(row.price?.chf) || validPrice(row.price?.usd));
  const ageSeconds = validTime ? Math.max(0, Math.floor((now - timestamp) / 1000)) : null;
  return {
    ...row,
    price: { chf: usable && validPrice(row.price?.chf) ? row.price.chf : null, usd: usable && validPrice(row.price?.usd) ? row.price.usd : null },
    updatedAt: validTime ? new Date(timestamp).toISOString() : null,
    freshness: { status: !usable ? "unavailable" : ageSeconds > 86400 ? "stale" : "fresh", ageSeconds, staleAfterSeconds: 86400, sourceAvailable: !!row.source },
  };
}
