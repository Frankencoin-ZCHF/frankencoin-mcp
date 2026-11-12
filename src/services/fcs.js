/** FCS enrichment, shared by governance and snapshot; never relabels FPS metrics. */
import { apiObservation } from "../upstream/frankencoin.js";
import { API_BASE } from "../lib/constants.js";
import { FCS_REFERENCE, fcsContext } from "../lib/fcs.js";
import { freshness, sourceTime } from "../lib/freshness.js";

const scaledNumber = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

export async function getFcs({ includeContext = false } = {}) {
  const observation = await apiObservation("/fcs/info").catch(() => null);
  const data = observation?.data;
  // Validate identity and units BEFORE accepting any metrics. Never trust a ticker
  // alone or silently switch deployments if the upstream controller changes.
  const matches = data?.chain?.chainId === 1 && data?.erc20?.decimals === 18 &&
    typeof data.chain.address === "string" && /^0x[\da-fA-F]{40}$/.test(data.chain.address) &&
    data.chain.address.toLowerCase() === FCS_REFERENCE.address;
  const token = matches ? data.token : null;
  const totalSupply = scaledNumber(token?.totalSupply);
  const totalAssetsZchf = scaledNumber(token?.totalAssets);
  const isBinding = typeof token?.isBinding === "boolean" ? token.isBinding : null;
  const ask = scaledNumber(token?.ask);
  // Documented API fallback: bid() failure is returned as 0. That ambiguous
  // sentinel must not be presented as a verified zero quote.
  const bid = data?.metadata?.readStatus?.bid === "available" ? scaledNumber(token?.bid)
    : data?.metadata?.readStatus?.bid === "fallback" ? null : scaledNumber(token?.bid) > 0 ? token.bid : null;
  const meta = matches ? data.metadata : null;
  const measuredAt = sourceTime(meta?.blockTimestamp);
  const sameBlock = meta?.sameBlock === true && typeof meta.blockNumber === "string" && /^[1-9]\d*$/.test(meta.blockNumber) && /^0x[\da-f]{64}$/i.test(meta.blockHash) && measuredAt != null;
  const quality = freshness(sameBlock ? measuredAt : null, 600);
  const fields = [totalSupply, totalAssetsZchf, isBinding, ask, bid];
  const status = fields.every((v) => v !== null) ? "available"
    : fields.some((v) => v !== null) ? "partial" : "unavailable";
  return {
    ...fcsContext(includeContext),
    state: {
      status,
      totalSupply,
      totalAssetsZchf,
      isBinding,
      referencePriceZchf: { ask, bid },
      source: {
        kind: "api_reported_contract_reads",
        url: `${API_BASE}/fcs/info`,
        cacheSeconds: 30,
        blockNumber: sameBlock ? meta.blockNumber : null,
        blockHash: sameBlock ? meta.blockHash : null,
        measuredAt: sameBlock ? measuredAt : null,
        updatedAt: sameBlock ? sourceTime(meta.fetchedAt) : null,
        retrievedAt: observation?.retrievedAt ?? null,
        sameBlock: Boolean(sameBlock),
        freshness: quality,
        note: sameBlock ? "Upstream reports contract reads pinned to this Ethereum block and verifies its hash after reading. This MCP has not independently verified those reads. measuredAt is block time; updatedAt is upstream fetch completion; retrievedAt is this server's actual HTTP fetch time (retained through cache hits)."
          : "Source block/time unavailable or invalid; measurement freshness and a same-block snapshot cannot be established. retrievedAt is HTTP retrieval time, not measurement time. Values are already scaled, not wei.",
      },
      notProvided: ["internalFcsVotes", "holderVotesAndDelegation", "wrapperHeldFps", "wrapperFpsVotes", "underlyingQuorum", "redemptionEligibility"],
      note: "API-reported FCS state, not an independent RPC verification. Votes, backing balance and eligibility require contract reads; do not infer them from supply or binding. Reference prices are ZCHF per FCS, not market quotes or size-specific previews; fees and price impact apply." +
        (status === "unavailable" ? " FCS state unavailable: source failed or returned unverified identity/units or invalid fields." : "") +
        (status === "partial" ? " Some FCS fields are unavailable; null does not mean zero or false." : "") +
        (token?.bid === 0 && bid === null ? " The API bid value 0 can mean a failed read; exposed as null, not a quote." : "") +
        (quality.status === "stale" ? " The source block is older than the 10-minute freshness budget." : ""),
    },
  };
}
