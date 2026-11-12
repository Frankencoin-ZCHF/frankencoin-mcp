import { duneExecute } from "../upstream/dune.js";
import { DUNE_QUERIES } from "../lib/constants.js";
import { observe, availability } from "../lib/provider.js";
import { freshness } from "../lib/freshness.js";
import { indexedMetric } from "./indexed-metrics.js";

export async function duneMetrics(names) {
  const unverifiedRows = {}, queries = {}, sources = {}, values = {};
  await Promise.all(names.map(async (name) => {
    const result = await observe(duneExecute(DUNE_QUERIES[name]));
    const data = result.value;
    const objects = data?.rows?.filter((r) => r && typeof r === "object" && !Array.isArray(r)) ?? [];
    const isHolders = name.endsWith("Holders");
    const valid = isHolders ? objects.filter((r) => Number.isSafeInteger(r.holders) && r.holders >= 0) : [];
    // Series columns/units are unverified. Preserve raw rows separately, never
    // guess a metric from similarly named columns or silently infer zero.
    const usable = !data?.truncated && isHolders && valid.length === 1 && data?.rows.length === 1;
    if (data && !usable) Object.assign(result.health, { status: "unavailable", code: data.truncated ? "truncated_result" : !isHolders && objects.length ? "unverified_metric_schema" : "invalid_metric_rows" });
    queries[name] = { queryId: DUNE_QUERIES[name], ...result.health, asOf: data?.asOf ?? null, executionId: data?.executionId ?? null, retrievedAt: data?.retrievedAt ?? null };
    if (!isHolders && objects.length) unverifiedRows[name] = objects.slice(0, 30);
    if (usable) {
      values[name] = valid;
      sources[name] = { status: "available", provider: "Dune", queryId: DUNE_QUERIES[name], asOf: data.asOf, retrievedAt: data.retrievedAt,
        freshness: freshness(data.asOf, 86400), scope: "Published query result; holder-count scope is defined by the configured Dune query, not independently established by this MCP." };
    } else {
      const fallback = await observe(indexedMetric(name));
      values[name] = fallback.value?.rows ?? null;
      sources[name] = { ...fallback.health, ...fallback.value?.source, fallbackFor: "Dune" };
    }
  }));
  return { values, queries, sources, status: availability(sources), duneStatus: availability(queries), unverifiedRows,
    note: "queries reports Dune health; sources identifies the data actually returned, including explicitly scoped Ponder alternatives. Dune results are read, never executed. Availability is not freshness; inspect source evidence. Null means unavailable, not zero." };
}
