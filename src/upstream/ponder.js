/**
 * Ponder GraphQL client (ponder.frankencoin.com). No auth. POST { query }.
 * Host is hard-pinned to PONDER_BASE — the client supplies only the query STRING,
 * never a URL/host/header (SECURITY §2.5). Cached by query hash.
 */

import { createHash } from "node:crypto";
import { fetchJson } from "./client.js";
import { getOrLoad } from "../cache.js";
import { PONDER_BASE } from "../lib/constants.js";
import { UpstreamError } from "../lib/errors.js";

function hash(query) {
  return createHash("sha1").update(query).digest("hex");
}

async function run(query) {
  const json = await fetchJson(PONDER_BASE, {
    source: "ponder",
    timeout: 15_000,
    method: "POST",
    idempotent: true, // a GraphQL query is read-only/idempotent
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: { query },
  });
  // GraphQL-level errors: never relay upstream text (SECURITY §5.1).
  if (json?.errors?.length) throw new UpstreamError("ponder");
  return json.data;
}

/**
 * Execute a GraphQL query against Ponder.
 * @param {string} query
 * @param {number} [ttl] cache TTL ms (45 s for internal service queries, 20 s for user query_ponder)
 */
export function ponderQuery(query, ttl = 45_000) {
  return getOrLoad(`ponder:${hash(query)}`, ttl, () => run(query));
}
