/** Read-only Ethereum enrichment, with fixed-host failover and block evidence. */
import { fetchJson } from "./client.js";
import { getOrLoad } from "../cache.js";
import { ETH_RPC_FALLBACKS } from "../lib/constants.js";
import { UpstreamError } from "../lib/errors.js";
import { sourceTime } from "../lib/freshness.js";

const hex = (v) => typeof v === "string" && /^0x[0-9a-f]+$/i.test(v);
async function rpc(url, method, params) {
  const json = await fetchJson(url, { source: "eth", timeout: 8000, method: "POST", retries: 0,
    headers: { "Content-Type": "application/json" }, body: { jsonrpc: "2.0", id: 1, method, params } });
  if (json?.error || json?.result == null) throw new UpstreamError("eth");
  return json.result;
}
async function read(url, to, data) {
  const [chain, block] = await Promise.all([rpc(url, "eth_chainId", []), rpc(url, "eth_getBlockByNumber", ["latest", false])]);
  if (chain !== "0x1" || !hex(block?.number) || !/^0x[0-9a-f]{64}$/i.test(block?.hash) || !hex(block?.timestamp)) throw new UpstreamError("eth");
  const measuredAt = sourceTime(Number(BigInt(block.timestamp)));
  if (!measuredAt) throw new UpstreamError("eth");
  const value = await rpc(url, "eth_call", [{ to, data }, { blockHash: block.hash, requireCanonical: true }]);
  // ERC-20 uint256: empty/short/nonhex replies are not successful zero readings.
  if (!/^0x[0-9a-f]{64}$/i.test(value)) throw new UpstreamError("eth");
  return { value, blockNumber: BigInt(block.number).toString(), blockHash: block.hash, measuredAt, retrievedAt: new Date().toISOString(), rpc: url, chainId: 1 };
}
export function ethRead(to, data) {
  return getOrLoad(`eth-evidence:${to}:${data}`, 5 * 60_000, async () => {
    for (const url of ETH_RPC_FALLBACKS) { try { return await read(url, to, data); } catch { /* next fixed public RPC */ } }
    return null; // bounded negative cache prevents repeated failed provider probes
  });
}
export async function ethCall(to, data) { return (await ethRead(to, data))?.value ?? null; }
