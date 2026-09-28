/** FCS enrichment, shared by governance and snapshot; never relabels FPS metrics. */
import { apiFetch } from "../upstream/frankencoin.js";
import { API_BASE } from "../lib/constants.js";
import { FCS_REFERENCE } from "../lib/fcs.js";

const scaledNumber = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

export async function getFcs() {
  const data = await apiFetch("/fcs/info").catch(() => null);
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
  const bid = scaledNumber(token?.bid) > 0 ? token.bid : null;
  const fields = [totalSupply, totalAssetsZchf, isBinding, ask, bid];
  const status = fields.every((v) => v !== null) ? "available"
    : fields.some((v) => v !== null) ? "partial" : "unavailable";
  return {
    ...FCS_REFERENCE,
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
        blockNumber: null,
        updatedAt: null,
        note: "The API exposes neither a source block nor an update timestamp; freshness and a same-block snapshot cannot be established. Values are already scaled, not wei.",
      },
      notProvided: ["internalFcsVotes", "holderVotesAndDelegation", "wrapperHeldFps", "wrapperFpsVotes", "underlyingQuorum", "redemptionEligibility"],
      note: "API-reported FCS state, not an independent RPC verification. Votes, backing balance and eligibility require contract reads; do not infer them from supply or binding. Reference prices are ZCHF per FCS, not market quotes or size-specific previews; fees and price impact apply." +
        (status === "unavailable" ? " FCS state unavailable: source failed or returned unverified identity/units or invalid fields." : "") +
        (status === "partial" ? " Some FCS fields are unavailable; null does not mean zero or false." : "") +
        (token?.bid === 0 ? " The API bid value 0 can mean a failed read; exposed as null, not a quote." : ""),
    },
  };
}
