# FCS support and source boundaries

FCS is the canonical holder-facing governance and share token. Each FCS wraps one
underlying FPS; FPS remains the Equity token that determines protocol equity
pricing and economic metrics. This is **not** a global FPS-to-FCS rename. Supplies,
voting records and contract interfaces are distinct.

## Agent-facing contract

No new tool: the registry still exposes 16 public, read-only tools.

- `get_governance?type=fcs`: shared `fcs` reference plus `fcs.state` from the
  documented Frankencoin API. `type=all` includes it too. Other filters include the
  static reference without fetching FCS state. Existing indexed activity is not a
  complete FCS governance or secondary-market trade history.
- `get_protocol_snapshot`: the same `fcs` object alongside the existing `fps`
  economics. Existing FPS fields/units remain unchanged.
- `get_knowledge?topic=fcs` and `topic=fcs_migration`: official GitBook content plus
  curated mechanics and links. `governance`, `pool_shares`, `token_addresses` and
  `links` share that reference. If GitHub is unavailable, reference data remains;
  unavailable document content is null with a note, never fabricated text.
- Registry descriptions feed MCP discovery and `/api`; `/llms.txt` also renders
  the shared FCS reference. CLI governance accepts `--type fcs`.

Ethereum FCS: `0xdb861830d9ae2d1fcf99fa0cfd3973de382b0b5b`.
Underlying Ethereum FPS: `0x1bA26788dfDe592fec8bcB0Eaff472a42BE341B2`.

Current reference links: [mechanics](https://docs.frankencoin.com/pool-shares/fcs),
[migration](https://docs.frankencoin.com/pool-shares/fcs-migration),
[governance docs](https://docs.frankencoin.com/governance),
[governance page](https://frankencoin.com/governance),
[CoW Swap route](https://swap.cow.fi/#/1/swap/USDT/FCS),
[legacy FPS page](https://frankencoin.com/fps).
A trade link is not a liquidity or execution guarantee.

`https://fcs.frankencoin.com` is a **planned future CTA target, not yet live**.
It appears only under `fcs.plannedLinks.website` with `status=planned_not_live`
(and equivalently labelled prose), never as an operational link, application or
upstream data source. This MCP does not fetch or probe that target.

## Live-state decision

Use the existing cached `apiFetch` boundary for
[`GET /fcs/info`](https://docs.frankencoin.com/api-docs/fcs), not guessed RPC
selectors. Its [versioned service](https://github.com/Frankencoin-ZCHF/frankencoin-api/blob/9013d8fadf2bcc251d236c78328958ebcfbe1c26/src/modules/fcs/fcs.service.ts#L22-L55)
reads `ask`, `bid`, `totalAssets`, `totalSupply` and `isBinding` with `FCSABI`.

- Validate the expected Ethereum chain/address and 18 decimals before accepting
  values. The API already scales numbers: **do not divide by 1e18 again**.
- `totalSupply` is FCS. `totalAssetsZchf` is attributable equity in ZCHF, not
  redeemable cash or wrapper-held FPS. `referencePriceZchf.{ask,bid}` is ZCHF/FCS,
  not CHF/USD market pricing or a size-specific execution preview.
- `isBinding=false` and a zero supply remain real values; missing/invalid data is
  null, never coerced to zero/false. Wrong deployment, invalid payloads and source
  errors return `state.status=unavailable`; missing fields return partial data.
- The API substitutes zero when `bid()` fails. Expose that ambiguous zero as null
  with a note, not a verified zero quote. `/fcs/discount` is intentionally not
  consumed: its fallback of 1 likewise cannot distinguish a failed read.
- This is **API-reported contract state**, not independently RPC-verified or
  same-block data. The 30-second MCP cache cannot establish upstream freshness:
  the API exposes no block number or update timestamp, both explicitly null.
- Internal FCS votes, holder votes/delegation, wrapper-held FPS, underlying votes,
  quorum and redemption eligibility are explicitly `notProvided`. FCS supply is
  not used to infer any of them. Dune FPS/ZCHF holders are not FCS holders.

## Mechanics and version provenance

Primary technical sources: the official mechanics, migration and governance docs
above; the documentation repository was inspected at
`Frankencoin-ZCHF/gitbook@7dc671d065bc9ded860f20318d36b1451f076d62`.
Runtime document topics still fetch current official GitBook files.

The [ChainSecurity assessment](https://reports.chainsecurity.com/Frankencoin/ChainSecurity_Frankencoin_FPS2_Audit.pdf)
(14 July 2026) identifies final V3
`c1f229e3b26050367aafcb55da294342b4cae382`. Inspected source:
[FPS2.sol](https://github.com/Frankencoin-ZCHF/FrankenCoin/blob/c1f229e3b26050367aafcb55da294342b4cae382/contracts/equity/fps2/FPS2.sol#L48-L114),
[FPS2MintRedeem.sol](https://github.com/Frankencoin-ZCHF/FrankenCoin/blob/c1f229e3b26050367aafcb55da294342b4cae382/contracts/equity/fps2/FPS2MintRedeem.sol#L25-L96),
[Governance.sol](https://github.com/Frankencoin-ZCHF/FrankenCoin/blob/c1f229e3b26050367aafcb55da294342b4cae382/contracts/equity/Governance.sol#L12-L105).
Source/audit names FPS2 and FPS1 correspond to FCS and underlying FPS in current
docs; the reviewed token uses FPS2 branding, while the API reports FCS. An audit
of a commit does not by itself attest deployed bytecode. No contract is modified.

Preserved distinctions:
- 1:1 applies to wrapping FPS, not investing ZCHF. ZCHF is the ERC-4626 asset.
- Delegation is non-subtractive/transitive. Qualified actions need **>1% internal
  FCS votes** plus the separate underlying FPS quorum (audit: at least 2%).
- Binding requires **>2/3 underlying FPS votes**, not supply, and can reverse.
- Tokens remain on Ethereum; two sets of vote snapshots cross chains (audit pp7–10,
  finding #006). No bridged FCS token is asserted.
- ZCHF redemption needs binding and the wrapper's own legacy 90-day eligibility,
  with discount/curve fees. In V3, unwrapping permits equality with the average
  holding duration and either binding state (source lines 110–114; finding #022,
  audit p22). No guaranteed profit, liquidity, price or simple unconditional exit.

### Unreleased homepage source

Cloned the **canonical** repository branch directly, not a fork or PR branch:
`Frankencoin-ZCHF/frankencoin-site:fcs-launch-homepage`, pinned at
`18a55400de54956b3355a2a8929f98550164cd96`.
The [English homepage launch section](https://github.com/Frankencoin-ZCHF/frankencoin-site/blob/18a55400de54956b3355a2a8929f98550164cd96/src/content/en/index.json#L77-L103)
and matching German content establish canonical positioning, equity participation,
time-weighted governance, 1:1 FPS wrapping and the exact USDT/FCS CoW route.
This snapshot's homepage and footer point to `/fcs`; it is not evidence of a live
subdomain or transactional application. The owner-specified future subdomain above
is therefore planned-only. Technical docs take precedence over simplified or
inconsistent marketing copy elsewhere in this branch. No live homepage scraping.
