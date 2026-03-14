#!/usr/bin/env node
/**
 * Frankencoin CLI
 *
 * Direct CLI access to all Frankencoin MCP tools.
 * No MCP protocol, no mcporter — just import api.js and format output.
 *
 * Usage:
 *   frankencoin <command> [options]
 *   frankencoin --help
 *   frankencoin <command> --help
 *
 * Examples:
 *   frankencoin summary
 *   frankencoin prices
 *   frankencoin positions --limit 10 --active
 *   frankencoin challenges --active
 *   frankencoin historical --days 30
 *   frankencoin ponder '{ mintingHubV2PositionV2s(limit:5) { items { position owner minted } } }'
 *   frankencoin docs --section savings
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
  blue:   (s) => NO_COLOR ? s : `\x1b[34m${s}\x1b[0m`,
  magenta:(s) => NO_COLOR ? s : `\x1b[35m${s}\x1b[0m`,
};

// ─── Argument parsing (no deps) ───────────────────────────────────────────────

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

// ─── Number formatters ────────────────────────────────────────────────────────

function fmtNum(n, decimals = 2) {
  if (n == null || isNaN(n)) return "—";
  return Number(n).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function fmtM(n, decimals = 2) {
  if (n == null || isNaN(n)) return "—";
  const m = Number(n) / 1e6;
  return `${fmtNum(m, decimals)}M`;
}

function fmtPct(n, decimals = 2) {
  if (n == null || isNaN(n)) return "—";
  return `${fmtNum(Number(n) * 100, decimals)}%`;
}

function fmtDate(ts) {
  if (!ts) return "—";
  return new Date(ts * 1000 > 9999999999 ? ts : ts * 1000).toISOString().slice(0, 16).replace("T", " ");
}

// ─── Table printer ────────────────────────────────────────────────────────────

function table(rows, headers) {
  if (!rows.length) { console.log(c.dim("  (no data)")); return; }
  const cols = headers.map((h, i) => ({
    label: h,
    width: Math.max(h.length, ...rows.map((r) => String(r[i] ?? "—").length)),
  }));
  const line = cols.map((col) => "─".repeat(col.width + 2)).join("┬");
  console.log(c.dim("┌" + line + "┐"));
  console.log(c.dim("│") + cols.map((col) => " " + c.bold(col.label.padEnd(col.width)) + " ").join(c.dim("│")) + c.dim("│"));
  console.log(c.dim("├" + line + "┤"));
  for (const row of rows) {
    console.log(c.dim("│") + cols.map((col, i) => " " + String(row[i] ?? "—").padEnd(col.width) + " ").join(c.dim("│")) + c.dim("│"));
  }
  console.log(c.dim("└" + line + "┘"));
}

// ─── Section header ───────────────────────────────────────────────────────────

function section(title) {
  console.log("\n" + c.bold(c.cyan(`● ${title}`)));
}

// ─── Command handlers ─────────────────────────────────────────────────────────

const COMMANDS = {};

// ── summary ──────────────────────────────────────────────────────────────────
COMMANDS.summary = {
  desc: "Full protocol snapshot — supply, FPS, TVL, savings rate, challenges",
  help: "frankencoin summary [--json]",
  async run(flags) {
    const d = await api.getProtocolSummary();
    if (flags.json) { console.log(JSON.stringify(d, null, 2)); return; }

    section("Protocol Summary");
    const z = d.zchf ?? d;
    const fps = d.fps ?? {};
    const savings = d.savings ?? {};

    console.log(`  ZCHF Supply     ${c.green(fmtM(z.totalSupply ?? d.totalSupply))} ZCHF`);
    console.log(`  ZCHF Price      ${c.green(fmtNum(z.price ?? d.price, 4))} CHF`);
    console.log(`  Total TVL       ${c.green(fmtM(d.tvlChf ?? d.tvl))} CHF`);
    console.log(`  FPS Price       ${c.yellow(fmtNum(fps.price, 2))} CHF`);
    console.log(`  FPS Market Cap  ${c.yellow(fmtM(fps.marketCap))} CHF`);
    console.log(`  Equity Reserve  ${c.yellow(fmtM(fps.equityReserve ?? fps.reserve))} CHF`);
    const rate = savings.savingsRate ?? savings.rate ?? savings.leadRate;
    if (rate != null) console.log(`  Savings Rate    ${c.cyan(fmtPct(rate))}`);
    if (d.activeChallenges != null) {
      const n = d.activeChallenges;
      console.log(`  Challenges      ${n > 0 ? c.red(String(n)) : c.green("0")} active`);
    }
  },
};

// ── info ──────────────────────────────────────────────────────────────────────
COMMANDS.info = {
  desc: "Supply breakdown by chain + TVL",
  help: "frankencoin info [--json]",
  async run(flags) {
    const d = await api.getProtocolInfo();
    if (flags.json) { console.log(JSON.stringify(d, null, 2)); return; }

    section("Protocol Info — Supply by Chain");
    const chains = d.chains ?? d.supplyByChain ?? [];
    if (chains.length) {
      table(
        chains.map((c2) => [c2.chain ?? c2.name, fmtM(c2.supply) + " ZCHF", fmtM(c2.tvlChf ?? c2.tvl) + " CHF"]),
        ["Chain", "Supply", "TVL"],
      );
    }
    const total = d.totalSupply ?? d.total;
    if (total != null) console.log(`\n  Total: ${c.green(fmtM(total))} ZCHF`);
  },
};

// ── fps ───────────────────────────────────────────────────────────────────────
COMMANDS.fps = {
  desc: "FPS governance token details",
  help: "frankencoin fps [--json]",
  async run(flags) {
    const d = await api.getFpsInfo();
    if (flags.json) { console.log(JSON.stringify(d, null, 2)); return; }

    section("FPS Token");
    console.log(`  Price           ${c.yellow(fmtNum(d.price, 2))} CHF`);
    console.log(`  Total Supply    ${c.yellow(fmtNum(d.totalSupply))} FPS`);
    console.log(`  Market Cap      ${c.yellow(fmtM(d.marketCap))} CHF`);
    const er = d.equityReserve ?? d.equity ?? d.reserve;
    if (er != null) console.log(`  Equity Reserve  ${c.yellow(fmtM(er))} CHF`);
    const mr = d.minterReserve ?? d.minter;
    if (mr != null) console.log(`  Minter Reserve  ${fmtM(mr)} CHF`);
    if (d.pnl != null) console.log(`  Cumulative P&L  ${d.pnl >= 0 ? c.green(fmtM(d.pnl)) : c.red(fmtM(d.pnl))} CHF`);
  },
};

// ── prices ────────────────────────────────────────────────────────────────────
COMMANDS.prices = {
  desc: "Current prices for ZCHF, FPS, and all collateral tokens",
  help: "frankencoin prices [--json]",
  async run(flags) {
    const d = await api.getPrices();
    if (flags.json) { console.log(JSON.stringify(d, null, 2)); return; }

    section("Token Prices");
    const tokens = Array.isArray(d) ? d : Object.entries(d).map(([k, v]) =>
      typeof v === "object" ? { symbol: k, ...v } : { symbol: k, priceChf: v }
    );
    table(
      tokens.map((t) => [
        t.symbol ?? t.name ?? "?",
        fmtNum(t.priceChf ?? t.chf ?? t.price, 4) + " CHF",
        t.priceUsd ?? t.usd ? fmtNum(t.priceUsd ?? t.usd, 4) + " USD" : "—",
      ]),
      ["Token", "CHF", "USD"],
    );
  },
};

// ── rates ─────────────────────────────────────────────────────────────────────
COMMANDS.rates = {
  desc: "Savings and base rates across all chains",
  help: "frankencoin rates [--json]",
  async run(flags) {
    const d = await api.getSavingsRates();
    if (flags.json) { console.log(JSON.stringify(d, null, 2)); return; }

    section("Savings / Lead Rates");
    const modules = Array.isArray(d) ? d : d.modules ?? d.rates ?? [d];
    table(
      modules.map((m) => [
        m.chain ?? m.chainId ?? "?",
        m.name ?? m.module ?? "—",
        fmtPct(m.rate ?? m.savingsRate ?? m.leadRate),
        m.pendingRate != null ? fmtPct(m.pendingRate) : "—",
        m.address ? m.address.slice(0, 10) + "…" : "—",
      ]),
      ["Chain", "Module", "Rate", "Pending", "Address"],
    );
  },
};

// ── savings ───────────────────────────────────────────────────────────────────
COMMANDS.savings = {
  desc: "Savings module stats — deposits, interest paid, withdrawals",
  help: "frankencoin savings [--json]",
  async run(flags) {
    const d = await api.getSavingsStats();
    if (flags.json) { console.log(JSON.stringify(d, null, 2)); return; }

    section("Savings Stats");
    const modules = Array.isArray(d) ? d : d.modules ?? d.stats ?? [d];
    table(
      modules.map((m) => [
        m.chain ?? m.chainId ?? "?",
        m.module ?? m.name ?? "—",
        fmtM(m.totalDeposited ?? m.deposited) + " ZCHF",
        fmtM(m.totalInterest ?? m.interest) + " ZCHF",
        fmtM(m.totalWithdrawn ?? m.withdrawn) + " ZCHF",
      ]),
      ["Chain", "Module", "Deposited", "Interest", "Withdrawn"],
    );
  },
};

// ── collaterals ───────────────────────────────────────────────────────────────
COMMANDS.collaterals = {
  desc: "Accepted collateral types",
  help: "frankencoin collaterals [--json]",
  async run(flags) {
    const d = await api.getCollaterals();
    if (flags.json) { console.log(JSON.stringify(d, null, 2)); return; }

    section("Accepted Collaterals");
    const items = Array.isArray(d) ? d : d.collaterals ?? [];
    table(
      items.map((t) => [
        t.symbol ?? t.name ?? "?",
        t.chain ?? t.chainId ?? "?",
        t.address ? t.address.slice(0, 12) + "…" : "—",
      ]),
      ["Symbol", "Chain", "Address"],
    );
  },
};

// ── challenges ────────────────────────────────────────────────────────────────
COMMANDS.challenges = {
  desc: "Liquidation challenges on collateral positions",
  help: "frankencoin challenges [--limit N] [--active] [--json]",
  async run(flags) {
    const limit = parseInt(flags.limit ?? "20", 10);
    const activeOnly = !!flags.active;
    const d = await api.getChallenges({ limit, activeOnly });
    if (flags.json) { console.log(JSON.stringify(d, null, 2)); return; }

    section(`Challenges${activeOnly ? " (active only)" : ""}`);
    const items = Array.isArray(d) ? d : d.challenges ?? d.items ?? [];
    if (!items.length) { console.log(c.green("  No challenges found.")); return; }
    table(
      items.map((ch) => [
        ch.id ?? ch.challenger ?? "?",
        ch.status ?? "—",
        fmtNum(ch.size ?? ch.challengedAmount, 4),
        ch.bids ?? "—",
        fmtDate(ch.end ?? ch.expiry ?? ch.created),
      ]),
      ["Challenge", "Status", "Size", "Bids", "End"],
    );
  },
};

// ── positions ─────────────────────────────────────────────────────────────────
COMMANDS.positions = {
  desc: "Open ZCHF minting positions (addresses)",
  help: "frankencoin positions [--limit N] [--json]",
  async run(flags) {
    const limit = parseInt(flags.limit ?? "50", 10);
    const d = await api.getPositions({ limit });
    if (flags.json) { console.log(JSON.stringify(d, null, 2)); return; }

    section("Positions (addresses)");
    const items = Array.isArray(d) ? d : d.positions ?? d.addresses ?? [];
    console.log(`  Total: ${c.cyan(String(d.total ?? items.length))}`);
    items.slice(0, limit).forEach((addr, i) => {
      const a = typeof addr === "string" ? addr : addr.address ?? addr.position ?? JSON.stringify(addr);
      console.log(`  ${c.dim(String(i + 1).padStart(3))}  ${a}`);
    });
  },
};

// ── positions-detail ──────────────────────────────────────────────────────────
COMMANDS["positions-detail"] = {
  desc: "Detailed position data — collateral, minted, capacity, liquidation price",
  help: "frankencoin positions-detail [--limit N] [--all] [--collateral 0x...] [--json]",
  async run(flags) {
    const limit = parseInt(flags.limit ?? "20", 10);
    const activeOnly = !flags.all;
    const collateral = typeof flags.collateral === "string" ? flags.collateral : null;
    const d = await api.getPositionsDetail({ limit, activeOnly, collateral });
    if (flags.json) { console.log(JSON.stringify(d, null, 2)); return; }

    section(`Position Detail${activeOnly ? " (active)" : " (all)"}${collateral ? ` — ${collateral.slice(0, 10)}…` : ""}`);
    const items = Array.isArray(d) ? d : d.positions ?? d.items ?? [];
    if (!items.length) { console.log(c.dim("  (no positions)")); return; }
    table(
      items.map((p) => [
        (p.position ?? p.address ?? "?").slice(0, 12) + "…",
        p.collateralSymbol ?? p.collateral?.slice(0, 8) ?? "?",
        fmtNum(p.collateralBalance ?? p.collateralAmount, 4),
        fmtM(p.minted ?? p.mintedAmount) + " ZCHF",
        p.liquidationPrice != null ? fmtNum(p.liquidationPrice, 4) : "—",
        p.annualInterestPPM != null ? fmtPct(p.annualInterestPPM / 1e6, 2) : "—",
      ]),
      ["Position", "Collateral", "Balance", "Minted", "Liq Price", "APR"],
    );
  },
};

// ── analytics ─────────────────────────────────────────────────────────────────
COMMANDS.analytics = {
  desc: "Daily historical protocol analytics",
  help: "frankencoin analytics [--days N] [--json]",
  async run(flags) {
    const days = Math.min(parseInt(flags.days ?? "30", 10), 365);
    const d = await api.getAnalytics({ days });
    if (flags.json) { console.log(JSON.stringify(d, null, 2)); return; }

    section(`Analytics — Last ${days} Days`);
    const rows = Array.isArray(d) ? d : d.data ?? d.rows ?? [];
    const recent = rows.slice(-10).reverse(); // show latest 10
    table(
      recent.map((r) => [
        r.date ?? fmtDate(r.timestamp ?? r.ts),
        fmtM(r.totalSupply ?? r.supply) + " ZCHF",
        fmtM(r.equityReserve ?? r.equity) + " CHF",
        fmtM(r.savingsTvl ?? r.savings) + " ZCHF",
        r.fpsPrice != null ? fmtNum(r.fpsPrice, 2) : "—",
        r.savingsRate != null ? fmtPct(r.savingsRate) : "—",
      ]),
      ["Date", "Supply", "Equity", "Savings", "FPS", "Rate"],
    );
    if (rows.length > 10) console.log(c.dim(`  … showing latest 10 of ${rows.length} days`));
  },
};

// ── trades ────────────────────────────────────────────────────────────────────
COMMANDS.trades = {
  desc: "Recent FPS buy/sell trades",
  help: "frankencoin trades [--limit N] [--json]",
  async run(flags) {
    const limit = Math.min(parseInt(flags.limit ?? "20", 10), 100);
    const d = await api.getEquityTrades({ limit });
    if (flags.json) { console.log(JSON.stringify(d, null, 2)); return; }

    section(`FPS Trades (last ${limit})`);
    const items = Array.isArray(d) ? d : d.trades ?? d.items ?? [];
    table(
      items.map((t) => [
        fmtDate(t.time ?? t.timestamp),
        t.buyer ?? t.from ?? "?",
        t.seller ?? t.to ?? "?",
        fmtNum(t.shares ?? t.amount, 4) + " FPS",
        fmtNum(t.price, 2) + " CHF",
        fmtNum(t.totalValue ?? (t.shares * t.price), 2) + " CHF",
      ]),
      ["Time", "Buyer", "Seller", "Shares", "Price", "Total"],
    );
  },
};

// ── minters ───────────────────────────────────────────────────────────────────
COMMANDS.minters = {
  desc: "Approved minter contracts",
  help: "frankencoin minters [--limit N] [--json]",
  async run(flags) {
    const limit = parseInt(flags.limit ?? "20", 10);
    const d = await api.getMinters({ limit });
    if (flags.json) { console.log(JSON.stringify(d, null, 2)); return; }

    section("Minters");
    const items = Array.isArray(d) ? d : d.minters ?? d.items ?? [];
    table(
      items.map((m) => [
        (m.address ?? m.minter ?? "?").slice(0, 14) + "…",
        m.active ?? m.isActive ? c.green("✓") : c.dim("✗"),
        fmtDate(m.applicationDate ?? m.created),
        m.applicationFee != null ? fmtNum(m.applicationFee, 2) + " ZCHF" : "—",
      ]),
      ["Address", "Active", "Applied", "Fee"],
    );
  },
};

// ── historical ────────────────────────────────────────────────────────────────
COMMANDS.historical = {
  desc: "Historical time-series (supply, FPS, rates) — up to 365 days",
  help: "frankencoin historical [--days N] [--json]",
  async run(flags) {
    const days = Math.min(parseInt(flags.days ?? "90", 10), 365);
    const d = await api.getHistorical({ days });
    if (flags.json) { console.log(JSON.stringify(d, null, 2)); return; }

    section(`Historical Data — Last ${days} Days`);
    const rows = Array.isArray(d) ? d : d.data ?? d.snapshots ?? d.rows ?? [];
    const recent = rows.slice(-10).reverse();
    table(
      recent.map((r) => [
        r.date ?? fmtDate(r.timestamp ?? r.ts),
        fmtM(r.totalSupply ?? r.supply) + " ZCHF",
        fmtNum(r.fpsPrice, 2) + " CHF",
        fmtM(r.equityReserve ?? r.equity) + " CHF",
        r.savingsRate != null ? fmtPct(r.savingsRate) : "—",
        r.earningsPerFps != null ? fmtNum(r.earningsPerFps, 4) : "—",
      ]),
      ["Date", "Supply", "FPS Price", "Equity", "Rate", "EPS"],
    );
    if (rows.length > 10) console.log(c.dim(`  … showing latest 10 of ${rows.length} snapshots`));
  },
};

// ── market ────────────────────────────────────────────────────────────────────
COMMANDS.market = {
  desc: "Live market context — peg health, FPS 24h, BTC/ETH macro",
  help: "frankencoin market [--json]",
  async run(flags) {
    const d = await api.getMarketContext();
    if (flags.json) { console.log(JSON.stringify(d, null, 2)); return; }

    section("Market Context");
    const peg = d.zchf ?? d.peg ?? {};
    if (peg.price != null) {
      const dev = peg.pegDeviation ?? (peg.price - 1);
      const devStr = (dev >= 0 ? "+" : "") + (dev * 100).toFixed(4) + "%";
      console.log(`  ZCHF Price      ${c.green(fmtNum(peg.price, 4))} CHF  ${Math.abs(dev) < 0.005 ? c.green(devStr) : c.yellow(devStr)}`);
    }
    const fps = d.fps ?? {};
    if (fps.price != null) {
      const chg = fps.change24h ?? fps.priceChange24h;
      const chgStr = chg != null ? ` (${chg >= 0 ? "+" : ""}${fmtNum(chg, 2)}% 24h)` : "";
      console.log(`  FPS             ${c.yellow(fmtNum(fps.price, 2))} CHF${c.dim(chgStr)}`);
    }
    const macro = d.macro ?? d.context ?? {};
    for (const [sym, val] of Object.entries(macro)) {
      const price = typeof val === "object" ? val.price ?? val.priceUsd : val;
      if (price != null) console.log(`  ${sym.toUpperCase().padEnd(14)}${fmtNum(price, 2)} USD`);
    }
  },
};

// ── dune ──────────────────────────────────────────────────────────────────────
COMMANDS.dune = {
  desc: "On-chain analytics from Dune — holder counts, volumes",
  help: "frankencoin dune [--json]",
  async run(flags) {
    const d = await api.getDuneStats();
    if (flags.json) { console.log(JSON.stringify(d, null, 2)); return; }

    section("Dune Analytics");
    if (d.zchfHolders != null) console.log(`  ZCHF Holders    ${c.cyan(fmtNum(d.zchfHolders, 0))}`);
    if (d.fpsHolders  != null) console.log(`  FPS Holders     ${c.cyan(fmtNum(d.fpsHolders, 0))}`);
    if (d.mintingVolume != null) console.log(`  Minting Volume  ${c.green(fmtM(d.mintingVolume))} ZCHF`);
    if (d.savingsTvl  != null) console.log(`  Savings TVL     ${c.green(fmtM(d.savingsTvl))} ZCHF`);
    // If it's a nested object, just dump it nicely
    const rest = Object.entries(d).filter(([k]) => !["zchfHolders","fpsHolders","mintingVolume","savingsTvl"].includes(k));
    for (const [k, v] of rest) {
      if (typeof v !== "object") console.log(`  ${k.padEnd(16)}${v}`);
    }
  },
};

// ── addresses ─────────────────────────────────────────────────────────────────
COMMANDS.addresses = {
  desc: "Token contract addresses across all chains",
  help: "frankencoin addresses [--json]",
  async run(flags) {
    const d = await api.getTokenAddresses();
    if (flags.json) { console.log(JSON.stringify(d, null, 2)); return; }

    section("Token Addresses");
    const chains = Array.isArray(d) ? d : d.chains ?? d.tokens ?? [];
    for (const chain of chains) {
      console.log(`\n  ${c.bold(chain.chain ?? chain.name ?? "?")}`);
      const tokens = chain.tokens ?? chain.addresses ?? [];
      for (const t of tokens) {
        const sym = (t.symbol ?? t.token ?? "?").padEnd(8);
        const addr = t.address ?? "?";
        const explorer = t.explorerUrl ?? t.explorer ?? "";
        console.log(`    ${c.cyan(sym)}  ${addr}${explorer ? c.dim("  " + explorer) : ""}`);
      }
    }
  },
};

// ── links ─────────────────────────────────────────────────────────────────────
COMMANDS.links = {
  desc: "Official Frankencoin links — app, docs, socials, exchanges",
  help: "frankencoin links [--json]",
  async run(flags) {
    const d = await api.getLinks();
    if (flags.json) { console.log(JSON.stringify(d, null, 2)); return; }

    section("Frankencoin Links");
    function printObj(obj, indent = "  ") {
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "string") {
          console.log(`${indent}${c.dim(k.padEnd(20))}${v}`);
        } else if (typeof v === "object" && !Array.isArray(v)) {
          console.log(`\n${indent}${c.bold(k)}`);
          printObj(v, indent + "  ");
        } else if (Array.isArray(v)) {
          console.log(`${indent}${c.bold(k)}`);
          v.forEach((item) => {
            if (typeof item === "string") console.log(`${indent}  ${item}`);
            else printObj(item, indent + "  ");
          });
        }
      }
    }
    printObj(d);
  },
};

// ── docs ──────────────────────────────────────────────────────────────────────
const VALID_SECTIONS = ["overview","savings","pool_shares","governance","reserve","risks","faq","minting","opening_positions","auctions","api"];

COMMANDS.docs = {
  desc: "Official Frankencoin documentation",
  help: `frankencoin docs [--section <section>]\n  Sections: ${VALID_SECTIONS.join(", ")}`,
  async run(flags) {
    const section_ = typeof flags.section === "string" ? flags.section : "overview";
    if (!VALID_SECTIONS.includes(section_)) {
      console.error(c.red(`Unknown section "${section_}". Valid: ${VALID_SECTIONS.join(", ")}`));
      process.exit(1);
    }
    const d = await api.getDocs({ section: section_ });
    if (flags.json) { console.log(JSON.stringify(d, null, 2)); return; }

    const text = typeof d === "string" ? d : d.content ?? d.text ?? JSON.stringify(d, null, 2);
    console.log(text);
  },
};

// ── merch ─────────────────────────────────────────────────────────────────────
COMMANDS.merch = {
  desc: "Merch store — products, prices, availability",
  help: "frankencoin merch [--json]",
  async run(flags) {
    const d = await api.getMerch();
    if (flags.json) { console.log(JSON.stringify(d, null, 2)); return; }

    section("Merch Store");
    const items = Array.isArray(d) ? d : d.products ?? d.items ?? [];
    for (const item of items) {
      console.log(`\n  ${c.bold(item.title ?? item.name ?? "?")}  ${c.green(item.price ?? "")}`);
      if (item.available != null) console.log(`    Available: ${item.available ? c.green("yes") : c.red("no")}`);
      if (item.url) console.log(c.dim(`    ${item.url}`));
      if (item.variants?.length) {
        const varStr = item.variants.slice(0, 5).map((v) => v.title ?? v.size ?? v).join(", ");
        console.log(c.dim(`    Variants: ${varStr}${item.variants.length > 5 ? " …" : ""}`));
      }
    }
  },
};

// ── media ─────────────────────────────────────────────────────────────────────
COMMANDS.media = {
  desc: "Media coverage + use cases + ecosystem partners",
  help: "frankencoin media [--json]",
  async run(flags) {
    const d = await api.getMediaAndUseCases();
    if (flags.json) { console.log(JSON.stringify(d, null, 2)); return; }

    section("Media & Use Cases");
    const press = d.press ?? d.media ?? d.articles ?? [];
    if (press.length) {
      section("Press Coverage");
      table(
        press.slice(0, 15).map((a) => [
          a.date ? String(a.date).slice(0, 10) : "—",
          a.source ?? a.outlet ?? "?",
          (a.title ?? a.headline ?? "?").slice(0, 50),
        ]),
        ["Date", "Source", "Title"],
      );
    }
    const useCases = d.useCases ?? d.use_cases ?? d.cases ?? [];
    if (useCases.length) {
      section("Use Cases");
      useCases.forEach((u) => {
        console.log(`  ${c.cyan("•")} ${c.bold(u.name ?? u.title ?? "?")}: ${u.description ?? u.desc ?? ""}`);
      });
    }
    const partners = d.partners ?? d.ecosystem ?? [];
    if (partners.length) {
      section("Ecosystem Partners");
      partners.forEach((p) => {
        console.log(`  ${c.cyan("•")} ${c.bold(p.name ?? "?")}${p.url ? c.dim("  " + p.url) : ""}`);
      });
    }
  },
};

// ── ponder ────────────────────────────────────────────────────────────────────
COMMANDS.ponder = {
  desc: "Run raw GraphQL query against ponder.frankencoin.com",
  help: `frankencoin ponder '<graphql_query>' [--json]
  Example: frankencoin ponder '{ mintingHubV2PositionV2s(limit:5) { items { position owner minted } } }'`,
  async run(flags, rawArgs) {
    const query = rawArgs[0];
    if (!query) {
      console.error(c.red("Error: GraphQL query required as first argument"));
      console.error(c.dim("  frankencoin ponder '{ mintingHubV2PositionV2s(limit:5) { items { position } } }'"));
      process.exit(1);
    }
    const d = await api.runPonderQuery(query);
    if (flags.json) { console.log(JSON.stringify(d, null, 2)); return; }
    console.log(JSON.stringify(d, null, 2));
  },
};

// ─── Help ─────────────────────────────────────────────────────────────────────

function printHelp(cmd) {
  if (cmd && COMMANDS[cmd]) {
    const def = COMMANDS[cmd];
    console.log(`\n${c.bold("Usage:")} ${def.help}`);
    console.log(`\n${def.desc}\n`);
    return;
  }

  console.log(`
${c.bold(c.cyan("frankencoin"))} — Frankencoin (ZCHF) protocol CLI

${c.bold("Usage:")} frankencoin <command> [options]

${c.bold("Commands:")}
`);
  for (const [name, def] of Object.entries(COMMANDS)) {
    console.log(`  ${c.cyan(name.padEnd(20))} ${def.desc}`);
  }
  console.log(`
${c.bold("Global options:")}
  --json           Output raw JSON instead of formatted tables
  --help           Show help for a command

${c.bold("Examples:")}
  frankencoin summary
  frankencoin prices
  frankencoin positions-detail --limit 10
  frankencoin challenges --active
  frankencoin historical --days 30
  frankencoin ponder '{ analyticDailyLogs(limit:3) { items { totalSupply date } } }'
  frankencoin docs --section savings
`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { _, flags } = parseArgs(process.argv.slice(2));
  const cmdName = _[0];
  const restArgs = _.slice(1);

  if (!cmdName || flags.help && !cmdName) {
    printHelp();
    process.exit(0);
  }

  if (flags.help) {
    printHelp(cmdName);
    process.exit(0);
  }

  const cmd = COMMANDS[cmdName];
  if (!cmd) {
    console.error(c.red(`Unknown command: ${cmdName}`));
    console.error(c.dim(`Run "frankencoin --help" for available commands.`));
    process.exit(1);
  }

  try {
    await cmd.run(flags, restArgs);
  } catch (e) {
    console.error(c.red(`\nError: ${e.message}`));
    if (flags.debug) console.error(e.stack);
    process.exit(1);
  }
}

main();
