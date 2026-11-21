import { McpServer } from "@modelcontextprotocol/server";
import { config } from "../config.js";
import { TOOLS } from "../tools/registry.js";
import { dispatchTool } from "../tools/dispatch.js";
import { mcpSuccess, mcpError } from "../lib/envelope.js";
import { PONDER_ENTITIES } from "../lib/constants.js";
import { renderLlmsTxt } from "./llmsTxt.js";

const workflows = {
  protocol_briefing: "Start with get_protocol_snapshot. Report ZCHF supply by chain, reserve, savings and outstanding challenges. Use get_analytics for historical comparisons. Label units, observation times and unavailable metrics. Distinguish FCS from underlying FPS.",
  collateral_review: "Use get_collateral_assessments to select a report, then get_collaterals and get_positions to verify actual exposure. Compare the proposed terms with live positions. Identify the report date, publication status, concentration and outstanding challenges. Cite the original report.",
};

const catalogueCache = { ttlMs: 300_000, cacheScope: "public" };
const cacheHints = Object.fromEntries([
  "server/discover", "tools/list", "resources/list", "resources/templates/list", "prompts/list", "resources/read",
].map(method => [method, catalogueCache]));

// Modern HTTP builds a server per request. The registry and its schemas are static.
const toolSchemas = TOOLS.map(def => ({
  def,
  inputSchema: def.input.extend(Object.fromEntries(def.params.map(
    ({ name, description }) => [name, def.input.shape[name].describe(description)],
  ))),
}));

export function createMcpServer({ dispatch = dispatchTool } = {}) {
  const server = new McpServer({
    name: "frankencoin", title: "Frankencoin", version: config.version,
    websiteUrl: "https://frankencoin.com",
  }, {
    capabilities: {
      tools: { listChanged: false },
      resources: { listChanged: false },
      prompts: { listChanged: false },
    },
    cacheHints,
    instructions: "For supply, TVL or per-chain supply use get_protocol_snapshot with view=overview. For broader protocol state use its default full view. Use get_knowledge for mechanics. Preserve source timestamps and distinguish unavailable data from zero.",
  });

  for (const { def, inputSchema } of toolSchemas) {
    server.registerTool(def.name, {
      description: def.description, inputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async (args) => {
      try {
        return mcpSuccess(await dispatch(def.name, args));
      } catch (e) {
        return mcpError(e);
      }
    });
  }

  server.registerResource("agent-guide", "frankencoin://docs/guide", {
    title: "Frankencoin agent guide", mimeType: "text/markdown",
  }, (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: renderLlmsTxt(TOOLS, config.publicUrl) }] }));

  server.registerResource("indexer-entities", "frankencoin://indexer/entities", {
    title: "Queryable Ponder entities", mimeType: "application/json",
    description: "Root fields accepted by query_ponder and a bounded example query.",
  }, (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({
    entities: [...PONDER_ENTITIES].sort(), example: "{ analyticDailyLogs(limit: 3) { items { date totalSavings } } }",
  }) }] }));

  for (const [name, text] of Object.entries(workflows)) {
    server.registerPrompt(name, { description: text }, () => ({
      messages: [{ role: "user", content: { type: "text", text } }],
    }));
  }
  return server;
}
