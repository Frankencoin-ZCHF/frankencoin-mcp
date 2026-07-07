/**
 * The single dispatch path shared by MCP and REST. Look up → zod validate/coerce/
 * clamp/reject-unknown → handler → raw domain object. The caller applies the envelope.
 */

import { TOOL_MAP } from "./registry.js";
import { NotFoundError, ValidationError, AppError } from "../lib/errors.js";

export async function dispatchTool(name, rawArgs = {}) {
  const def = TOOL_MAP.get(name);
  if (!def) throw new NotFoundError(`unknown tool: ${name}`);

  let args;
  try {
    args = def.input.parse(rawArgs ?? {});
  } catch (e) {
    // Zod validation failure → generic safe message (never echo zod's raw issues).
    throw new ValidationError("invalid request parameters");
  }

  // Handler may itself throw typed AppErrors (e.g. query_ponder's generic reasons) —
  // let those propagate unchanged; the error mapper handles them by type.
  try {
    return await def.handler(args);
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw e; // unexpected → mapped to a generic 500 by the error mapper
  }
}
