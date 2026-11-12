import { assessmentIndex } from "../upstream/assessments.js";
import { githubFile } from "../upstream/github.js";
import { ASSESSMENTS_REPO, ASSESSMENT_DOCUMENTS } from "../lib/constants.js";
import { observe, availability } from "../lib/provider.js";

const sourceUrl = (path) => `https://github.com/${ASSESSMENTS_REPO}/blob/main/${path}`;
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// The repository uses JSON between --- delimiters, not YAML. Preserve the
// original file and unknown JSON fields so schema changes never discard data.
export function parseAssessment(content) {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  const markdown = match ? content.slice(match[0].length).trim() : content.trim();
  let metadata = null, metadataStatus = "missing";
  if (match) {
    try {
      const parsed = JSON.parse(match[1]);
      if (object(parsed)) { metadata = parsed; metadataStatus = "parsed"; }
      else metadataStatus = "invalid";
    } catch { metadataStatus = "invalid"; }
  }
  const required = ["asset_name", "asset_ticker", "contract_address", "assessment_date", "author", "links", "risk_scores", "risk_parameters"];
  const missingFields = required.filter((key) => !metadata || !Object.hasOwn(metadata, key));
  const summary = /^##\s+Summary\s*\r?\n([\s\S]*?)(?=^#{1,2}\s|$(?![\s\S]))/mi.exec(markdown)?.[1]?.trim() ?? null;
  return { metadata, metadataStatus, missingFields, summary, markdown, content };
}

export async function getCollateralAssessments({ asset, publication = "all", includeContent = false, document } = {}) {
  const documents = Object.entries(ASSESSMENT_DOCUMENTS).map(([id, path]) => ({ document: id, path, url: sourceUrl(path) }));
  const base = { repository: ASSESSMENTS_REPO, branch: "main", documents,
    note: "Repository research, including drafts and deprecated assessments, is not live collateral approval or executable lending terms. Publication status comes from the directory. Metadata and rates retain their source units; use get_collaterals/get_positions for protocol state. Full source text remains available even when metadata cannot be parsed." };
  if (document != null) {
    if (!Object.hasOwn(ASSESSMENT_DOCUMENTS, document)) return { ...base, error: "Unknown assessment document" };
    const path = ASSESSMENT_DOCUMENTS[document];
    const observed = await observe(githubFile(ASSESSMENTS_REPO, path), (text) => typeof text === "string" && text.trim().length > 0 && !/^\s*(?:<!doctype html|<html)/i.test(text));
    let data = null;
    if (document === "schema" && observed.value) { try { data = JSON.parse(observed.value); } catch { /* retain original text */ } }
    return { ...base, document, path, url: sourceUrl(path), status: observed.health.status, sources: { document: observed.health }, content: observed.value, data };
  }
  if (!["all", "draft", "published", "deprecated"].includes(publication) || (asset != null && !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}$/.test(asset))) return { ...base, error: "Invalid assessment selector" };
  const index = await observe(assessmentIndex(), Array.isArray);
  const sources = { index: index.health };
  if (!index.value) return { ...base, status: "unavailable", sources, total: null, count: null, assessments: null };
  const selected = index.value.filter((entry) => (publication === "all" || entry.publication === publication) && (!asset || entry.asset.toLowerCase() === asset.toLowerCase()));
  const assessments = await Promise.all(selected.map(async (entry) => {
    const observed = await observe(githubFile(ASSESSMENTS_REPO, entry.path), (text) => typeof text === "string" && /^#\s+\S/m.test(text) && !/^\s*(?:<!doctype html|<html)/i.test(text));
    const parsed = observed.value === null ? null : parseAssessment(observed.value);
    const status = parsed ? parsed.metadataStatus === "parsed" && !parsed.missingFields.length ? "available" : "partial" : "unavailable";
    sources[entry.path] = { ...observed.health, status, ...(status === "partial" ? { code: "incomplete_metadata" } : {}) };
    return { ...entry, url: sourceUrl(entry.path), status,
      metadata: parsed?.metadata ?? null, metadataStatus: parsed?.metadataStatus ?? "unavailable", missingFields: parsed?.missingFields ?? null,
      summary: parsed?.summary ?? null,
      ...((asset || includeContent) ? { markdown: parsed?.markdown ?? null, content: parsed?.content ?? null } : {}),
    };
  }));
  return { ...base, status: availability(sources), sources, total: index.value.length, count: assessments.length, assessments,
    ...(asset && !assessments.length ? { error: `No assessment found for "${asset}" with publication=${publication}`, availableAssets: index.value.map(({ asset, publication }) => ({ asset, publication })) } : {}),
  };
}
