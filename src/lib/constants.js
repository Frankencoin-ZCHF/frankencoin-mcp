/**
 * Static protocol constants: upstream base URLs, chain names, CoinGecko id map,
 * Dune query ids, known contract addresses, docs file map, ponder entity allowlist.
 *
 * Pure data — no I/O. All upstream hosts are hard-coded here and NOWHERE else,
 * so no client-supplied value can ever influence an outbound destination (SECURITY §7).
 */

export const API_BASE = "https://api.frankencoin.com";
export const PONDER_BASE = "https://ponder.frankencoin.com";
export const DUNE_BASE = "https://api.dune.com/api/v1";
export const CG_BASE = "https://pro-api.coingecko.com/api/v3";
export const ETH_RPC = "https://eth.llamarpc.com";
export const GITHUB_API = "https://api.github.com";
export const MERCH_URL = "https://merch.frankencoin.com/products.json?limit=250";

// Independent third-party risk-rating providers (same ones frankencoin.com integrates).
// Hosts are hard-coded here — env supplies only the API keys/email, never the destination.
export const PHAROS_BASE = "https://api.pharos.watch";
export const XERBERUS_BASE = "https://api.xerberus.io/public/v1";

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

export function chainName(id) {
  return CHAIN_NAMES[id] || `Chain ${id}`;
}

// CoinGecko ids for Frankencoin collateral tokens (keyed by lowercase ETH address).
export const COINGECKO_IDS = {
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": "weth",
  "0x8c1bed5b9a0928467c9b1341da1d7bd5e10b6549": "liquid-staked-ethereum", // LsETH
  "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599": "wrapped-bitcoin", // WBTC
  "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984": "uniswap",
  "0x6810e776880c02933d47db1b9fc05908e5386b96": "gnosis",
  "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0": "wrapped-steth", // wstETH
  "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": "coinbase-wrapped-btc", // cbBTC
  "0xd533a949740bb3306d119cc777fa900ba034cd52": "curve-dao-token",
  "0x45804880de22913dafe09f4980848ece6ecbaf78": "pax-gold",
  "0x68749665ff8d2d112fa859aa293f07a622782f38": "tether-gold",
  "0x79d4f0232a66c4c91b89c76362016a1707cfbf4f": "vnx-franc",
  "0xfedc5f4a6c38211c1338aa411018dfaf26612c08": "spdr-sp-500-etf-ondo",
  "0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a": "apple-tokenized-stock-defichain",
  // FPS (0x1bA26…) is deliberately absent — not listed on CoinGecko.
};

// AllUnity CHFAU contract on Ethereum (6 decimals).
export const CHFAU_CONTRACT = "0xbd4dfc058eb95b8de5ceaf39966a1a70f5556f78";

// FPS (Frankencoin Pool Shares) — Ethereum only.
export const FPS_CONTRACT = "0x1bA26788dfDe592fec8bcB0Eaff472a42BE341B2";

// ── Risk ratings (get_risk) ──────────────────────────────────────────────────

// Pharos stablecoin-safety report card id for ZCHF, and its five scored dimensions.
export const PHAROS_STABLECOIN_ID = "zchf-frankencoin";
export const PHAROS_DIMENSIONS = [
  { key: "pegStability", label: "Peg Stability" },
  { key: "liquidity", label: "Liquidity / Exit Capacity" },
  { key: "resilience", label: "Resilience" },
  { key: "decentralization", label: "Decentralization" },
  { key: "dependencyRisk", label: "Dependency Risk" },
];

// The Frankencoin entities the site surfaces from Xerberus' bulk registry/scores feed.
export const XERBERUS_FC_ENTITIES = [
  { type: "protocol", id: "frankencoin", name: "Frankencoin", subtitle: "Protocol" },
  { type: "organisation", id: "frankencoin-dao", name: "Frankencoin", subtitle: "DAO" },
  { type: "pool", id: "frankencoin-savings-eth", name: "Frankencoin Savings", subtitle: "Ethereum Vault" },
];

// Dune query ids for the Frankencoin dashboards.
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

// get_knowledge topic → docs markdown file (fixed allow-list; no path traversal, SECURITY §7).
export const DOC_FILES = {
  overview: "README.md",
  what_is: "README.md",
  savings: "savings.md",
  pool_shares: "pool-shares.md",
  governance: "governance.md",
  reserve: "reserve.md",
  risks: "risks.md",
  faq: "faq.md",
  minting: "positions/README.md",
  opening_positions: "positions/open.md",
  auctions: "positions/auctions.md",
  api: "api-docs/README.md",
};

// All 15 knowledge topics (docs + token_addresses + links + compliance).
export const KNOWLEDGE_TOPICS = [
  "overview", "what_is", "faq", "savings", "governance", "minting",
  "opening_positions", "auctions", "risks", "reserve", "pool_shares",
  "api", "compliance", "token_addresses", "links",
];

// Ponder root-field allowlist for query_ponder (SECURITY §2.2 Q-allowlist / §1).
export const PONDER_ENTITIES = new Set([
  "mintingHubV2PositionV2s",
  "mintingHubV1PositionV1s",
  "mintingHubV2ChallengeV2s",
  "mintingHubV1ChallengeV1s",
  "equityTrades",
  "analyticDailyLogs",
  "savingsActivity",
  "savingsMappings",
  "frankencoinMinters",
  "eRC20Balances",
  "eRC20TotalSupplys",
  "leadrateRateChangeds",
  "frankencoinProfitLosss",
  "equityTradeCharts",
]);
