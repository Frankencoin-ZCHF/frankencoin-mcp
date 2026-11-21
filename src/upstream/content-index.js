import { getOrLoad } from "../cache.js";
import { DOCS_REPO, SITE_REPO, GITHUB_API } from "../lib/constants.js";
import { UpstreamError } from "../lib/errors.js";
import { fetchJson } from "./client.js";

export function contentIndex(website) {
  const repo = website ? SITE_REPO : DOCS_REPO;
  const pattern = website ? /^src\/content\/en\/([a-z0-9-]+(?:\/[a-z0-9-]+)*)\.json$/ :
    /^([a-z\d][a-z\d_-]*(?:\/[a-z\d][a-z\d_-]*)*)\.md$/i;
  return getOrLoad("content-index:" + repo, 3600_000, async () => {
    const result = await fetchJson(`${GITHUB_API}/repos/${repo}/git/trees/main?recursive=1`,
      { source: "github", timeout: 5000, retries: 0 });
    if (!Array.isArray(result?.tree) || result.truncated) throw new UpstreamError("github");
    return Object.fromEntries(result.tree.flatMap((entry) => {
      if (entry.type !== "blob" || entry.mode !== "100644") return [];
      const match = pattern.exec(entry.path);
      if (!match) return [];
      return [[(website ? "page:" : "doc:") + match[1], website ? match[1] : entry.path]];
    }));
  }, { swrMs: 900_000 });
}
