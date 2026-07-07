/**
 * Response shaping shared by REST and MCP. Pure.
 *
 * REST success:  { ok:true,  tool, result }        (pretty-printed by the caller)
 * REST error:    { ok:false, tool, error, code }
 * MCP success:   { content:[{type:"text", text:<pretty JSON of data>}] }
 * MCP error:     { content:[{type:"text", text:"Error: <safe msg>"}], isError:true }
 */

import { mapError } from "./errors.js";

export function restSuccess(tool, result) {
  return { ok: true, tool, result };
}

export function restError(tool, err) {
  const { clientMessage, code } = mapError(err);
  return { ok: false, tool, error: clientMessage, code };
}

export function mcpSuccess(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function mcpError(err) {
  const { clientMessage } = mapError(err);
  return { content: [{ type: "text", text: `Error: ${clientMessage}` }], isError: true };
}

/** Pretty JSON string (2-space) used for every REST body — success and error alike. */
export function pretty(obj) {
  return JSON.stringify(obj, null, 2);
}
