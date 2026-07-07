/**
 * query_ponder validator (SECURITY §2). Parses the client query into an AST and
 * reasons over it — regex/substring checks are bypassable and NOT used for the
 * security decisions. All rejections throw ValidationError with a FIXED generic
 * message (no user input, no parser text, no upstream detail) — SECURITY §2.4.
 *
 * Evaluate in order; first failure wins.
 */

import { parse, visit, Kind } from "graphql";
import { config } from "../config.js";
import { ValidationError } from "../lib/errors.js";
import { PONDER_ENTITIES } from "../lib/constants.js";

// Approved generic reasons — the ONLY strings ever returned to a client.
const MSG = {
  invalid: "invalid GraphQL query",
  readOnly: "only read-only queries are allowed",
  tooLarge: "query too large",
  deep: "query too deeply nested",
  complex: "query too complex",
  introspection: "introspection is not permitted",
  batched: "batched queries are not allowed",
  limit: "limit argument may not exceed 1000",
};

/**
 * Validate a GraphQL query string. Returns the query unchanged if it passes,
 * otherwise throws ValidationError. Does NOT perform any network I/O.
 */
export function validateGraphqlQuery(query) {
  if (typeof query !== "string" || query.length === 0) {
    throw new ValidationError(MSG.invalid);
  }

  // Q2 — size cap (before parsing, to bound parser cost).
  if (query.length > config.ponderMaxQueryBytes) {
    throw new ValidationError(MSG.tooLarge);
  }

  // Parse into an AST. Any syntax error → generic "invalid GraphQL query"
  // (never echo the parser's positional message — it can reflect input).
  let ast;
  try {
    ast = parse(query, { noLocation: true });
  } catch {
    throw new ValidationError(MSG.invalid);
  }

  // Q3 — exactly one operation; bounded fragment reuse.
  const operations = ast.definitions.filter((d) => d.kind === Kind.OPERATION_DEFINITION);
  const fragments = ast.definitions.filter((d) => d.kind === Kind.FRAGMENT_DEFINITION);
  if (operations.length !== 1) {
    throw new ValidationError(operations.length > 1 ? MSG.batched : MSG.invalid);
  }
  if (fragments.length > config.ponderMaxFragments) {
    throw new ValidationError(MSG.complex);
  }

  // Q4 — read-only: the operation must be a query (no mutation/subscription).
  if (operations[0].operation !== "query") {
    throw new ValidationError(MSG.readOnly);
  }

  // Single AST pass computing every structural counter.
  let fieldCount = 0;
  let aliasCount = 0;
  let directiveCount = 0;
  let argNodeCount = 0;
  let depth = 0;
  let maxDepth = 0;
  let violation = null; // first field-level rejection captured during traversal

  visit(ast, {
    Field: {
      enter(node) {
        fieldCount++;
        const name = node.name.value;
        // Q5 — introspection roots rejected; __typename explicitly allowed.
        if ((name === "__schema" || name === "__type") && !violation) {
          violation = MSG.introspection;
        }
        if (node.alias) aliasCount++;
        depth++;
        if (depth > maxDepth) maxDepth = depth;
      },
      leave() {
        depth--;
      },
    },
    Directive() {
      directiveCount++;
    },
    Argument(node) {
      argNodeCount++;
      // Q9 — argument literal size; Q-limit — limit:>1000.
      const v = node.value;
      if ((v.kind === Kind.STRING || v.kind === Kind.INT || v.kind === Kind.FLOAT) &&
          typeof v.value === "string" && v.value.length > config.ponderMaxArgLiteral && !violation) {
        violation = MSG.complex;
      }
      if (node.name.value === "limit" && v.kind === Kind.INT) {
        const n = Number(v.value);
        if (Number.isFinite(n) && n > config.ponderMaxLimitArg && !violation) {
          violation = MSG.limit;
        }
      }
    },
  });

  if (violation) throw new ValidationError(violation);

  // Q6 — depth, Q7 — field count, Q8 — aliases, Q10 — directives, Q9 — arg nodes.
  if (maxDepth > config.ponderMaxDepth) throw new ValidationError(MSG.deep);
  if (fieldCount > config.ponderMaxFields) throw new ValidationError(MSG.complex);
  if (aliasCount > config.ponderMaxAliases) throw new ValidationError(MSG.complex);
  if (directiveCount > config.ponderMaxDirectives) throw new ValidationError(MSG.complex);
  if (argNodeCount > config.ponderMaxArgNodes) throw new ValidationError(MSG.complex);

  // Root-field allowlist: every top-level selection must be a known entity
  // (or the allowed __typename meta-field).
  for (const sel of operations[0].selectionSet.selections) {
    if (sel.kind !== Kind.FIELD) continue; // fragments handled via their own defs
    const rootName = sel.name.value;
    if (rootName === "__typename") continue;
    if (!PONDER_ENTITIES.has(rootName)) {
      throw new ValidationError(MSG.complex);
    }
  }

  return query;
}

export const PONDER_REASONS = MSG;
