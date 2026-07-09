/**
 * Xerberus client (api.xerberus.io) — public registry composite scores. Degradable:
 * throws MissingSecretError WITHOUT touching the network when no key is configured.
 * The site pulls protocol/organisation/pool scores from the SAME bulk endpoint and
 * filters client-side, so we do too (token-level ratings live behind Xerberus' MCP
 * servers, not this REST API). Long cache + SWR; secret headers only on this host;
 * redirect:"error" so the key/email never travel cross-host.
 */

import { fetchJson } from "./client.js";
import { getOrLoad } from "../cache.js";
import { config } from "../config.js";
import { XERBERUS_BASE } from "../lib/constants.js";
import { MissingSecretError } from "../lib/errors.js";

export async function xerberusRegistryScores() {
  if (!config.xerberusKey) throw new MissingSecretError("xerberus");
  return getOrLoad(
    "xerberus:registry-scores",
    60 * 60_000,
    () => fetchJson(`${XERBERUS_BASE}/registry/scores?type=protocol,organisation,pool`, {
      source: "xerberus",
      timeout: 8_000,
      redirect: "error",
      headers: {
        "x-api-key": config.xerberusKey,
        "x-user-email": config.xerberusEmail ?? "",
        Accept: "application/json",
      },
    }),
    { swrMs: 15 * 60_000 },
  );
}
