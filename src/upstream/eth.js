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
    timeout: 8_000,
    method: "POST",
    idempotent: true,
    headers: { "Content-Type": "application/json" },
    body: { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] },
  });
  if (json?.error) throw new UpstreamError("eth");
  return json.result;
}

export function ethCall(to, data) {
  return getOrLoad(`eth:${to}:${data}`, 5 * 60_000, () => call(to, data));
}
