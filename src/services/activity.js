import { transactionReceipt } from "./receipt.js";
import { ponderObservation } from "../upstream/ponder.js";
import { UpstreamError, ValidationError } from "../lib/errors.js";
import { ledgerToken } from "./token-directory.js";

const ZERO = "0x" + "0".repeat(40);
// Each entry names a verified indexer table and the fields required to interpret one event.
const feeds = {
  transfers: [
    "eRC20Balances",
    "chainId token from to amount blockheight",
    true,
  ],
  loans_v1: [
    "mintingHubV1MintingUpdateV1s",
    "position owner collateral minted mintedAdjusted feePaid",
  ],
  loans_v2: [
    "mintingHubV2MintingUpdateV2s",
    "position owner collateral minted mintedAdjusted feePaid",
  ],
  savings: [
    "savingsActivitys",
    "chainId account module kind amount balance",
    true,
  ],
  fcs_deposit: ["fCSDeposits", "sender owner assets shares"],
  fcs_withdraw: ["fCSWithdraws", "sender receiver owner assets shares"],
  fcs_wrap: ["fCSWrappeds", "who amount"],
  fcs_unwrap: ["fCSUnwrappeds", "who amount"],
  equity: ["equityTrades", "kind trader shares amount price"],
  amplifier: [
    "amplifierActivitys",
    "chainId amplifier position kind liquidity token0 token1 zchf totalBorrowed",
    true,
  ],
  votes_destroyed: ["fCSShots", "target votesDestroyed"],
  votes_sent: ["mainnetVotesSynceds", "targetChain receiver"],
  votes_received: [
    "bridgedVotesReceiveds",
    "chainId messageId sourceChain totalVotes",
    true,
  ],
};
export const activityKinds = Object.keys(feeds);
const addresses = new Set(
  "token from to owner position collateral account module sender receiver who trader amplifier target".split(
    " ",
  ),
);
const hashes = new Set(["txHash", "messageId"]);
function eventRow(name, raw) {
  const fields = ["created", "txHash", ...feeds[name][1].split(" ")];
  const row = {};
  for (const key of fields) {
    const value = raw?.[key];
    if (key === "kind") {
      row.kind = [
        "Mint",
        "Burn",
        "Deposit",
        "Withdraw",
        "Interest",
        "Invest",
        "Redeem",
        "Saved",
        "Withdrawn",
        "InterestCollected",
        "Trade",
        "Invested",
        "Redeemed",
      ].some((k) => k.toLowerCase() === String(value).toLowerCase())
        ? value
        : null;
      continue;
    }
    const pattern = addresses.has(key)
      ? /^0x[\da-f]{40}$/i
      : hashes.has(key)
        ? /^0x[\da-f]{64}$/i
        : /^-?\d{1,78}$/;
    if (
      !(typeof value === "string" || Number.isSafeInteger(value)) ||
      !pattern.test(value)
    )
      throw new UpstreamError("ponder");
    row[key] = value;
  }
  return { ...row, action: action(name, row) };
}
function action(name, row) {
  if (name === "transfers")
    return row.from === ZERO
      ? "token_mint"
      : row.to === ZERO
        ? "token_burn"
        : "transfer";
  if (name.startsWith("loans_")) {
    if (!/^-?\d+$/.test(row.mintedAdjusted)) throw new UpstreamError("ponder");
    const delta = BigInt(row.mintedAdjusted);
    return delta > 0n
      ? "loan_draw"
      : delta < 0n
        ? "loan_repayment"
        : "position_update";
  }
  return name;
}
export async function activity({
  view,
  kind,
  chainId,
  asset,
  txHash,
  from,
  to,
  limit,
  after,
}) {
  if (view === "transaction" && !txHash)
    throw new ValidationError("Supply txHash");
  if (after && view === "changes")
    throw new ValidationError("Use a cursor with an individual events feed");
  if (view !== "transaction" && (from == null || to == null || from >= to))
    throw new ValidationError(
      "Supply an increasing time window in Unix seconds",
    );
  const names =
    view === "events" || (view === "transaction" && after)
      ? [kind]
      : activityKinds.filter((k) => chainId === 1 || feeds[k][2]);
  const token = names.includes("transfers") ? await ledgerToken(chainId, asset) : null;
  const parts = names.map((name) => {
    const [table, fields, multichain] = feeds[name];
    if (!multichain && chainId !== 1)
      throw new ValidationError("This event feed is Ethereum only");
    const where =
      view === "transaction"
        ? [`txHash:${JSON.stringify(txHash)}`]
        : [`created_gte:"${from}",created_lt:"${to}"`];
    if (multichain) where.push(`chainId:${chainId}`);
    if (name === "transfers")
      where.push(`token:"${token}"`);
    const order =
      view !== "transaction" && name === "transfers" ? "amount" : "created";
    return `${name}:${table}(where:{${where.join(",")}},limit:${limit},orderBy:"${order}",orderDirection:"desc"${after ? ",after:" + JSON.stringify(after) : ""}){items{created txHash ${fields}} pageInfo{hasNextPage endCursor}}`;
  });
  const indexed = ponderObservation("{" + parts.join(" ") + "}").then(
    ({ data, retrievedAt }) => {
      const sections = Object.fromEntries(
        names.map((name) => {
          const page = data?.[name];
          if (
            !Array.isArray(page?.items) ||
            typeof page.pageInfo?.hasNextPage !== "boolean"
          )
            throw new UpstreamError("ponder");
          if (
            page.items.length > limit ||
            (page.pageInfo.hasNextPage &&
              (!page.items.length ||
                typeof page.pageInfo.endCursor !== "string" ||
                !page.pageInfo.endCursor ||
                page.pageInfo.endCursor.length > 2000 ||
                page.pageInfo.endCursor === after))
          )
            throw new UpstreamError("ponder");
          return [
            name,
            {
              events: page.items.map((raw) => {
                const row = eventRow(name, raw);
                if (
                  (view === "transaction" &&
                    row.txHash.toLowerCase() !== txHash) ||
                  (row.chainId != null && Number(row.chainId) !== chainId) ||
                  (name === "transfers" &&
                    row.token.toLowerCase() !== token) ||
                  (view !== "transaction" &&
                    (Number(row.created) < from || Number(row.created) >= to))
                )
                  throw new UpstreamError("ponder");
                return row;
              }),
              hasMore: page.pageInfo.hasNextPage,
              nextCursor: page.pageInfo.hasNextPage
                ? page.pageInfo.endCursor
                : null,
            },
          ];
        }),
      );
      return { sections, retrievedAt };
    },
  );
  let receipt, observation;
  if (view === "transaction") {
    const [index, rpc] = await Promise.allSettled([
      indexed,
      transactionReceipt({ chainId, asset, txHash }),
    ]);
    receipt =
      rpc.status === "fulfilled" ? rpc.value : { status: "unavailable" };
    if (index.status === "rejected") {
      if (rpc.status === "rejected") throw index.reason;
      return {
        chainId,
        asset,
        txHash,
        receipt,
        indexStatus: "unavailable",
        sections: null,
      };
    }
    observation = index.value;
  } else observation = await indexed;
  const { sections, retrievedAt } = observation;
  return {
    chainId,
    asset,
    txHash,
    from,
    to,
    retrievedAt,
    receipt,
    indexStatus: "available",
    coveredFeeds: names,
    sections,
    scope:
      "Indexed event evidence. Amounts are raw contract units. Several logs may describe the same action. Transfers do not establish a trade. Changes ranks transfers by amount and other feeds by time; paginated sections are not totals.",
  };
}
