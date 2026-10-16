/**
 * GitHub Contents API client (unauthenticated). Long cache (6 h + SWR) — docs/site
 * JSON change rarely and this also dodges GitHub's 60-req/hr unauth limit.
 * repo + path are always built from fixed allow-lists (no client path segment reaches
 * the URL — SECURITY §7).
 */

import { fetchJson } from "./client.js";
import { getOrLoad } from "../cache.js";
import { GITHUB_API, GITHUB_RAW } from "../lib/constants.js";
import { UpstreamError } from "../lib/errors.js";

const TTL = 6 * 60 * 60_000; // 6 h
const SWR = 6 * 60 * 60_000;

async function fetchFile(repo, path) {
  try {
    const data = await fetchJson(`${GITHUB_API}/repos/${repo}/contents/${path}`, {
      source: "github", timeout: 10_000, retries: 0,
      headers: { Accept: "application/vnd.github.v3+json", "User-Agent": "frankencoin-mcp" },
    });
    if (typeof data?.content !== "string") throw new UpstreamError("github");
    return Buffer.from(data.content, "base64").toString("utf8");
  } catch {
    // Same fixed public repository/path on its verified default branch. No credentials,
    // user-selected destinations or data substitution; raw delivery avoids Contents quotas.
    return fetchJson(`${GITHUB_RAW}/${repo}/main/${path}`, {
      source: "github", timeout: 10_000, retries: 0, expectJson: false,
      headers: { Accept: "text/plain", "User-Agent": "frankencoin-mcp" },
    });
  }
}

export function githubFile(repo, path) {
  return getOrLoad(`gh:${repo}/${path}`, TTL, () => fetchFile(repo, path), { swrMs: SWR });
}

export async function githubJson(repo, path) {
  return JSON.parse(await githubFile(repo, path));
}
