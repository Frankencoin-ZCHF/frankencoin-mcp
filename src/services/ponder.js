/**
 * query_ponder (Tool 13) — validated raw GraphQL passthrough to Ponder.
 *
 * Flow: AST-validate (SECURITY §2) → forward to the hard-pinned Ponder host → cap the
 * serialized result at 1 MB. All rejections are fixed generic strings; upstream text,
 * the query, and the Ponder URL never appear in errors (SECURITY §2.4).
 */

import { validateGraphqlQuery } from "../upstream/ponderValidate.js";
import { ponderQuery } from "../upstream/ponder.js";
import { config } from "../config.js";
import { ValidationError } from "../lib/errors.js";

export async function runPonderQuery(query) {
  validateGraphqlQuery(query); // throws ValidationError on any violation

  // Short TTL (20 s): still dedupes identical repeated queries without masking updates.
  const data = await ponderQuery(query, 20_000);

  // Result-size cap: never relay a multi-MB payload back through us.
  if (JSON.stringify(data ?? null).length > config.ponderMaxResultBytes) {
    throw new ValidationError("query result too large — narrow your query");
  }
  return data;
}
