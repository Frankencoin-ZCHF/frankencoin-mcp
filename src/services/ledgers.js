import { API_BASE } from "../lib/constants.js";
import { ledgerToken, ledgerDeployments } from "./token-directory.js";
import { fetchJson } from "../upstream/client.js";
import { getOrLoad } from "../cache.js";
import { ValidationError, UpstreamError } from "../lib/errors.js";

const address = /^0x[\da-f]{40}$/i;
const hash = /^0x[\da-f]{64}$/i;
// Positive field and value selection: upstream records can include identity annotations at every level.
function numbers(row, fields) {
  return Object.fromEntries(
    fields.map((k) => [k, Number.isFinite(row?.[k]) ? row[k] : null]),
  );
}
function addr(v) {
  if (typeof v !== "string" || !address.test(v))
    throw new UpstreamError("ledger");
  return v.toLowerCase();
}
function rows(v) {
  if (!Array.isArray(v)) throw new UpstreamError("ledger");
  return v;
}
function peer(p) {
  return {
    address: addr(p.address),
    ...numbers(p, ["amount", "count", "last"]),
  };
}
function transfer(t) {
  if (!hash.test(t.txHash)) throw new UpstreamError("ledger");
  return {
    txHash: t.txHash,
    from: addr(t.from),
    to: addr(t.to),
    ...numbers(t, ["t", "amount"]),
  };
}
export async function ledgerReport({
  view,
  chainId,
  asset,
  wallet,
  from,
  to,
  limit,
  offset,
}) {
  if (["wallet", "transfers", "journey", "portfolio"].includes(view) && !wallet)
    throw new ValidationError("A wallet address is required");
  if (view === "portfolio") {
    const chains =
      (await ledgerDeployments()).filter((d) => d.symbol === asset).map((d) => d.chainId);
    const balances = await Promise.all(
      chains.map(async (id) => {
        try {
          const report = await ledgerReport({
            view: "wallet",
            chainId: id,
            asset,
            wallet,
            limit: 1,
            offset: 0,
          });
          return {
            chainId: id,
            balance: report.data.balance,
            ledgerSyncedAt: report.ledgerSyncedAt,
            retrievedAt: report.retrievedAt,
          };
        } catch {
          return { chainId: id, balance: null };
        }
      }),
    );
    return {
      wallet,
      asset,
      balances,
      total: balances.length > 0 && balances.every((b) => Number.isFinite(b.balance))
        ? balances.reduce((s, b) => s + b.balance, 0)
        : null,
    };
  }
  const token = await ledgerToken(chainId, asset);
  const params = new URLSearchParams({ chainId: String(chainId), token });
  const walletPath = "/godeye/address/" + wallet;
  const paths = {
    graph: "/godeye/graph",
    holders: "/godeye/holders",
    timeline: "/godeye/timeline",
    wallet: walletPath,
    journey: walletPath + "/journey",
    transfers: walletPath + "/transfers",
  };
  if (view === "graph") {
    params.set("mode", "entities");
    params.set("top", String(Math.max(5, limit)));
    if (wallet) params.set("focus", wallet);
    if (to) params.set("at", String(to));
    if (from != null && to == null)
      throw new ValidationError("A graph window needs an end time");
    if (from != null) params.set("window", String(to - from));
  }
  if (view === "holders") {
    params.set("limit", String(limit));
    params.set("offset", String(offset));
    if (to) params.set("at", String(to));
  }
  if (view === "transfers") {
    if (from == null || to == null || from >= to || to - from > 365 * 86400)
      throw new ValidationError(
        "Supply from and to as increasing Unix seconds",
      );
    params.set("from", String(from));
    params.set("to", String(to));
  }
  const url = API_BASE + paths[view] + "?" + params;
  return getOrLoad(
    "ledger:" + url + ":" + [from, to, offset, limit].join(","),
    30_000,
    async () => {
      const raw = await fetchJson(url, { source: "ledger", timeout: 10000 });
      if (
        raw?.token &&
        (Number(raw.token.chainId) !== chainId ||
          addr(raw.token.token) !== token)
      )
        throw new UpstreamError("ledger");
      if (
        ["wallet", "transfers", "journey"].includes(view) &&
        (!raw?.token || !raw?.address)
      )
        throw new UpstreamError("ledger");
      if (raw?.address && addr(raw.address) !== wallet)
        throw new UpstreamError("ledger");
      let data;
      if (view === "graph") {
        const nodes = rows(raw.nodes).filter((r) => address.test(r.id));
        const ids = new Set(nodes.map((r) => addr(r.id)));
        data = {
          ...numbers(raw, ["at", "from", "supply", "holders"]),
          nodes: nodes.map((r) => ({
            address: addr(r.id),
            ...numbers(r, ["balance", "share", "inflow", "outflow", "txs"]),
          })),
          edges: rows(raw.edges)
            .filter(
              (r) =>
                address.test(r.s) &&
                address.test(r.t) &&
                ids.has(r.s.toLowerCase()) &&
                ids.has(r.t.toLowerCase()),
            )
            .map((r) => ({
              from: addr(r.s),
              to: addr(r.t),
              ...numbers(r, ["amount", "count"]),
            })),
        };
      } else if (view === "holders") {
        data = {
          ...numbers(raw, [
            "at",
            "supply",
            "holders",
            "top1",
            "top10",
            "top100",
            "total",
          ]),
          holdersPage: rows(raw.list).map((r) => ({
            address: addr(r.address),
            ...numbers(r, ["balance", "share", "since"]),
          })),
          offset,
        };
      } else if (view === "wallet") {
        data = {
          wallet,
          ...numbers(raw, [
            "balance",
            "share",
            "inflow",
            "outflow",
            "minted",
            "burned",
            "txs",
            "first",
            "last",
          ]),
          sources: rows(raw.sources).slice(0, limit).map(peer),
          destinations: rows(raw.destinations).slice(0, limit).map(peer),
        };
      } else if (view === "transfers") {
        data = {
          from,
          to,
          sourceTruncated: raw.more === true,
          offset,
          totalReturnedBySource: rows(raw.transfers).length,
          transfers: raw.transfers.slice(offset, offset + limit).map(transfer),
        };
      } else {
        const history = rows(view === "timeline" ? raw : raw.days)
          .filter((r) => (!from || r.t >= from) && (!to || r.t < to))
          .sort((a, b) => b.t - a.t);
        const fields =
          view === "timeline"
            ? [
                "t",
                "supply",
                "holders",
                "volume",
                "minted",
                "burned",
                "transfers",
              ]
            : ["t", "in", "out", "txs", "balance"];
        data = {
          total: history.length,
          offset,
          days: history
            .slice(offset, offset + limit)
            .map((r) => numbers(r, fields)),
        };
      }
      return {
        chainId,
        asset,
        token,
        ledgerSyncedAt: Number.isFinite(raw?.token?.syncedAt)
          ? raw.token.syncedAt
          : null,
        retrievedAt: new Date().toISOString(),
        data,
      };
    },
  );
}
