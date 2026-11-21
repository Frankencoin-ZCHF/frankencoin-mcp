import { getOrLoad } from "../cache.js";
import { fetchJson } from "../upstream/client.js";
import { UpstreamError } from "../lib/errors.js";
import { pools } from "./pools.js";
import { ledgerToken } from "./ledgers.js";

const hosts = {
  1: "ethereum",
  10: "optimism",
  100: "gnosis",
  137: "polygon-bor",
  146: "sonic",
  8453: "base",
  42161: "arbitrum-one",
  43114: "avalanche-c-chain",
};
const addr = /^0x[\da-f]{40}$/i,
  hash = /^0x[\da-f]{64}$/i,
  uint = /^0x[\da-f]+$/i;
const swapV3 =
  "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const swapV2 =
  "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const transfer =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export async function transactionReceipt({ chainId, asset, txHash }) {
  const token = ledgerToken(chainId, asset);
  const rpc = async (method, params) => {
    const json = await fetchJson(
      "https://" + hosts[chainId] + "-rpc.publicnode.com",
      {
        method: "POST",
        source: "receipt",
        timeout: 4500,
        retries: 0,
        body: { jsonrpc: "2.0", id: 1, method, params },
        headers: { "Content-Type": "application/json" },
      },
    );
    if (json?.error || json?.result == null) throw new UpstreamError("receipt");
    return json.result;
  };
  return getOrLoad(
    "receipt:" + chainId + ":" + asset + ":" + txHash,
    15_000,
    async () => {
      const [network, r] = await Promise.all([
        rpc("eth_chainId", []),
        rpc("eth_getTransactionReceipt", [txHash]),
      ]);
      if (
        network !== "0x" + chainId.toString(16) ||
        r.transactionHash?.toLowerCase() !== txHash ||
        !addr.test(r.from) ||
        !hash.test(r.blockHash) ||
        !uint.test(r.blockNumber) ||
        !["0x0", "0x1"].includes(r.status) ||
        !Array.isArray(r.logs)
      )
        throw new UpstreamError("receipt");
      const block = await rpc("eth_getBlockByNumber", [r.blockNumber, false]);
      if (block?.hash !== r.blockHash) throw new UpstreamError("receipt");
      const transfers = [],
        possible = [];
      for (const log of r.logs) {
        if (
          log.removed ||
          !addr.test(log.address) ||
          !Array.isArray(log.topics) ||
          !uint.test(log.logIndex)
        )
          throw new UpstreamError("receipt");
        const emitter = log.address.toLowerCase(),
          event = log.topics[0]?.toLowerCase();
        if (emitter === token && event === transfer) {
          if (
            log.topics.length !== 3 ||
            !log.topics
              .slice(1)
              .every((t) => /^0x0{24}[\da-f]{40}$/i.test(t)) ||
            !hash.test(log.data)
          )
            throw new UpstreamError("receipt");
          transfers.push({
            from: "0x" + log.topics[1].slice(-40),
            to: "0x" + log.topics[2].slice(-40),
            amountRaw: BigInt(log.data).toString(),
            logIndex: log.logIndex,
          });
        }
        if (
          [swapV3, swapV2].includes(event) &&
          log.topics.length === 3 &&
          typeof log.data === "string" &&
          new RegExp(
            "^0x[0-9a-f]{" + (event === swapV3 ? 320 : 256) + "}$",
            "i",
          ).test(log.data)
        ) {
          possible.push({
            pool: emitter,
            logIndex: log.logIndex,
            format: event === swapV3 ? "v3" : "v2",
          });
        }
      }
      let listedSwaps = [],
        poolCoverage = "not_needed";
      if (possible.length) {
        try {
          const catalogue = await pools({ chainId, asset });
          const ids = new Set(catalogue.pools.map((p) => p.poolId));
          listedSwaps = possible.filter((row) => ids.has(row.pool));
          poolCoverage = "provider_listed_pools";
        } catch {
          poolCoverage = "unavailable";
        }
      }
      return {
        status: r.status === "0x1" ? "success" : "reverted",
        from: r.from,
        blockNumber: BigInt(r.blockNumber).toString(),
        blockHash: r.blockHash,
        transfers,
        listedSwaps,
        poolCoverage,
        retrievedAt: new Date().toISOString(),
        scope:
          "Canonical block at lookup time. Swap evidence covers V2/V3-format events from provider-listed pools for the selected asset. Transaction sender and ultimate trader may differ.",
      };
    },
  );
}
