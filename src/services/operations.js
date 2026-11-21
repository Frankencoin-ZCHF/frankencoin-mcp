import { ponderObservation } from "../upstream/ponder.js";
import { apiObservation } from "../upstream/frankencoin.js";
import { ValidationError, UpstreamError } from "../lib/errors.js";

// Fixed endpoints for protocol accounting. Never accept an upstream path from a client.
const reports = {
  amplifiers: "/amplifier/list",
  amplifier_positions: "/amplifier/positions/{address}",
  amplifier_activity: "/amplifier/activity/{address}",
  borrower_debt: "/positions/owner/{address}/debt",
  borrower_history: "/positions/owner/{address}/history",
  borrower_fees: "/positions/owner/{address}/fees",
  position_updates: "/positions/mintingupdates/position/{version}/{address}",
  savings_balance: "/savings/core/balance/{address}",
  savings_activity: "/savings/core/activity/{address}",
  referral_earnings: "/savings/referrer/{address}/earnings",
  referral_accounts: "/savings/referrer/{address}/mapping",
  equity_earnings: "/analytics/fps/earnings",
  equity_exposure: "/analytics/fps/exposure",
  revenue: "/analytics/mintingRevenue",
  collateral_stats: "/ecosystem/collateral/stats",
  bridge_lanes: "/bridge/chains",
  bridge_pending: "/bridge/proposals/pending",
  fcs_discount: "/fcs/discount",
  fcs_fees: "/fcs/fees",
  annual_share_report: "/reporting/fps/yearly",
};
export const reportKinds = [...Object.keys(reports), "position_lifecycle"];

// Operational APIs contain mixed schemas. Only known metric keys, addresses, timestamps,
// amounts and protocol enum values can cross this boundary; free-form strings are omitted.
import { metricKeys } from "./report-fields.js";
function project(v) {
  if (v === null || Number.isFinite(v) || typeof v === "boolean") return v;
  if (typeof v === "string") {
    if (
      /^(?:0x[\da-f]{40}|0x[\da-f]{64}|-?\d+(?:\.\d+)?|\d{4}-\d{2}-\d{2}|V1|V2|Profit|Loss|Challenge|ForcedSale|Deposit|Withdraw|Interest|Mint|Burn|Pending|Denied|Enacted|AddChain|RemotePoolUpdate|USDC|USDT)$/i.test(
        v,
      )
    )
      return v;
    return undefined;
  }
  if (Array.isArray(v)) return v.map(project).filter((x) => x !== undefined);
  if (typeof v !== "object") return undefined;
  return Object.fromEntries(
    Object.entries(v)
      .filter(([k]) => metricKeys.has(k) || /^(?:\d+|0x[\da-f]{40})$/i.test(k))
      .map(([k, x]) => [k, project(x)])
      .filter(([, x]) => x !== undefined),
  );
}
export async function operationReport({
  report,
  address,
  version,
  year,
  from,
  to,
  limit,
  offset,
}) {
  if (report === "position_lifecycle")
    return positionLifecycle({ address, version, from, to, limit, offset });
  let path = reports[report];
  if (path.includes("{address}") || report === "annual_share_report") {
    if (!address) throw new ValidationError("Supply address for this report");
    path = path.replace("{address}", address);
  }
  if (report === "position_updates" && !version)
    throw new ValidationError("Supply position version 1 or 2");
  path = path.replace("{version}", String(version));
  if (report === "annual_share_report")
    path += "?address=" + address + (year ? "&year=" + year : "");
  if (report === "amplifier_activity")
    path += `?offset=${offset}&limit=${limit}`;
  const { data, retrievedAt } = await apiObservation(path);
  if (data == null || typeof data !== "object")
    throw new UpstreamError("frankencoin");
  let result = project(data);
  const key = ["list", "days", "logs", "exposures"].find((k) =>
    Array.isArray(result[k]),
  );
  let list = key ? result[key] : Array.isArray(result) ? result : null;
  let page;
  if (from || to) {
    if (
      ![
        "revenue",
        "fcs_fees",
        "borrower_fees",
        "position_updates",
        "savings_activity",
      ].includes(report) ||
      !list
    )
      throw new ValidationError("This report has no filterable event window");
    list = list.filter((row) => {
      const t = Number(
        row.timestamp ?? row.created ?? row.t ?? Date.parse(row.date) / 1000,
      );
      return (!from || t >= from) && (!to || t < to);
    });
  }
  if (list && report !== "amplifier_activity") {
    page = {
      matchedInSource: list.length,
      offset,
      limit,
      nextOffset: offset + limit < list.length ? offset + limit : null,
    };
    const sliced = list.slice(offset, offset + limit);
    result = key ? { ...result, [key]: sliced } : sliced;
  }
  return {
    report,
    source: path,
    retrievedAt,
    page,
    data: result,
    scope:
      "Upstream accounting units and coverage apply. Collection filters restrict rows; source-wide totals retain their original scope.",
  };
}

async function positionLifecycle({
  address,
  version,
  from,
  to,
  limit,
  offset,
}) {
  if (!address || !version)
    throw new ValidationError("Supply a position address and version");
  const root =
    version === 1 ? "mintingHubV1PositionV1s" : "mintingHubV2PositionV2s";
  const available =
    version === 1 ? "availableForPosition" : "availableForMinting";
  const [state, history] = await Promise.all([
    ponderObservation(
      `{ position:${root}(where:{position:"${address}"},limit:1){items{position start expiration closed denied minted ${available}}} }`,
    ),
    operationReport({
      report: "position_updates",
      address,
      version,
      from,
      to,
      limit,
      offset,
    }),
  ]);
  const position = state.data?.position?.items?.[0];
  if (
    !Array.isArray(state.data?.position?.items) ||
    !Array.isArray(history.data?.list)
  )
    throw new UpstreamError("position");
  if (
    position &&
    (position.position?.toLowerCase() !== address ||
      !/^\d+$/.test(position.expiration) ||
      !/^\d+$/.test(position[available]) ||
      !/^\d+$/.test(position.minted))
  )
    throw new UpstreamError("position");
  const updates = history.data.list.map((r) => {
    if (
      r.position?.toLowerCase() !== address ||
      !/^-?\d+$/.test(r.mintedAdjusted) ||
      !/^\d{1,10}$/.test(r.created)
    )
      throw new UpstreamError("position");
    const delta = BigInt(r.mintedAdjusted);
    return {
      txHash: r.txHash,
      created: r.created,
      owner: r.owner,
      debtChangeRaw: r.mintedAdjusted,
      debtAfterRaw: r.minted,
      action:
        delta > 0n
          ? "loan_draw"
          : delta < 0n
            ? "loan_repayment"
            : "position_update",
      secondsBeforeCurrentRecordedExpiry:
        position && delta < 0n ? Number(position.expiration) - r.created : null,
    };
  });
  return {
    position: address,
    version,
    indexRetrievedAt: state.retrievedAt,
    historyRetrievedAt: history.retrievedAt,
    state: position
      ? {
          expiration: position.expiration,
          closed: position.closed,
          denied: position.denied,
          mintedRaw: position.minted,
          nominalCapacityRaw: position[available],
        }
      : null,
    updates,
    page: history.page,
    scope:
      "Expiry and nominal capacity reflect the current indexed position. A historical maturity amendment can change the interval relative to the original loan terms.",
  };
}
