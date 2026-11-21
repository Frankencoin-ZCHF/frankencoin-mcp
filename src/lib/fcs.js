/** Curated FCS reference shared by knowledge, governance and snapshot. No I/O. */
import { githubFile } from "../upstream/github.js";
import { DOCS_REPO, FCS_CONTRACT, FPS_CONTRACT } from "./constants.js";

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
      repository: "Frankencoin-ZCHF/frankencoin-site-redesign",
      branch: "main",
      url: "https://github.com/Frankencoin-ZCHF/frankencoin-site-redesign/blob/main/src/content/en/fcs.json",
      note: "Released website content; the canonical page is https://frankencoin.com/fcs. Technical documentation takes precedence over simplified website positioning.",
    },
    documentation: {
      url: "https://github.com/Frankencoin-ZCHF/gitbook/blob/main/fcs.md",
      note: "Current documentation supersedes the historical audit's terminology. Runtime knowledge content follows main; neither source proves deployed bytecode.",
    },
    mechanics: {
      commit: "c1f229e3b26050367aafcb55da294342b4cae382",
      contract: "https://github.com/Frankencoin-ZCHF/FrankenCoin/blob/c1f229e3b26050367aafcb55da294342b4cae382/contracts/equity/fps2/FPS2.sol",
      audit: "https://reports.chainsecurity.com/Frankencoin/ChainSecurity_Frankencoin_FPS2_Audit.pdf",
      note: "Historical audited V3 snapshot uses FPS2/FPS1 names. Current docs describe the later FCS rebrand. Do not treat this audit snapshot as current deployment evidence.",
    },
  },
  underlying: {
    symbol: "FPS",
    address: FPS_CONTRACT,
    role: "Underlying Equity token; continues to determine protocol equity pricing and economic metrics",
    wrapRatio: "1 FPS : 1 FCS",
    note: "FCS and FPS have separate supplies, voting records and interfaces. FCS supply is not total FPS supply or a measurement of wrapper-held FPS.",
  },

};

/** Small identity/reference block for state tools; knowledge topics retain full mechanics. */
export async function fcsContext(includeContext = false) {
  if (includeContext) {
    const document = await githubFile(DOCS_REPO, "fcs.md").catch(() => null);
    const valid = typeof document === "string" && /^#\s+\S/m.test(document);
    const sections = Object.fromEntries((valid ? document : "").split(/^## /m).slice(1).map((section) => {
      const newline = section.indexOf("\n");
      return [section.slice(0, newline).trim(), section.slice(newline + 1).trim()];
    }));
    return { ...FCS_REFERENCE, mechanics: valid ? { document,
      entry: sections["Entry paths"] ?? null, voting: sections.Voting ?? null,
      qualification: sections.Voting ?? null, delegation: sections.Voting ?? null,
      binding: sections.Binding ?? null, exit: sections["Exit paths and eligibility"] ?? null,
      accounting: sections["Accounting and ERC-4626 views"] ?? null } : null,
      mechanicsSource: { url: `https://github.com/${DOCS_REPO}/blob/main/fcs.md`,
        status: valid ? "available" : "unavailable" } };
  }
  const { name, symbol, role, chainId, chain, address, underlying, links } = FCS_REFERENCE;
  return { name, symbol, role, chainId, chain, address,
    underlying: { symbol: underlying.symbol, address: underlying.address, wrapRatio: underlying.wrapRatio, note: underlying.note },
    links: { website: links.website, mechanics: links.mechanics, apiReference: links.apiReference },
    context: { included: false, tool: "get_knowledge", arguments: { topic: "fcs" } },
  };
}
