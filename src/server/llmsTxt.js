/**
 * Renders /llms.txt — a compact, agent-facing guide to this server, generated
 * from the live tool registry so it can never drift from what the server exposes
 * (see llmstxt.org). Pure function, served as text/plain. The content is public,
 * read-only, and carries no secrets.
 *
 * llms.txt complements MCP: MCP clients discover tools via `tools/list`, but an
 * LLM/agent that finds this server over the open web (or a REST consumer) gets a
 * single self-describing entry point here.
 */

/** Short inline parameter summary; required params get a trailing `*`. */
function paramSummary(params) {
  if (!params || params.length === 0) return "";
  const names = params.map((p) => `\`${p.name}${p.required ? "*" : ""}\``).join(", ");
  return ` _Params: ${names}._`;
}

export function renderLlmsTxt(tools, baseUrl) {
  const out = [];
  const p = (s = "") => out.push(s);

  p("# Frankencoin MCP Server");
  p();
  p(
    "> Real-time Frankencoin (ZCHF) protocol data exposed as Model Context Protocol " +
      "(MCP) tools and a plain JSON REST API. Read-only, public, no API key or " +
      "authentication required.",
  );
  p();
  p(
    "Frankencoin is a decentralized, over-collateralized Swiss-Franc stablecoin (ZCHF) " +
      "with an FPS pool-share token. This server surfaces live supply, prices, peg " +
      "health, savings rates, minting positions, liquidation challenges, governance, " +
      "news/merch, and historical analytics across every supported chain.",
  );
  p();
  p(`Base URL: ${baseUrl}`);
  p();

  p("## How to use");
  p();
  p(
    `- **MCP (Streamable HTTP)** — for AI agents, Claude Desktop, Cursor: \`POST ${baseUrl}/mcp\`. ` +
      "Run the MCP `initialize` handshake, then `tools/list` / `tools/call`. " +
      `Legacy SSE clients: \`GET ${baseUrl}/sse\`.`,
  );
  p(
    `- **REST** — no session required: \`GET ${baseUrl}/api/<tool>[?param=value]\`. ` +
      `Example: \`curl ${baseUrl}/api/get_protocol_snapshot\`.`,
  );
  p(`- **Raw indexer** — \`POST ${baseUrl}/api/query_ponder\` with a read-only GraphQL query.`);
  p(`- **Self-describing manifests** — \`GET ${baseUrl}/health\` and \`GET ${baseUrl}/api\`.`);
  p();
  p(
    "All responses are JSON. The API is read-only and rate limited; upstream data is " +
      "cached briefly for low latency.",
  );
  p();

  p(`## Tools (${tools.length})`);
  p();
  p("Each tool is callable as `GET /api/<name>` (REST) or via MCP `tools/call`.");
  p();
  for (const t of tools) {
    p(`- **${t.name}** — ${t.description}${paramSummary(t.params)}`);
  }
  p();
  p(
    "Parameters marked `*` are required. Full parameter details live in each tool's MCP " +
      "inputSchema (`tools/list`) and in `GET /api`.",
  );
  p();

  p("## Notes");
  p();
  p("- No authentication — public, read-only protocol data.");
  p(
    "- Some fields depend on server-side API keys (CoinGecko, Dune); when absent, the " +
      "affected tool returns partial data plus a `note` instead of failing.",
  );
  p("- Token amounts are decoded to human-readable numbers; rates are percentages.");
  p("- Source, docs, and issues: https://github.com/Frankencoin-ZCHF/frankencoin-mcp");

  return out.join("\n") + "\n";
}
