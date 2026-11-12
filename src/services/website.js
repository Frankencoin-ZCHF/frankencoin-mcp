import { githubJson } from "../upstream/github.js";
import { SITE_REPO, SITE_ORIGIN, WEBSITE_PAGES } from "../lib/constants.js";
import { observe, availability } from "../lib/provider.js";

export function siteAbs(href) {
  if (typeof href !== "string" || !href.trim()) return null;
  try {
    const url = new URL(href, SITE_ORIGIN);
    return ["https:", "http:", "mailto:"].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

const linkKeys = new Set(["href", "url", "link", "file", "image", "thumbnail", "photo", "src", "repo", "creatorUrl", "documentHref", "ctaHref", "fileHref"]);
// Keep every content field. Only turn explicit site-relative links/assets into
// absolute URLs so MCP consumers do not resolve them against mcp.frankencoin.com.
export function absoluteContent(value, key = "") {
  if (Array.isArray(value)) return value.map((v) => absoluteContent(v));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, absoluteContent(v, k)]));
  if (typeof value === "string" && value.startsWith("/") && linkKeys.has(key)) return siteAbs(value);
  return value;
}

const contentKeys = new Set(["meta", "seo", "hero", "header", "title", "heroTitle", "eyebrow", "footer", "brand", "site", "buttons", "articles", "frontends", "categories"]);
const usable = (v) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).some((k) => contentKeys.has(k));
const source = (path) => `https://github.com/${SITE_REPO}/blob/main/${path}`;
const pageUrl = (route, language) => route == null ? null : `${SITE_ORIGIN}${language === "de" ? "/de" : ""}${route}`;

export async function getWebsiteContent({ page, language = "en" } = {}) {
  const pages = Object.entries(WEBSITE_PAGES).map(([id, p]) => ({ page: id, url: pageUrl(p.route, language) }));
  const base = { topic: "website", repository: SITE_REPO, branch: "main", language, supportedLanguages: ["en", "de"] };
  if (!["en", "de"].includes(language)) return { ...base, error: "Unsupported language" };
  if (page == null) return { ...base, pages, note: "Choose a page to retrieve its full website content. Technical documentation remains available through the existing knowledge topics." };
  if (!Object.hasOwn(WEBSITE_PAGES, page)) return { ...base, error: `Unknown website page: "${page}"`, pages };
  const definition = WEBSITE_PAGES[page];
  const sources = {}, sourceFiles = [], fallbackToEnglish = [];
  const load = async (name, file, shared = false) => {
    const paths = shared ? [`src/content/shared/${file}.json`] : [`src/content/en/${file}.json`, ...(language === "de" ? [`src/content/de/${file}.json`] : [])];
    const results = await Promise.all(paths.map((path) => observe(githubJson(SITE_REPO, path), usable)));
    paths.forEach((path, i) => {
      sources[`${name}:${shared ? "shared" : i === 0 ? "en" : "de"}`] = results[i].health;
      sourceFiles.push({ section: name, path, url: source(path) });
    });
    if (results.length === 1) return absoluteContent(results[0].value);
    const [en, de] = results.map((r) => r.value);
    if (!de && en) fallbackToEnglish.push(name);
    return en || de ? absoluteContent({ ...(en ?? {}), ...(de ?? {}) }) : null;
  };
  const jobs = [["content", definition.file, false], ...Object.entries(definition.related ?? {}).map(([name, file]) => [name, file, false]), ...Object.entries(definition.shared ?? {}).map(([name, file]) => [name, file, true])];
  const values = await Promise.all(jobs.map(([name, file, shared]) => load(name, file, shared)));
  return {
    ...base, page, url: pageUrl(definition.route, language),
    status: availability(sources), sources, sourceFiles, fallbackToEnglish,
    content: values[0], relatedContent: Object.fromEntries(jobs.slice(1).map(([name], i) => [name, values[i + 1]])),
    note: "Complete published website copy; local content overlays English defaults. Dated figures and template placeholders are editorial content, not live protocol readings. Use the protocol tools for current data.",
  };
}
