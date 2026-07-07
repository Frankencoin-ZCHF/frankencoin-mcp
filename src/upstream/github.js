/**
 * GitHub Contents API client (unauthenticated). Long cache (6 h + SWR) — docs/site
 * JSON change rarely and this also dodges GitHub's 60-req/hr unauth limit.
 * repo + path are always built from fixed allow-lists (no client path segment reaches
 * the URL — SECURITY §7).
 */

import { fetchJson } from "./client.js";
import { getOrLoad } from "../cache.js";
import { GITHUB_API } from "../lib/constants.js";
import { UpstreamError } from "../lib/errors.js";

const TTL = 6 * 60 * 60_000; // 6 h
const SWR = 6 * 60 * 60_000;

async function fetchFile(repo, path) {
  const data = await fetchJson(`${GITHUB_API}/repos/${repo}/contents/${path}`, {
    source: "github",
    timeout: 10_000,
    headers: { Accept: "application/vnd.github.v3+json", "User-Agent": "frankencoin-mcp" },
  });
  if (typeof data?.content !== "string") throw new UpstreamError("github");
  return Buffer.from(data.content, "base64").toString("utf8");
}

export function githubFile(repo, path) {
  return getOrLoad(`gh:${repo}/${path}`, TTL, () => fetchFile(repo, path), { swrMs: SWR });
}

export async function githubJson(repo, path) {
  return JSON.parse(await githubFile(repo, path));
}
