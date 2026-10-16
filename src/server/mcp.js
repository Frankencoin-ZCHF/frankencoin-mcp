/**
 * MCP server factory. Builds a fresh McpServer per session (the SDK's McpServer is
 * stateful and binds to one transport — intentional, per CLAUDE.md). Registers the
 * 16 tools from the registry; each delegates to the single dispatch path.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "../config.js";
import { TOOLS } from "../tools/registry.js";
import { dispatchTool } from "../tools/dispatch.js";
import { mcpSuccess, mcpError } from "../lib/envelope.js";

export function createMcpServer() {
  const server = new McpServer({ name: "frankencoin", version: config.version });

  for (const def of TOOLS) {
    server.registerTool(def.name, { description: def.description, inputSchema: def.input }, async (args) => {
      try {
        return mcpSuccess(await dispatchTool(def.name, args));
      } catch (e) {
        return mcpError(e);
      }
    });
  }

  return server;
}
