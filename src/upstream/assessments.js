import { fetchJson } from "./client.js";
import { getOrLoad } from "../cache.js";
import { ASSESSMENTS_REPO, GITHUB_API } from "../lib/constants.js";
import { UpstreamError } from "../lib/errors.js";

// Discovery is confined to this public repository. User input never supplies a
// URL or path; the service selects only regular Markdown blobs from this list.
const pattern = /^assessments\/(draft|published|deprecated)\/([A-Za-z0-9_-][A-Za-z0-9_.-]*)\.md$/;
export function assessmentEntry(entry) {
  if (entry?.type !== "blob" || !["100644", "100755"].includes(entry.mode)) return null;
  const match = pattern.exec(entry.path);
  return match ? { asset: match[2], publication: match[1], path: entry.path, sha: entry.sha ?? null } : null;
}
const options = { source: "github", timeout: 10_000, retries: 0, headers: { Accept: "application/vnd.github.v3+json", "User-Agent": "frankencoin-mcp" } };

export function assessmentIndex() {
  return getOrLoad("gh:collateral-assessment-index", 6 * 60 * 60_000, async () => {
    try {
      const data = await fetchJson(`${GITHUB_API}/repos/${ASSESSMENTS_REPO}/git/trees/main?recursive=1`, options);
      if (!Array.isArray(data?.tree) || data.truncated) throw new UpstreamError("github");
      return data.tree.map(assessmentEntry).filter(Boolean).sort((a, b) => a.path.localeCompare(b.path));
    } catch {
      // Git Trees outages/truncation need not hide the three known directories.
      // Do not pretend partial discovery is a complete repository listing.
      const groups = await Promise.all(["draft", "published", "deprecated"].map(async (publication) => {
        const entries = await fetchJson(`${GITHUB_API}/repos/${ASSESSMENTS_REPO}/contents/assessments/${publication}?ref=main`, options);
        if (!Array.isArray(entries) || entries.length >= 1000 || entries.some((e) => e.type === "dir")) throw new UpstreamError("github");
        return entries.filter((e) => e.type === "file" && e.path?.startsWith(`assessments/${publication}/`))
          .map((e) => assessmentEntry({ ...e, type: "blob", mode: "100644" })).filter(Boolean);
      }));
      return groups.flat().sort((a, b) => a.path.localeCompare(b.path));
    }
  }, { swrMs: 6 * 60 * 60_000 });
}
