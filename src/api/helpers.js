/**
 * Shared constants, fetch helpers, and number utilities.
 */

import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export const API_BASE = "https://api.frankencoin.com";
export const PONDER_BASE = "https://ponder.frankencoin.com";
export const DUNE_BASE = "https://api.dune.com/api/v1";
export const ETH_RPC = "https://eth.llamarpc.com";
export const GITHUB_API = "https://api.github.com";
export const SITE_REPO = "Frankencoin-ZCHF/frankencoin-site";
export const DOCS_REPO = "Frankencoin-ZCHF/gitbook";

export const CHAIN_NAMES = {
  1: "Ethereum",
  10: "Optimism",
  100: "Gnosis",
  137: "Polygon",
  146: "Sonic",
  8453: "Base",
  42161: "Arbitrum",
  43114: "Avalanche",
};

// CoinGecko IDs for Frankencoin collateral tokens (verified via contract lookup)
export const COINGECKO_IDS = {
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": "weth",
  "0x8c1bed5b9a0928467c9b1341da1d7bd5e10b6549": "liquid-staked-ethereum",  // LsETH
  "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599": "wrapped-bitcoin",          // WBTC
  "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984": "uniswap",
  "0x6810e776880c02933d47db1b9fc05908e5386b96": "gnosis",
  "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0": "wrapped-steth",            // wstETH
  "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": "coinbase-wrapped-btc",     // cbBTC
  "0xd533a949740bb3306d119cc777fa900ba034cd52": "curve-dao-token",
  "0x45804880de22913dafe09f4980848ece6ecbaf78": "pax-gold",
  "0x68749665ff8d2d112fa859aa293f07a622782f38": "tether-gold",
  "0x79d4f0232a66c4c91b89c76362016a1707cfbf4f": "vnx-franc",
  "0xfedc5f4a6c38211c1338aa411018dfaf26612c08": "spdr-sp-500-etf-ondo",
  "0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a": "apple-tokenized-stock-defichain",
  // FPS (0x1bA26...) is NOT on CoinGecko — use Frankencoin API prices/list instead
};

// CHFAU contract on Ethereum (AllUnity)
export const CHFAU_CONTRACT = "0xbd4dfc058eb95b8de5ceaf39966a1a70f5556f78";

// Dune query IDs for Frankencoin dashboards
export const DUNE_QUERIES = {
  zchfHolders: 6712642,
  fpsHolders: 6712643,
  mintingVolume: 6712644,
  savingsDeposits: 6712645,
  savingsTvl: 6712646,
  liquidations: 6712649,
  positionsOpened: 6712650,
  crossChainSupply: 6712648,
};

// ─── API key loading (server-side only, never in output) ──────────────────────

function loadKey(path) {
  try {
    return readFileSync(join(homedir(), path), "utf8").trim();
  } catch {
    return null;
  }
}

export const CG_KEY = process.env.COINGECKO_API_KEY || loadKey(".config/coingecko/api_key");
export const CG_BASE = "https://pro-api.coingecko.com/api/v3";
export const DUNE_KEY = process.env.DUNE_API_KEY || loadKey(".config/dune/api_key");

// ─── Fetch helpers ────────────────────────────────────────────────────────────

export async function apiFetch(path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Frankencoin API error ${res.status}: ${path}`);
  return res.json();
}

export async function ponderQuery(query) {
  const res = await fetch(PONDER_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Ponder error ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data;
}

export async function cgFetch(path) {
  if (!CG_KEY) throw new Error("CoinGecko API key not configured on server");
  const res = await fetch(`${CG_BASE}${path}`, {
    headers: { "x-cg-pro-api-key": CG_KEY, "Accept": "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`CoinGecko error ${res.status}`);
  return res.json();
}

export async function duneExecute(queryId) {
  if (!DUNE_KEY) throw new Error("Dune API key not configured on server");
  const execRes = await fetch(`${DUNE_BASE}/query/${queryId}/execute`, {
    method: "POST",
    headers: { "x-dune-api-key": DUNE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ performance: "medium" }),
    signal: AbortSignal.timeout(10000),
  });
  if (!execRes.ok) throw new Error(`Dune execute error ${execRes.status}`);
  const { execution_id } = await execRes.json();

  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const statusRes = await fetch(`${DUNE_BASE}/execution/${execution_id}/results`, {
      headers: { "x-dune-api-key": DUNE_KEY },
      signal: AbortSignal.timeout(10000),
    });
    if (!statusRes.ok) continue;
    const data = await statusRes.json();
    if (data.state === "QUERY_STATE_COMPLETED") return data.result?.rows || [];
    if (data.state === "QUERY_STATE_FAILED") throw new Error("Dune query failed");
  }
  throw new Error("Dune query timed out");
}

export async function ethCall(contractAddress, data) {
  const res = await fetch(ETH_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "eth_call",
      params: [{ to: contractAddress, data }, "latest"],
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`ETH RPC error: ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`ETH RPC: ${json.error.message}`);
  return json.result;
}

export async function githubFile(repo, path) {
  const res = await fetch(`${GITHUB_API}/repos/${repo}/contents/${path}`, {
    headers: {
      "Accept": "application/vnd.github.v3+json",
      "User-Agent": "frankencoin-mcp",
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${repo}/${path}`);
  const data = await res.json();
  return Buffer.from(data.content, "base64").toString("utf8");
}

export async function githubJson(repo, path) {
  return JSON.parse(await githubFile(repo, path));
}

// ─── Number helpers ───────────────────────────────────────────────────────────

/** Decode BigInt string with given decimals to float */
export function fromWei(val, decimals = 18) {
  if (!val || val === "0") return 0;
  return Number(BigInt(val)) / Math.pow(10, decimals);
}

/** Basis points (×10) to percent: 37500 → 3.75 */
export function bpsToPercent(bps) { return bps / 10000; }

/** PPM to percent */
export function ppmToPercent(ppm) { return ppm / 10000; }
