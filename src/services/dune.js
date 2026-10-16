import { duneExecute } from "../upstream/dune.js";
import { DUNE_QUERIES } from "../lib/constants.js";
import { observe, availability } from "../lib/provider.js";

export async function duneMetrics(names) {
  const results = await Promise.all(names.map((name) => observe(duneExecute(DUNE_QUERIES[name]), (v) => Array.isArray(v) && v.length > 0)));
  const unverifiedRows = {};
  results.forEach((result, i) => {
    if (result.value === null) return;
    const name = names[i];
    const rows = result.value;
    const objects = rows.filter((r) => r && typeof r === "object" && !Array.isArray(r));
    // Only the legacy holders column has a supported metric contract here.
    // Series query column names/units have no captured source schema: do not guess.
    const isHolders = name === "zchfHolders" || name === "fpsHolders";
    const valid = isHolders ? objects.filter((r) => Number.isSafeInteger(r.holders) && r.holders >= 0) : [];
    result.value = valid.length ? valid : null;
    if (!valid.length || valid.length !== rows.length) {
      Object.assign(result.health, {
        status: valid.length ? "partial" : "unavailable",
        code: !isHolders && objects.length ? "unverified_metric_schema" : "invalid_metric_rows",
        validRows: valid.length,
        rejectedRows: rows.length - valid.length,
      });
    }
    if (!isHolders && objects.length) unverifiedRows[name] = objects.slice(0, 30);
  });
  const queries = Object.fromEntries(names.map((name, i) => [name, { queryId: DUNE_QUERIES[name], ...results[i].health }]));
  const values = Object.fromEntries(names.map((name, i) => [name, results[i].value]));
  const status = availability(queries);
  return { values, queries, status, unverifiedRows, note: results.every((r) => r.health.status === "unconfigured")
    ? "Dune API key not configured — metrics unavailable"
    : status === "available" ? "Dune query results; provider as-of timestamps are not supplied by this client."
    : "Some or all Dune metrics unavailable; inspect per-query status. unverifiedRows are raw source rows, NOT verified metrics; series columns/units need source-schema confirmation. Not merely delayed data." };
}
