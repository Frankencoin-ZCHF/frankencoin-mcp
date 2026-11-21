# Data assumptions in the v4 MCP

The source review below focuses on literals that affect a user-facing answer or its coverage. Runtime limits and provider hosts also exist in configuration.

| Area | Current behaviour | Consequence |
| --- | --- | --- |
| Sized liquidity | `services/market-directory.js` discovers online Kraken base-ZCHF pairs; CoinGecko supplies additional indexed markets. Successful catalogues cache for ten minutes, failed attempts for thirty seconds. `services/quotes.js` has Kraken and Velora price adapters. | A new indexed venue can appear without code changes. Executable-size estimates need a supported adapter. Market-data failure returns unknown coverage. |
| DEX quotes | `services/quotes.js` uses Velora, six chain-specific USDC addresses, six decimals for USDC and eighteen for Frankencoin tokens. `services/pools.js` discovers pools independently through DEX Screener. | A route through another quote asset or network may be missed even when a pool exists. |
| Chains and tokens | `lib/constants.js`, `services/ledgers.js`, `services/receipt.js` and `services/pools.js` maintain chain names, token addresses, RPC hosts and provider chain identifiers. | Website deployment data and analytics coverage can diverge. Newly deployed chains require changes in multiple places. |
| Collateral enrichment and peer comparisons | CoinGecko IDs are mapped by collateral address. The CHF peer comparison names ZCHF, VCHF and CHFAU. Macro assets are BTC and ETH. | A new collateral can appear in protocol data while lacking external enrichment. A new CHF stablecoin does not enter the peer comparison automatically. |
| Missing financial inputs | `services/positions.js` falls back to 18 decimals and zero for some missing terms. `services/snapshot.js` substitutes zero for missing profit/loss inputs in the net calculation. `services/savings.js` substitutes zero in some aggregate sums. | Missing inputs can produce plausible amounts or percentages. These paths should propagate unknown values or explicitly mark partial coverage. |
| Peg and stress | `services/monitor.js` measures historical peg candles on Kraken ZCHF/CHF; stress assumes CHF parity. `lib/numbers.js` sets 0.5% and 1% peg bands; `lib/prices.js` uses a 24-hour stale threshold. | These encode a benchmark, scenario and monitoring policy. Other venues can show a different peg. |
| FCS explanations | `lib/fcs.js` embeds governance, holding-duration, wrapping and exit explanations alongside pinned references. Current contract reads are separate. | Text can outlive a contract or documentation revision. |
| Risk and analytics coverage | Fixed Dune query IDs, Pharos rating pillars and three Xerberus entity IDs live in `lib/constants.js`. Event feeds, report endpoints, supported swap signatures and field lists are also curated. | Newly added datasets, actions and protocols can be absent until mapped. |
| Editorial content | `services/content.js` contains fixed app and analytics links and identifies OpenCover by an exact URL. Knowledge topics and website page mappings are curated. Getting-started listings are read from the website. | Partner metadata or navigation can drift even when the website itself changes. |
| Integration boundaries | Contract selectors, event hashes, trusted provider hosts, permitted query roots, request limits and timeouts are explicit. | Changes require review because they affect interpretation, access or reliability. |

Paths in the table are relative to `src/`.
