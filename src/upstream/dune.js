/**
 * Dune Analytics client. Execute-then-poll (~30 s wall). Degradable: throws
 * MissingSecretError with no network call when unconfigured. Long cache (30 min + SWR)
 * so only the first caller per window pays the poll (ARCHITECTURE §B/§G).
 * Secret header only on the Dune host; redirect:"error".
 */

import { fetchJson } from "./client.js";
import { getOrLoad } from "../cache.js";
import { config } from "../config.js";
import { DUNE_BASE } from "../lib/constants.js";
import { MissingSecretError, UpstreamError } from "../lib/errors.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function execute(queryId) {
  const headers = { "x-dune-api-key": config.duneKey, "Content-Type": "application/json" };

  const exec = await fetchJson(`${DUNE_BASE}/query/${queryId}/execute`, {
    source: "dune",
    timeout: 10_000,
    method: "POST",
    idempotent: true,
    retries: 1,
    redirect: "error",
    headers,
    body: { performance: "medium" },
  });
  const executionId = exec?.execution_id;
  if (!executionId) throw new UpstreamError("dune");

  for (let i = 0; i < 12; i++) {
    await sleep(2500);
    let data;
    try {
      data = await fetchJson(`${DUNE_BASE}/execution/${executionId}/results`, {
        source: "dune",
        timeout: 10_000,
        retries: 0,
        redirect: "error",
        headers: { "x-dune-api-key": config.duneKey },
      });
    } catch {
      continue; // transient poll error — keep waiting
    }
    if (data?.state === "QUERY_STATE_COMPLETED") return data.result?.rows || [];
    if (data?.state === "QUERY_STATE_FAILED") throw new UpstreamError("dune");
  }
  throw new UpstreamError("dune");
}

// async so the missing-secret case is a REJECTED promise (not a synchronous throw
// that would escape a surrounding Promise.allSettled in the services).
export async function duneExecute(queryId) {
  if (!config.duneKey) throw new MissingSecretError("dune");
  return getOrLoad(`dune:${queryId}`, 30 * 60_000, () => execute(queryId), { swrMs: 30 * 60_000 });
}
