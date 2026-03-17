#!/usr/bin/env node
/**
 * Frankencoin CLI — direct access to all 13 consolidated tools.
 *
 * Usage:
 *   frankencoin <command> [options]
 *   frankencoin --help
 *
 * Examples:
 *   frankencoin snapshot
 *   frankencoin market
 *   frankencoin savings
 *   frankencoin positions --detail --limit 10
 *   frankencoin challenges --active
 *   frankencoin analytics --type time_series --days 30
 *   frankencoin knowledge --topic faq
 *   frankencoin ponder '{ mintingHubV2PositionV2s(limit:5) { items { position owner minted } } }'
 */

import * as api from "./api.js";

// ─── ANSI colours ─────────────────────────────────────────────────────────────

const NO_COLOR = process.env.NO_COLOR || !process.stdout.isTTY;
const c = {
  bold:   (s) => NO_COLOR ? s : `\x1b[1m${s}\x1b[0m`,
  dim:    (s) => NO_COLOR ? s : `\x1b[2m${s}\x1b[0m`,
  cyan:   (s) => NO_COLOR ? s : `\x1b[36m${s}\x1b[0m`,
  green:  (s) => NO_COLOR ? s : `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => NO_COLOR ? s : `\x1b[33m${s}\x1b[0m`,
  red:    (s) => NO_COLOR ? s : `\x1b[31m${s}\x1b[0m`,
};

// ─── Argument parsing ─────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args.flags[key] = next;
        i++;
      } else {
        args.flags[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtNum(n, dec = 2) {
  if (n == null || isNaN(n)) return "—";
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function fmtM(n) {
  if (n == null || isNaN(n)) return "—";
  return `${fmtNum(Number(n) / 1e6)}M`;
}

function section(title) {
  console.log("\n" + c.bold(c.cyan(`● ${title}`)));
}

// ─── Command handlers — one per consolidated tool ─────────────────────────────

const COMMANDS = {
  snapshot: {
    desc: "Full protocol snapshot — supply, FPS, TVL, savings, challenges",
    help: "frankencoin snapshot [--json]",
    async run(flags) {
      const d = await api.getProtocolSnapshot();
      if (flags.json) return console.log(JSON.stringify(d, null, 2));

      section("Protocol Snapshot");
      console.log(`  ZCHF Supply     ${c.green(fmtM(d.zchf?.totalSupply))}`);
      console.log(`  TVL             ${c.green(fmtM(d.zchf?.tvl?.chf))} CHF`);
      console.log(`  FPS Price       ${c.yellow(fmtNum(d.fps?.priceChf))} CHF`);
      console.log(`  FPS Market Cap  ${c.yellow(fmtM(d.fps?.marketCapChf))} CHF`);
      console.log(`  Equity Reserve  ${c.yellow(fmtM(d.fps?.reserve?.equityChf))} CHF`);
      console.log(`  Net Earnings    ${c.yellow(fmtNum(d.fps?.earnings?.netChf))} CHF`);
      console.log(`  Savings Rate    ${c.cyan(fmtNum(d.savings?.leadRatePercent))}%`);
      console.log(`  Savings TVL     ${c.cyan(fmtM(d.savings?.totalDepositedChf))} ZCHF`);
      console.log(`  Challenges      ${d.challenges?.active > 0 ? c.red(String(d.challenges.active)) : c.green("0")} active`);
    },
  },

  market: {
    desc: "Market data — prices, peg health, CHF stablecoin comparison, macro",
    help: "frankencoin market [--json]",
    async run(flags) {
      const d = await api.getMarketData();
      if (flags.json) return console.log(JSON.stringify(d, null, 2));

      section("ZCHF Peg Health");
      console.log(`  Price           ${c.green(fmtNum(d.zchf?.priceChf, 4))} CHF`);
      console.log(`  Peg Deviation   ${fmtNum(d.zchf?.pegDeviationPercent, 4)}%`);
      console.log(`  Status          ${d.zchf?.pegStatus === "healthy" ? c.green("healthy") : c.yellow(d.zchf?.pegStatus)}`);

      section("CHF Stablecoins");
      for (const sc of (d.chfStablecoins || [])) {
        console.log(`  ${c.bold(sc.symbol.padEnd(8))} ${sc.priceChf != null ? fmtNum(sc.priceChf, 4) + " CHF" : "—"}  mcap: ${sc.marketCapChf != null ? fmtM(sc.marketCapChf) : "—"}  supply: ${sc.circulatingSupply != null ? fmtNum(sc.circulatingSupply, 0) : "—"}`);
      }

      section("Macro");
      console.log(`  BTC             ${c.yellow(fmtNum(d.macro?.bitcoin?.priceUsd))} USD  (${fmtNum(d.macro?.bitcoin?.change24hPercent)}% 24h)`);
      console.log(`  ETH             ${c.yellow(fmtNum(d.macro?.ethereum?.priceUsd))} USD  (${fmtNum(d.macro?.ethereum?.change24hPercent)}% 24h)`);
    },
  },

  savings: {
    desc: "Savings rates + TVL + module stats",
    help: "frankencoin savings [--json]",
    async run(flags) {
      const d = await api.getSavings();
      if (flags.json) return console.log(JSON.stringify(d, null, 2));

      section("Savings Overview");
      console.log(`  Total Deposited ${c.green(fmtM(d.summary?.totalDepositedChf))} ZCHF`);
      console.log(`  Total Interest  ${c.green(fmtM(d.summary?.totalInterestPaidChf))} ZCHF`);
      console.log(`  Pending Changes ${d.summary?.pendingRateChanges || 0}`);

      section("Approved Rates");
      for (const r of (d.rates?.approved || [])) {
        console.log(`  ${r.chainName.padEnd(12)} ${r.module.slice(0, 10)}…  ${c.cyan(fmtNum(r.ratePercent))}%`);
      }
    },
  },

  governance: {
    desc: "Governance — rate proposals, minters, FPS trades, holders",
    help: "frankencoin governance [--type all|rate_proposals|minters|equity_trades|holders] [--status active|denied|all] [--limit N] [--json]",
    async run(flags) {
      const d = await api.getGovernance({
        type: flags.type ?? "all",
        status: flags.status ?? "all",
        limit: parseInt(flags.limit ?? "20", 10),
      });
      if (flags.json) return console.log(JSON.stringify(d, null, 2));
      console.log(JSON.stringify(d, null, 2));
    },
  },

  positions: {
    desc: "Minting positions (--detail for full data)",
    help: "frankencoin positions [--detail] [--limit N] [--active] [--collateral 0x...] [--json]",
    async run(flags) {
      const d = await api.getPositions({
        detail: !!flags.detail,
        limit: flags.limit ? parseInt(flags.limit, 10) : undefined,
        activeOnly: flags.active ? true : undefined,
        collateral: typeof flags.collateral === "string" ? flags.collateral : null,
      });
      if (flags.json) return console.log(JSON.stringify(d, null, 2));

      if (d.addresses) {
        section("Positions (addresses)");
        console.log(`  Total: ${c.cyan(String(d.total))}`);
        d.addresses.forEach((a, i) => console.log(`  ${c.dim(String(i + 1).padStart(3))}  ${a}`));
      } else {
        section("Position Details");
        console.log(JSON.stringify(d, null, 2));
      }
    },
  },

  challenges: {
    desc: "Liquidation challenges",
    help: "frankencoin challenges [--limit N] [--active] [--json]",
    async run(flags) {
      const d = await api.getChallenges({
        limit: parseInt(flags.limit ?? "20", 10),
        activeOnly: !!flags.active,
      });
      if (flags.json) return console.log(JSON.stringify(d, null, 2));

      section(`Challenges (${d.active} active / ${d.total} total)`);
      for (const ch of (d.challenges || []).slice(0, 10)) {
        console.log(`  ${c.dim(ch.id?.slice(0, 16) || "?")}  ${ch.status}  size: ${fmtNum(ch.size, 4)}  bids: ${ch.bids}`);
      }
    },
  },

  collaterals: {
    desc: "Accepted collateral types",
    help: "frankencoin collaterals [--json]",
    async run(flags) {
      const d = await api.getCollaterals();
      if (flags.json) return console.log(JSON.stringify(d, null, 2));

      section("Accepted Collaterals");
      for (const t of (Array.isArray(d) ? d : [])) {
        console.log(`  ${c.cyan(t.symbol?.padEnd(10))} ${t.name?.padEnd(30)} ${t.chainName}`);
      }
    },
  },

  analytics: {
    desc: "Historical analytics — time_series, trades, minters, rate_history",
    help: "frankencoin analytics [--type time_series|trades|minters|rate_history] [--days N] [--limit N] [--json]",
    async run(flags) {
      const d = await api.getAnalytics({
        type: flags.type ?? "time_series",
        days: parseInt(flags.days ?? "90", 10),
        limit: parseInt(flags.limit ?? "20", 10),
      });
      if (flags.json) return console.log(JSON.stringify(d, null, 2));
      console.log(JSON.stringify(d, null, 2));
    },
  },

  knowledge: {
    desc: "Documentation and reference content",
    help: "frankencoin knowledge [--topic overview|faq|savings|governance|minting|risks|token_addresses|links|...] [--json]",
    async run(flags) {
      const d = await api.getKnowledge({ topic: flags.topic ?? "overview" });
      if (flags.json) return console.log(JSON.stringify(d, null, 2));

      if (d.content) {
        console.log(d.content);
      } else {
        console.log(JSON.stringify(d, null, 2));
      }
    },
  },

  news: {
    desc: "Media coverage, use cases, ecosystem partners",
    help: "frankencoin news [--json]",
    async run(flags) {
      const d = await api.getNews();
      if (flags.json) return console.log(JSON.stringify(d, null, 2));

      section("Press Articles");
      for (const a of (d.media?.articles || []).slice(0, 10)) {
        console.log(`  ${c.cyan("•")} ${a.title ?? a.url}`);
      }
      section("Videos");
      for (const v of (d.media?.videos || []).slice(0, 5)) {
        console.log(`  ${c.cyan("•")} ${v.title ?? v.url}`);
      }
    },
  },

  merch: {
    desc: "Merch store products",
    help: "frankencoin merch [--json]",
    async run(flags) {
      const d = await api.getMerch();
      if (flags.json) return console.log(JSON.stringify(d, null, 2));

      section("Merch Store");
      for (const p of (d.products || [])) {
        console.log(`  ${c.bold(p.title)}  ${c.green("$" + p.minPrice)}${p.available ? "" : c.red(" (sold out)")}`);
      }
    },
  },

  dune: {
    desc: "Dune Analytics — holder counts, volumes",
    help: "frankencoin dune [--json]",
    async run(flags) {
      const d = await api.getDuneStats();
      if (flags.json) return console.log(JSON.stringify(d, null, 2));

      section("Dune Analytics");
      console.log(JSON.stringify(d, null, 2));
    },
  },

  ponder: {
    desc: "Raw GraphQL query against ponder.frankencoin.com",
    help: "frankencoin ponder '<graphql>' [--json]",
    async run(flags, rawArgs) {
      const query = rawArgs[0];
      if (!query) {
        console.error(c.red("Error: GraphQL query required"));
        process.exit(1);
      }
      const d = await api.runPonderQuery(query);
      console.log(JSON.stringify(d, null, 2));
    },
  },
};

// ─── Help ─────────────────────────────────────────────────────────────────────

function printHelp(cmd) {
  if (cmd && COMMANDS[cmd]) {
    console.log(`\n${c.bold("Usage:")} ${COMMANDS[cmd].help}\n\n${COMMANDS[cmd].desc}\n`);
    return;
  }
  console.log(`\n${c.bold(c.cyan("frankencoin"))} — Frankencoin (ZCHF) protocol CLI (13 tools)\n`);
  console.log(`${c.bold("Commands:")}\n`);
  for (const [name, def] of Object.entries(COMMANDS)) {
    console.log(`  ${c.cyan(name.padEnd(16))} ${def.desc}`);
  }
  console.log(`\n${c.bold("Global:")}  --json (raw JSON)  --help (command help)\n`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { _, flags } = parseArgs(process.argv.slice(2));
  const cmdName = _[0];
  if (!cmdName || (flags.help && !cmdName)) { printHelp(); process.exit(0); }
  if (flags.help) { printHelp(cmdName); process.exit(0); }
  const cmd = COMMANDS[cmdName];
  if (!cmd) { console.error(c.red(`Unknown: ${cmdName}`)); printHelp(); process.exit(1); }
  try { await cmd.run(flags, _.slice(1)); }
  catch (e) { console.error(c.red(`Error: ${e.message}`)); process.exit(1); }
}

main();
