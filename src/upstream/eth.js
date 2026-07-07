/**
 * Ethereum JSON-RPC client (public llamarpc). Used only for CHFAU totalSupply().
 * Cached 5 min. Best-effort — callers treat failure as null.
 */

import { fetchJson } from "./client.js";
import { getOrLoad } from "../cache.js";
import { ETH_RPC } from "../lib/constants.js";
import { UpstreamError } from "../lib/errors.js";

async function call(to, data) {
  const json = await fetchJson(ETH_RPC, {
    source: "eth",
    timeout: 6_000,
    method: "POST",
    // Best-effort enrichment against a flaky public RPC: do NOT retry. Retrying a
    // stalling keep-alive socket was compounding into multi-second hangs on the
    // critical path of get_market_data.
    idempotent: false,
    retries: 0,
    headers: { "Content-Type": "application/json" },
    body: { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] },
  });
  if (json?.error) throw new UpstreamError("eth");
  return json.result;
}

export function ethCall(to, data) {
  // Negative-cache: on failure resolve to null (cached like any value) so a down RPC
  // costs one bounded attempt per TTL window, not one per request. Callers already
  // treat null as "supply unavailable".
  return getOrLoad(`eth:${to}:${data}`, 5 * 60_000, async () => {
    try {
      return await call(to, data);
    } catch {
      return null;
    }
  });
}
