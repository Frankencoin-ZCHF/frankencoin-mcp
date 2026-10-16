/** Curated FCS reference shared by knowledge, governance and snapshot. No I/O. */
import { FCS_CONTRACT, FPS_CONTRACT } from "./constants.js";

export const FCS_REFERENCE = {
  name: "Frankencoin Share Token",
  symbol: "FCS",
  role: "Canonical holder-facing governance and share token of Frankencoin",
  chainId: 1,
  chain: "Ethereum",
  address: FCS_CONTRACT,
  links: {
    website: "https://frankencoin.com/fcs",
    mechanics: "https://docs.frankencoin.com/pool-shares/fcs",
    migration: "https://docs.frankencoin.com/pool-shares/fcs-migration",
    governance: "https://docs.frankencoin.com/governance",
    governancePage: "https://frankencoin.com/governance",
    trade: "https://swap.cow.fi/#/1/swap/USDT/FCS",
    legacyFps: "https://frankencoin.com/fps",
    apiReference: "https://docs.frankencoin.com/api-docs/fcs",
    explorer: `https://etherscan.io/address/${FCS_CONTRACT}`,
  },
  sources: {
    website: {
      repository: "Frankencoin-ZCHF/frankencoin-site",
      branch: "main",
      commit: "444f8318b25068b46b81b8117b661a0119740fe4",
      url: "https://github.com/Frankencoin-ZCHF/frankencoin-site/blob/444f8318b25068b46b81b8117b661a0119740fe4/src/content/en/fcs.json",
      note: "Released website content; the canonical page is https://frankencoin.com/fcs. Technical documentation takes precedence over simplified website positioning.",
    },
    documentation: {
      commit: "a1322816a282debedd8ab3dfae89a7f1364f4590",
      url: "https://github.com/Frankencoin-ZCHF/gitbook/blob/a1322816a282debedd8ab3dfae89a7f1364f4590/fcs.md",
      note: "Current documentation supersedes the historical audit's naming and two-tier quorum. Runtime knowledge content follows main; neither source proves deployed bytecode.",
    },
    mechanics: {
      commit: "c1f229e3b26050367aafcb55da294342b4cae382",
      contract: "https://github.com/Frankencoin-ZCHF/FrankenCoin/blob/c1f229e3b26050367aafcb55da294342b4cae382/contracts/equity/fps2/FPS2.sol",
      audit: "https://reports.chainsecurity.com/Frankencoin/ChainSecurity_Frankencoin_FPS2_Audit.pdf",
      note: "Historical audited V3 snapshot uses FPS2/FPS1 names. Current docs describe the later FCS rebrand and shared 1% quorum; do not treat this audit snapshot as current deployment evidence.",
    },
  },
  underlying: {
    symbol: "FPS",
    address: FPS_CONTRACT,
    role: "Underlying Equity token; continues to determine protocol equity pricing and economic metrics",
    wrapRatio: "1 FPS : 1 FCS",
    note: "FCS and FPS have separate supplies, voting records and interfaces. FCS supply is not total FPS supply or a measurement of wrapper-held FPS.",
  },
  mechanics: {
    entry: "Each FCS wraps one underlying FPS. The 1:1 ratio applies to FPS wrapping, not a 1:1 ZCHF investment. ZCHF is the ERC-4626 asset; deposit/mint buys underlying FPS on its curve. Wrapping credits the FPS votes lost by the sender; fresh investment and WFPS migration provide no immediate carried votes.",
    qualification: "Current official documentation specifies a shared quorum of more than 1% of voting power, including valid delegation, for FCS-based and direct legacy FPS actions. It supersedes the historical audit's higher underlying-FPS threshold. Read the relevant contract and synchronised votes for action eligibility; token balances alone do not establish it.",
    delegation: "Delegation is non-subtractive and transitive: the holder retains the ability to act; each address counts only once in a delegation chain.",
    voting: "Votes grow with balance and holding duration. cap(holder) applies a 365-day duration cap only when called for that holder; it is not automatic expiry. attack() destroys votes, not tokens.",
    binding: "Binding requires more than two thirds of underlying FPS votes, not FPS supply or internal FCS votes. isBinding() checks FPS1.relativeVotes(address(this)) * 3 > 2e18. Binding is reversible and separate from governance quorum.",
    crossChain: "FCS tokens stay on Ethereum; vote snapshots, not FCS tokens, cross chains. Both the wrapper's underlying FPS votes and individual FCS votes must be synchronised; snapshots can be stale and a sync can overwrite local delegation.",
    exit: "ZCHF redemption requires binding and the wrapper's own FPS 90-day holding-duration eligibility, with curve fees and the redemption discount; no new personal 90-day FCS wait. Unwrap returns one FPS per FCS when the holder's duration is at least the FCS holder average, in either binding state; legacy voting age is not restored. Market sales depend on route liquidity and quotes, separately from protocol redemption.",
    accounting: "In audited V3, totalAssets = ZCHF.equity() * FCS.totalSupply() / FPS1.totalSupply(). This is attributable equity in ZCHF, not immediately redeemable cash, market capitalisation or the wrapper's full FPS balance.",
    risk: "No guaranteed profit, valuation, liquidity or exit proceeds. FCS participates in reserve income and losses and can lose all value. Read operation-specific previews and limits before transacting; this MCP is read-only.",
  },
};
