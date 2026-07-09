/**
 * Pharos client (api.pharos.watch) — stablecoin-safety report cards. Degradable:
 * throws MissingSecretError WITHOUT touching the network when no key is configured,
 * so the risk service catches it and degrades (ARCHITECTURE §C, like coingecko/dune).
 * Long cache + SWR (Pharos recomputes ~hourly; the site uses a 1h TTL). Secret header
 * only on the Pharos host; redirect:"error" so the key never travels cross-host.
 */

import { fetchJson } from "./client.js";
import { getOrLoad } from "../cache.js";
import { config } from "../config.js";
import { PHAROS_BASE } from "../lib/constants.js";
import { MissingSecretError } from "../lib/errors.js";

// async so the missing-secret case is a REJECTED promise (not a synchronous throw
// that would escape a surrounding Promise.allSettled/all in the service).
export async function pharosReportCards() {
  if (!config.pharosKey) throw new MissingSecretError("pharos");
  return getOrLoad(
    "pharos:report-cards",
    60 * 60_000,
    () => fetchJson(`${PHAROS_BASE}/api/report-cards`, {
      source: "pharos",
      timeout: 8_000,
      redirect: "error",
      headers: { "X-API-Key": config.pharosKey, Accept: "application/json" },
    }),
    { swrMs: 15 * 60_000 },
  );
}
