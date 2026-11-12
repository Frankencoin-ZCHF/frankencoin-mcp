/** Read the last published result. Never execute queries or spend compute credits. */
import { fetchJson } from "./client.js";
import { withProviderCooldown } from "./cooldown.js";
import { getOrLoad } from "../cache.js";
import { config } from "../config.js";
import { DUNE_BASE } from "../lib/constants.js";
import { MissingSecretError, UpstreamError } from "../lib/errors.js";
import { sourceTime } from "../lib/freshness.js";

export async function duneExecute(queryId) {
  if (!config.duneKey) throw new MissingSecretError("dune");
  return getOrLoad(`dune:${queryId}`, 30 * 60_000, () => withProviderCooldown(`dune:${queryId}`, async () => {
    const data = await fetchJson(`${DUNE_BASE}/query/${queryId}/results`, {
      source: "dune", timeout: 8_000, retries: 0, redirect: "error",
      headers: { "x-dune-api-key": config.duneKey, Accept: "application/json" },
    });
    if (data?.state !== "QUERY_STATE_COMPLETED" || !Array.isArray(data.result?.rows) || data.is_execution_finished === false || (data.query_id != null && data.query_id !== queryId)) throw new UpstreamError("dune");
    return { rows: data.result.rows, executionId: data.execution_id ?? null,
      asOf: sourceTime(data.execution_ended_at), retrievedAt: new Date().toISOString(),
      truncated: data.next_offset != null || data.result.metadata?.total_row_count > data.result.rows.length };
  }), { swrMs: 30 * 60_000 });
}
