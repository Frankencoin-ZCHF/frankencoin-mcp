/** Explicitly scoped indexer alternatives, never relabelled as Dune results. */
import { ponderObservation } from "../upstream/ponder.js";
import { FPS_CONTRACT, PONDER_BASE } from "../lib/constants.js";
import { UpstreamError } from "../lib/errors.js";
import { sourceTime, freshness } from "../lib/freshness.js";
const ZCHF = "0xb58e61c3098d85632df34eecfb899a1ed80921cb";
const ZERO = "0x0000000000000000000000000000000000000000";
const uint = (x) => typeof x === "string" && /^\d+$/.test(x);
const invalid = () => { throw new UpstreamError("ponder"); };
export async function indexedMetric(name) {
  let rows, observation, asOf = null, scope, sourceDetails = {};
  if (name.endsWith("Holders")) {
    const token = name === "zchfHolders" ? ZCHF : FPS_CONTRACT.toLowerCase();
    observation = await ponderObservation(`{ metric:eRC20BalanceMappings(where:{chainId:1,token:"${token}",balance_gt:"0",account_not:"${ZERO}"},limit:1,orderBy:"updated",orderDirection:"desc"){totalCount items{updated}} }`);
    const m = observation.data?.metric;
    if (!Number.isSafeInteger(m?.totalCount) || m.totalCount < 0) invalid();
    rows = [{ holders: m.totalCount }];
    scope = "Ethereum addresses with positive indexed token balance, excluding the zero address; includes contracts, not unique people or cross-chain holders. Indexer completeness is not independently verified.";
    sourceDetails = { chainId: 1, token, lastActivityAt: sourceTime(Number(m.items?.[0]?.updated)), freshnessNote: "Last token activity is not the indexer's synchronization time. No measured-at block or sync watermark is supplied; freshness is unknown." };
  } else if (name === "savingsTvl") {
    observation = await ponderObservation(`{ metric:analyticDailyLogs(limit:30,orderBy:"timestamp",orderDirection:"desc"){items{date timestamp totalSavings}} }`);
    const items = observation.data?.metric?.items;
    if (!Array.isArray(items) || !items.length || items.some((x) => !uint(x.totalSavings) || !sourceTime(Number(x.timestamp)) || !/^\d{4}-\d{2}-\d{2}$/.test(x.date))) invalid();
    rows = items.map((x) => ({ date: x.date, tvlZchf: Number(BigInt(x.totalSavings)) / 1e18, raw: x.totalSavings }));
    asOf = sourceTime(Math.max(...items.map((x) => Number(x.timestamp))));
    scope = "Last 30 indexer daily totalSavings observations, in ZCHF (18 decimals). A daily timestamp identifies its bucket, not an independently verified block time.";
  } else {
    const since = Math.floor(Date.now() / 86400000) * 86400 - 29 * 86400;
    const groups = new Map(); let after = null, done = false, count = 0;
    for (let page = 0; page < 10; page++) {
      observation = await ponderObservation(`{ metric:eRC20Balances(where:{chainId:1,token:"${ZCHF}",from:"${ZERO}",created_gte:"${since}",amount_gt:"0"},limit:1000,orderBy:"created",orderDirection:"asc"${after ? `,after:${JSON.stringify(after)}` : ""}){items{created amount blockheight} pageInfo{hasNextPage endCursor}} }`);
      const m = observation.data?.metric;
      if (!Array.isArray(m?.items) || typeof m.pageInfo?.hasNextPage !== "boolean") invalid();
      for (const x of m.items) {
        if (!uint(x.amount) || !uint(x.blockheight) || !uint(x.created) || Number(x.created) < since || !sourceTime(Number(x.created))) invalid();
        const date = sourceTime(Number(x.created)).slice(0, 10);
        const g = groups.get(date) ?? { amount: 0n, count: 0 };
        g.amount += BigInt(x.amount); g.count++; count++; groups.set(date, g);
      }
      if (!m.pageInfo.hasNextPage) { done = true; break; }
      const next = m.pageInfo.endCursor;
      if (typeof next !== "string" || !next || next === after || next.length > 2048) invalid();
      after = next;
    }
    if (!done) invalid(); // never publish a truncated sum
    rows = [...groups].sort(([a], [b]) => b.localeCompare(a)).map(([date, g]) => ({ date, mintedZchf: Number(g.amount) / 1e18, raw: g.amount.toString(), events: g.count }));
    scope = "Gross Ethereum ZCHF Transfer events from the zero address over 30 UTC calendar days, including the incomplete current day; all mint sources, not net issuance or borrowing volume. Only days with indexed mint events appear. No cross-chain or indexer completeness guarantee.";
    sourceDetails = { chainId: 1, token: ZCHF, windowStart: new Date(since * 1000).toISOString(), events: count, freshnessNote: "No indexer sync watermark; an empty event set does not establish zero real-world issuance." };
  }
  return { rows, source: { provider: "Frankencoin Ponder", url: PONDER_BASE, scope, ...sourceDetails,
    asOf, retrievedAt: observation.retrievedAt, freshness: freshness(asOf, 48 * 3600) } };
}
