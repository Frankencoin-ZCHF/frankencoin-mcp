import { ponderObservation } from "../upstream/ponder.js";
import { PONDER_BASE } from "../lib/constants.js";
import { UpstreamError, ValidationError } from "../lib/errors.js";

import { ledgerToken } from "./token-directory.js";
const ZERO = "0x0000000000000000000000000000000000000000";
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const UNIT = 10n ** 18n;

function units(amount) {
  const absolute = amount < 0n ? -amount : amount;
  const fraction = (absolute % UNIT).toString().padStart(18, "0").replace(/0+$/, "");
  return (amount < 0n ? "-" : "") + (absolute / UNIT) + (fraction ? "." + fraction : "");
}

export async function walletFlows({ wallet, days, limit, chainId=1 }) {
  if (typeof wallet !== "string" || !ADDRESS.test(wallet) || wallet === ZERO) {
    throw new ValidationError("wallet_flows requires a nonzero EVM wallet address");
  }
  const ZCHF=await ledgerToken(chainId,"ZCHF");
  wallet = wallet.toLowerCase();
  const end = Math.floor(Date.now() / 60000) * 60;
  const start = end - days * 86400;
  const filters = `chainId:${chainId},token:"${ZCHF}",amount_gt:"0",created_gte:"${start}",created_lt:"${end}"`;
  const peers = new Map();
  const directions = [
    { name: "incoming", match: "to", peer: "from", total: 0n, count: 0 },
    { name: "outgoing", match: "from", peer: "to", total: 0n, count: 0 },
  ];
  let retrievedAt;
  for (let page = 0; page < 5; page++) {
    const open = directions.filter(d => !d.done);
    const fields = open.map(d => {
      const after = d.cursor ? `,after:${JSON.stringify(d.cursor)}` : "";
      return `${d.name}:eRC20Balances(where:{${filters},${d.match}:"${wallet}",${d.peer}_not:"${wallet}"},limit:1000,orderBy:"created",orderDirection:"asc"${after}){items{${d.peer} amount} pageInfo{hasNextPage endCursor}}`;
    });
    const observation = await ponderObservation(`{ ${fields.join(" ")} }`);
    retrievedAt = observation.retrievedAt;
    for (const d of open) {
      const result = observation.data?.[d.name];
      if (!Array.isArray(result?.items) || typeof result.pageInfo?.hasNextPage !== "boolean") throw new UpstreamError("ponder");
      for (const row of result.items) {
        const peer = row?.[d.peer];
        if (typeof peer !== "string" || !ADDRESS.test(peer) || typeof row.amount !== "string" || !/^\d+$/.test(row.amount)) throw new UpstreamError("ponder");
        const address = peer.toLowerCase();
        const amounts = peers.get(address) ?? { incoming: 0n, outgoing: 0n };
        const amount = BigInt(row.amount);
        amounts[d.name] += amount;
        peers.set(address, amounts);
        d.total += amount;
        d.count++;
      }
      d.done = !result.pageInfo.hasNextPage;
      if (!d.done) {
        const cursor = result.pageInfo.endCursor;
        if (!result.items.length || typeof cursor !== "string" || !cursor || cursor.length > 2048 || d.cursor === cursor) throw new UpstreamError("ponder");
        d.cursor = cursor;
      }
    }
    if (directions.every(d => d.done)) break;
  }
  if (directions.some(d => !d.done)) throw new ValidationError("More than 5000 transfers in one direction. Use fewer days.");
  const [incoming, outgoing] = directions;
  const ranked = [...peers.entries()].sort(([a,x], [b,y]) => {
    const diff = (y.incoming + y.outgoing) - (x.incoming + x.outgoing);
    return diff === 0n ? a.localeCompare(b) : diff > 0n ? 1 : -1;
  });
  return {
    wallet, chainId, token: ZCHF, unit: "ZCHF", fromInclusive: new Date(start * 1000).toISOString(),
    untilExclusive: new Date(end * 1000).toISOString(), incomingZchf: units(incoming.total),
    outgoingZchf: units(outgoing.total), netZchf: units(incoming.total - outgoing.total),
    incomingTransfers: incoming.count, outgoingTransfers: outgoing.count,
    mintedToWalletZchf: units(peers.get(ZERO)?.incoming ?? 0n), burnedFromWalletZchf: units(peers.get(ZERO)?.outgoing ?? 0n),
    counterpartyCount: peers.size, counterparties: ranked.slice(0, limit).map(([address, x]) => ({
      address, incomingZchf: units(x.incoming), outgoingZchf: units(x.outgoing), netZchf: units(x.incoming - x.outgoing),
    })),
    source: { url: PONDER_BASE, retrievedAt, scope: "Indexed Ethereum ZCHF transfers excluding self-transfers. Counterparties ranked by gross volume. Mint and burn are included in totals. Transfers alone do not establish buys or sells. Indexer synchronization is unverified." },
  };
}
