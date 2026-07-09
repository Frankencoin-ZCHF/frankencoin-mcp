#!/usr/bin/env node
/**
 * Frankencoin CLI — direct access to all 15 read-only tools. Imports services
 * directly (no server, no MCP). Global --json prints raw JSON; --help prints help.
 *
 *   frankencoin snapshot
 *   frankencoin positions --detail --limit 10
 *   frankencoin analytics --type time_series --days 30
 *   frankencoin ponder '{ mintingHubV2PositionV2s(limit:5){ items { position owner minted } } }'
 */

import { getProtocolSnapshot } from "./services/snapshot.js";
import { getMarketData } from "./services/market.js";
import { getSavings } from "./services/savings.js";
import { getGovernance } from "./services/governance.js";
import { getPositions, getChallenges, getCollaterals } from "./services/positions.js";
import { getAnalytics, getDuneStats } from "./services/analytics.js";
import { getKnowledge, getNews, getMerch, getCompliance } from "./services/content.js";
import { getRisk } from "./services/risk.js";
import { runPonderQuery } from "./services/ponder.js";

const NO_COLOR = process.env.NO_COLOR || !process.stdout.isTTY;
const c = {
  bold: (s) => (NO_COLOR ? s : `\x1b[1m${s}\x1b[0m`),
  dim: (s) => (NO_COLOR ? s : `\x1b[2m${s}\x1b[0m`),
  cyan: (s) => (NO_COLOR ? s : `\x1b[36m${s}\x1b[0m`),
  green: (s) => (NO_COLOR ? s : `\x1b[32m${s}\x1b[0m`),
  yellow: (s) => (NO_COLOR ? s : `\x1b[33m${s}\x1b[0m`),
  red: (s) => (NO_COLOR ? s : `\x1b[31m${s}\x1b[0m`),
};

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) { args.flags[key] = next; i++; }
      else args.flags[key] = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

function fmtNum(n, dec = 2) {
  if (n == null || isNaN(n)) return "—";
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function fmtM(n) {
  if (n == null || isNaN(n)) return "—";
  return `${fmtNum(Number(n) / 1e6)}M`;
}
function section(title) { console.log("\n" + c.bold(c.cyan(`● ${title}`))); }

const COMMANDS = {
  snapshot: {
    desc: "Full protocol snapshot — supply, FPS, TVL, savings, challenges",
    help: "frankencoin snapshot [--json]",
    async run(flags) {
      const d = await getProtocolSnapshot();
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
      const d = await getMarketData();
      if (flags.json) return console.log(JSON.stringify(d, null, 2));
      section("ZCHF Peg Health");
      console.log(`  Price           ${c.green(fmtNum(d.zchf?.priceChf, 4))} CHF`);
      console.log(`  Peg Deviation   ${fmtNum(d.zchf?.pegDeviationPercent, 4)}%`);
      console.log(`  Status          ${d.zchf?.pegStatus === "healthy" ? c.green("healthy") : c.yellow(d.zchf?.pegStatus)}`);
      if (d.note) console.log(c.dim(`  (${d.note})`));
      section("CHF Stablecoins");
      for (const sc of d.chfStablecoins || []) {
        console.log(`  ${c.bold(sc.symbol.padEnd(8))} ${sc.priceChf != null ? fmtNum(sc.priceChf, 4) + " CHF" : "—"}  mcap: ${sc.marketCapChf != null ? fmtM(sc.marketCapChf) : "—"}`);
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
      const d = await getSavings();
      if (flags.json) return console.log(JSON.stringify(d, null, 2));
      section("Savings Overview");
      console.log(`  Total Deposited ${c.green(fmtM(d.summary?.totalDepositedChf))} ZCHF`);
      console.log(`  Total Interest  ${c.green(fmtM(d.summary?.totalInterestPaidChf))} ZCHF`);
      console.log(`  Pending Changes ${d.summary?.pendingRateChanges || 0}`);
      section("Approved Rates");
      for (const r of d.rates?.approved || []) {
        console.log(`  ${r.chainName.padEnd(12)} ${r.module.slice(0, 10)}…  ${c.cyan(fmtNum(r.ratePercent))}%`);
      }
    },
  },
  governance: {
    desc: "Governance — rate proposals, minters, FPS trades, holders",
    help: "frankencoin governance [--type all|rate_proposals|minters|equity_trades|holders] [--status active|denied|all] [--limit N] [--json]",
    async run(flags) {
      const d = await getGovernance({
        type: flags.type ?? "all",
        status: flags.status ?? "all",
        limit: parseInt(flags.limit ?? "20", 10),
      });
      console.log(JSON.stringify(d, null, 2));
    },
  },
  positions: {
    desc: "Minting positions (--detail for full data)",
    help: "frankencoin positions [--detail] [--limit N] [--active] [--collateral 0x...] [--json]",
    async run(flags) {
      const d = await getPositions({
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
      const d = await getChallenges({ limit: parseInt(flags.limit ?? "20", 10), activeOnly: !!flags.active });
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
      const d = await getCollaterals();
      if (flags.json) return console.log(JSON.stringify(d, null, 2));
      section(`Accepted Collaterals (${d.count})`);
      for (const t of d.collaterals || []) {
        console.log(`  ${c.cyan((t.symbol || "").padEnd(10))} ${(t.name || "").padEnd(30)} ${t.chainName}`);
      }
    },
  },
  analytics: {
    desc: "Historical analytics — time_series, trades, minters, rate_history",
    help: "frankencoin analytics [--type time_series|trades|minters|rate_history] [--days N] [--limit N] [--json]",
    async run(flags) {
      const d = await getAnalytics({
        type: flags.type ?? "time_series",
        days: parseInt(flags.days ?? "90", 10),
        limit: parseInt(flags.limit ?? "20", 10),
      });
      console.log(JSON.stringify(d, null, 2));
    },
  },
  knowledge: {
    desc: "Documentation and reference content",
    help: "frankencoin knowledge [--topic overview|faq|savings|governance|minting|risks|token_addresses|links|...] [--json]",
    async run(flags) {
      const d = await getKnowledge({ topic: flags.topic ?? "overview" });
      if (flags.json) return console.log(JSON.stringify(d, null, 2));
      if (d.content) console.log(d.content);
      else console.log(JSON.stringify(d, null, 2));
    },
  },
  news: {
    desc: "Media coverage, use cases, ecosystem partners",
    help: "frankencoin news [--json]",
    async run(flags) {
      const d = await getNews();
      if (flags.json) return console.log(JSON.stringify(d, null, 2));
      section("Press Articles");
      for (const a of (d.media?.articles || []).slice(0, 10)) console.log(`  ${c.cyan("•")} ${a.title ?? a.url}`);
      section("Videos");
      for (const v of (d.media?.videos || []).slice(0, 5)) console.log(`  ${c.cyan("•")} ${v.title ?? v.url}`);
    },
  },
  merch: {
    desc: "Merch store products",
    help: "frankencoin merch [--json]",
    async run(flags) {
      const d = await getMerch();
      if (flags.json) return console.log(JSON.stringify(d, null, 2));
      section("Merch Store");
      for (const p of d.products || []) {
        console.log(`  ${c.bold(p.title)}  ${c.green("$" + p.minPrice)}${p.available ? "" : c.red(" (sold out)")}`);
      }
    },
  },
  compliance: {
    desc: "Legal & regulatory compliance — papers, audits, links",
    help: "frankencoin compliance [--json]",
    async run(flags) {
      const d = await getCompliance();
      if (flags.json) return console.log(JSON.stringify(d, null, 2));
      section(d.title || "Compliance");
      if (d.intro) console.log(c.dim(`  ${d.intro}`));
      section("Regulatory Classification");
      console.log(`  ${c.bold("Swiss (FINMA)")}  ${d.regulatory?.swiss?.classification ?? "—"}`);
      if (d.regulatory?.swiss?.document) console.log(`    ${c.cyan(d.regulatory.swiss.document.url)}`);
      console.log(`  ${c.bold("EU (MiCA)")}     ${d.regulatory?.euMica?.classification ?? "—"}`);
      for (const doc of d.regulatory?.euMica?.documents ?? []) console.log(`    ${c.cyan(doc.url)}  ${c.dim(doc.label)}`);
      section("Security Audits");
      for (const r of d.audits?.reports ?? []) console.log(`  ${(r.firm || "").padEnd(16)} ${c.cyan(r.url)}`);
      if (d.audits?.bugBounty) console.log(`  ${"Bug bounty".padEnd(16)} ${c.cyan(d.audits.bugBounty.url)}`);
      section("Contact");
      console.log(`  ${c.green(d.contact?.email ?? "compliance@frankencoin.com")}`);
      if (d.disclaimer) console.log(c.dim(`\n  ${d.disclaimer}`));
    },
  },
  risk: {
    desc: "Third-party risk ratings — Pharos safety card + Xerberus scores",
    help: "frankencoin risk [--source all|pharos|xerberus] [--json]",
    async run(flags) {
      const d = await getRisk({ source: flags.source ?? "all" });
      if (flags.json) return console.log(JSON.stringify(d, null, 2));
      if (d.pharos) {
        section("Pharos — Stablecoin Safety");
        if (d.pharos.rating === null) {
          console.log(c.dim(`  ${d.pharos.note}`));
        } else {
          console.log(`  Overall         ${c.bold(d.pharos.overallGrade)}  (${fmtNum(d.pharos.overallScore, 0)}/100)`);
          for (const dim of d.pharos.dimensions || []) {
            console.log(`  ${dim.label.padEnd(26)} ${dim.grade.padEnd(4)} ${dim.score != null ? fmtNum(dim.score, 0) + "/100" : "—"}`);
          }
        }
      }
      if (d.xerberus) {
        section("Xerberus — Composite Risk");
        if (d.xerberus.ratings === null) {
          console.log(c.dim(`  ${d.xerberus.note}`));
        } else {
          for (const r of d.xerberus.ratings || []) {
            console.log(`  ${(`${r.entity} ${r.subtitle}`).padEnd(32)} ${r.score != null ? fmtNum(r.score, 0) + "/100" : c.dim("not rated")}`);
          }
        }
      }
    },
  },
  dune: {
    desc: "Dune Analytics — holder counts, volumes",
    help: "frankencoin dune [--json]",
    async run() {
      console.log(JSON.stringify(await getDuneStats(), null, 2));
    },
  },
  ponder: {
    desc: "Raw read-only GraphQL query against ponder.frankencoin.com",
    help: "frankencoin ponder '<graphql>' [--json]",
    async run(flags, rawArgs) {
      const query = rawArgs[0];
      if (!query) { console.error(c.red("Error: GraphQL query required")); process.exit(1); }
      console.log(JSON.stringify(await runPonderQuery(query), null, 2));
    },
  },
};

function printHelp(cmd) {
  if (cmd && COMMANDS[cmd]) {
    console.log(`\n${c.bold("Usage:")} ${COMMANDS[cmd].help}\n\n${COMMANDS[cmd].desc}\n`);
    return;
  }
  console.log(`\n${c.bold(c.cyan("frankencoin"))} — Frankencoin (ZCHF) protocol CLI (15 tools)\n`);
  console.log(`${c.bold("Commands:")}\n`);
  for (const [name, def] of Object.entries(COMMANDS)) {
    console.log(`  ${c.cyan(name.padEnd(16))} ${def.desc}`);
  }
  console.log(`\n${c.bold("Global:")}  --json (raw JSON)  --help (command help)\n`);
}

async function main() {
  const { _, flags } = parseArgs(process.argv.slice(2));
  const cmdName = _[0];
  if (!cmdName) { printHelp(); process.exit(0); }
  if (flags.help) { printHelp(cmdName); process.exit(0); }
  const cmd = COMMANDS[cmdName];
  if (!cmd) { console.error(c.red(`Unknown: ${cmdName}`)); printHelp(); process.exit(1); }
  try { await cmd.run(flags, _.slice(1)); }
  catch (e) { console.error(c.red(`Error: ${e.message}`)); process.exit(1); }
}

main();
