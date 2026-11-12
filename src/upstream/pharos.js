/** Versioned report cards plus the public, overall-only safety grade feed. */
import { fetchJson } from "./client.js";
import { withProviderCooldown } from "./cooldown.js";
import { getOrLoad } from "../cache.js";
import { config } from "../config.js";
import { PHAROS_BASE } from "../lib/constants.js";
import { MissingSecretError } from "../lib/errors.js";

export async function pharosReportCards({ publicOnly = false } = {}) {
  if (!publicOnly && !config.pharosKey) throw new MissingSecretError("pharos");
  const url = publicOnly ? `${PHAROS_BASE}/api/safety-grades` : `${PHAROS_BASE}/api/report-cards/v9`;
  return getOrLoad(`pharos:${publicOnly ? "grades" : "v9"}`, 60 * 60_000, () => withProviderCooldown(`pharos:${publicOnly ? "grades" : "v9"}`, async () => ({
    data: await fetchJson(url, { source: "pharos", timeout: 8_000, retries: 0, redirect: "error",
      headers: { ...(publicOnly ? {} : { "X-API-Key": config.pharosKey }), Accept: "application/json", "User-Agent": "frankencoin-mcp" } }),
    retrievedAt: new Date().toISOString(), url,
  })), { swrMs: 15 * 60_000 });
}
