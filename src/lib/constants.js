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
export const ETH_RPC = "https://ethereum-rpc.publicnode.com";
export const ETH_RPC_FALLBACKS = [ETH_RPC, "https://eth.drpc.org"];
export const GITHUB_API = "https://api.github.com";
export const GITHUB_RAW = "https://raw.githubusercontent.com";
export const MERCH_BASE = "https://merch.frankencoin.com";
export const MERCH_URL = `${MERCH_BASE}/products.json?limit=250`;
// Shopify's own MCP servers for this store — agents interact with the store DIRECTLY
// here (search / cart / checkout); this read-only server only points at them, never proxies.
export const MERCH_STOREFRONT_MCP = `${MERCH_BASE}/api/mcp`;
export const MERCH_UCP_MCP = `${MERCH_BASE}/api/ucp/mcp`;

// Independent third-party risk-rating providers (same ones frankencoin.com integrates).
// Hosts are hard-coded here — env supplies only the API keys/email, never the destination.
export const PHAROS_BASE = "https://api.pharos.watch";
export const XERBERUS_BASE = "https://api.xerberus.io/public/v1";

export const SITE_REPO = "Frankencoin-ZCHF/frankencoin-site-redesign";
export const SITE_ORIGIN = "https://frankencoin.com";
export const DOCS_REPO = "Frankencoin-ZCHF/gitbook";
export const ASSESSMENTS_REPO = "Frankencoin-ZCHF/frankencoin-collateral-assessments";
export const ASSESSMENT_DOCUMENTS = {
  overview: "README.md",
  framework: "framework/collateral-risk-framework.md",
  schema: "schema/collateral-assessment.schema.json",
  template: "templates/assessment-template.md",
  validator: "scripts/validate.js",
  workflow: ".github/workflows/validate.yml",
};

// Provider-specific identifiers are reviewed adapter routes. Indexed token
// deployments come independently from /godeye/tokens, including new chains.
export const CHAIN_ADAPTERS = {
  1: { name: "Ethereum", dex: "ethereum", rpc: "ethereum" },
  10: { name: "Optimism", dex: "optimism", rpc: "optimism" },
  100: { name: "Gnosis", dex: "gnosischain", rpc: "gnosis" },
  137: { name: "Polygon", dex: "polygon", rpc: "polygon-bor" },
  146: { name: "Sonic", dex: "sonic", rpc: "sonic" },
  8453: { name: "Base", dex: "base", rpc: "base" },
  42161: { name: "Arbitrum", dex: "arbitrum", rpc: "arbitrum-one" },
  43114: { name: "Avalanche", dex: "avalanche", rpc: "avalanche-c-chain" },
};

export function chainName(id) {
  return CHAIN_ADAPTERS[id]?.name ?? `Chain ${id}`;
}

// AllUnity CHFAU contract on Ethereum (6 decimals).
export const CHFAU_CONTRACT = "0xbd4dfc058eb95b8de5ceaf39966a1a70f5556f78";

// FCS is the holder-facing share/governance token; FPS remains underlying Equity.
export const FCS_CONTRACT = "0xdb861830d9ae2d1fcf99fa0cfd3973de382b0b5b";
// FPS (Frankencoin Pool Shares) — Ethereum only.
export const FPS_CONTRACT = "0x1bA26788dfDe592fec8bcB0Eaff472a42BE341B2";

// ── Risk ratings (get_risk) ──────────────────────────────────────────────────

// Pharos v9 uses three pillars; do not map legacy v8 dimensions onto them.
export const PHAROS_STABLECOIN_ID = "zchf-frankencoin";
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
  fcs: "fcs.md",
  fcs_migration: "fcs-migration.md",
  governance: "governance.md",
  reserve: "reserve.md",
  risks: "risks.md",
  faq: "faq.md",
  minting: "positions/README.md",
  opening_positions: "positions/open.md",
  auctions: "positions/auctions.md",
  api: "api-docs/README.md",
};

// All knowledge topics (docs + token_addresses + links + compliance + frontends).
export const KNOWLEDGE_TOPICS = [
  "overview", "what_is", "faq", "savings", "governance", "minting",
  "opening_positions", "auctions", "risks", "reserve", "pool_shares", "fcs", "fcs_migration",
  "api", "compliance", "frontends", "token_addresses", "links", "website", "index",
];

// Fixed content catalogue, independent of caller-supplied paths. Existing GitBook
// topics remain unchanged; topic=website exposes the complete redesign copy.
export const WEBSITE_PAGES = {
  home: { file: "home", route: "/", related: { details: "index", faq: "faq", ecosystem: "ecosystem" } },
  what_is: { file: "what-is-frankencoin", route: "/what-is-frankencoin" },
  how_it_works: { file: "how-it-works", route: "/how-it-works" },
  save_in_chf: { file: "save-in-chf", route: "/use-cases/save-in-chf" },
  borrow: { file: "borrow", route: "/use-cases/borrow" },
  savers: { file: "savers", route: "/for/savers" },
  treasuries: { file: "treasuries", route: "/for/treasuries" },
  exchanges_wallets: { file: "exchanges-wallets", route: "/for/exchanges-wallets" },
  developers: { file: "developers", route: "/for/developers" },
  integrate: { file: "integrate", route: "/integrate" },
  collateral: { file: "collateral", route: "/integrate/collateral" },
  referral: { file: "referral", route: "/referral" },
  fcs: { file: "fcs", route: "/fcs" },
  governance: { file: "governance", route: "/governance" },
  transparency: { file: "transparency", route: "/transparency" },
  security: { file: "security", route: "/security" },
  compliance: { file: "compliance", route: "/compliance" },
  insurance: { file: "insurance", route: "/insurance" },
  compare: { file: "compare", route: "/compare" },
  dollar: { file: "dollar", route: null },
  faq: { file: "faq-page", route: "/faq", related: { questions: "faq" } },
  glossary: { file: "glossary", route: "/glossary" },
  use_cases: { file: "use-cases", route: "/use-cases" },
  ecosystem: { file: "ecosystem", route: "/ecosystem" },
  exchanges: { file: "exchanges", route: null },
  token_addresses: { file: "token", route: "/token" },
  frontends: { file: "frontends", route: "/frontends", shared: { listings: "frontends" } },
  news: { file: "news", route: "/news", shared: { media: "media" } },
  press: { file: "press", route: "/press" },
  association: { file: "association", route: "/association" },
  navigation: { file: "shared/nav", route: null },
  footer: { file: "shared/footer", route: null },
  site: { file: "shared/site", route: null },
  ui: { file: "shared/ui", route: null },
};

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
