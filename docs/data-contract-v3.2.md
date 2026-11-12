# Data contract v3.2 — redesigned website and collateral assessments

This release changes source readers, not deployed content or protocol parameters. Merge and redeploy the MCP PR to run it; merge the companion website PR for the publisher normalization and glossary links to appear upstream. GitHub content uses a 6-hour TTL plus 6-hour stale-while-revalidate; restarting the stateless service clears its cache.

## Website migration

- All website reads use `Frankencoin-ZCHF/frankencoin-site-redesign/main`. Technical documentation remains in `Frankencoin-ZCHF/gitbook`; existing knowledge topic names and tools remain available.
- `get_knowledge` adds `topic=website`, optional `page`, and `language=en|de`. Omit `page` for the fixed catalogue of 34 content groups. Every JSON field is retained, including shared media/frontend listings and related FAQ/home content. Explicit relative link and asset fields become absolute website URLs. HTML/Markdown body strings retain their authored markup. German top-level content overlays English defaults as on the website. `sources`, `sourceFiles`, `fallbackToEnglish` and `status` expose missing content. Copy may contain runtime placeholders or dated figures; it is not live protocol data.
- `get_compliance` reads the new jurisdiction rows and documents, plus the complete audit list from `security.json`. It preserves full source wording, all four legal document links, all eight current audit links, the provider section and glossary links. Existing `regulatory`, `papers`, `audits`, `contact` fields remain; `classification` is null where the new source has no separate classification field. Read `summary` for the full assessment. A failed security source preserves legal content with partial status and tries the old index audit block; missing audit data is null. Legacy compliance input remains supported.
- `get_news` preserves every listed media item, use case and ecosystem partner, including Kraken and ether.fi. The companion website PR normalizes outlet names at source. Metadata absent from the source remains null; the MCP does not scrape external publishers. Asset URLs are absolute.
- `get_knowledge?topic=links` uses redesigned press downloads and the actual linked whitepaper. URL normalization preserves already encoded filenames and `mailto:` links.
- `get_insurance_products` reads the full insurance listing and terms from the website, including exclusions and eligibility. Former hardcoded premium/capacity values are now null because the current source provides no fixed quote. Existing product IDs and main response fields remain; `details` preserves the complete website record.

## Collateral research

`get_collateral_assessments` is a new tool, also exposed through REST, MCP, the generated manifests and `frankencoin assessments` CLI.

| Parameter | Behavior |
| --- | --- |
| omitted selectors | Discover all reports, return structured metadata and summaries |
| `asset=WBTC` | Case-insensitive catalogue ID; full source and Markdown for all matching lifecycle versions |
| `publication=all\|published\|draft\|deprecated` | Filter by the source directory; default `all` |
| `includeContent=true` | Full source and Markdown for every selected report |
| `document=overview\|framework\|schema\|template\|validator\|workflow` | Full supporting document; schema also returned as parsed JSON |

The repository is fixed to `Frankencoin-ZCHF/frankencoin-collateral-assessments/main`. Regular Markdown files are discovered from its Git tree, with a three-directory Contents fallback for tree failures/truncation. New asset files appear without server code changes. An unavailable index is explicit, never a fabricated empty catalogue. The present flat directory layout is supported; discovery selectors do not accept paths, hosts or symlinks.

Each report includes its directory status, source path/URL/blob SHA, complete JSON frontmatter, author/date/links as authored, summary, and optional unabridged text. Unknown metadata fields and original units are retained. JSON parsing and required-field presence are reported, not claimed to be full JSON Schema validation. Malformed or missing frontmatter preserves readable Markdown with partial status. Unavailable files remain listed with null data and per-file diagnostics. Supporting documents are returned as data, not executed.

Research publication status does not imply accepted on-chain collateral. Risk scores, proposed rates, reserves and minting limits are not live executable parameters. `get_collaterals` and `get_positions` retain their separate protocol-data roles. Full reports preserve any discussion/source links present in their text or metadata; this integration does not fetch GitHub Discussion threads or linked external documents.

## Validation and fixture provenance

The suite uses the actual public website and assessment schemas, complete reports, malformed/failing source cases, input/path isolation checks and REST/MCP SDK parity. Run `npm ci` and `npm test` with Node 20–22. No build step or new dependency is introduced.

- `test/fixtures/redesign.json`: selected source files from website commit `bb570f8159dbb0bcab98f25b9ff68cc104b0e09b`, including the companion media-name and compliance glossary edits.
- `test/fixtures/assessments.json`: all 27 non-placeholder files and recursive tree retrieved on 2026-11-12, tree SHA `8db997f73e736fcd82f9ffba1be6f238a3cd14b2`; includes all 21 reports (18 published, 3 draft).

Existing v3.1 financial-unit, fallback and FCS/FPS distinctions remain unchanged. No deployment, merge, token operations or new credentials are part of the implementation.
