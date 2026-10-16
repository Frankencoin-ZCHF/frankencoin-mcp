import { duneExecute } from "../upstream/dune.js";
import { DUNE_QUERIES } from "../lib/constants.js";
import { observe, availability } from "../lib/provider.js";

export async function duneMetrics(names) {
  const results = await Promise.all(names.map((name) => observe(duneExecute(DUNE_QUERIES[name]), (v) => Array.isArray(v) && v.length > 0)));
  const queries = Object.fromEntries(names.map((name, i) => [name, { queryId: DUNE_QUERIES[name], ...results[i].health }]));
  const values = Object.fromEntries(names.map((name, i) => [name, results[i].value]));
  const status = availability(queries);
  return { values, queries, status, note: results.every((r) => r.health.status === "unconfigured")
    ? "Dune API key not configured — metrics unavailable"
    : status === "available" ? "Dune query results; provider as-of timestamps are not supplied by this client."
    : "Some or all Dune metrics unavailable; inspect per-query status. Not merely delayed data." };
}
