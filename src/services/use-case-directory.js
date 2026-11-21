import { config } from "../config.js";
import { SITE_REPO, SITE_ORIGIN } from "../lib/constants.js";
import { fetchFile } from "../upstream/github.js";

const path = "src/content/en/use-cases.json";
const source = `https://github.com/${SITE_REPO}/blob/main/${path}`;
const headings = {
  buy: "Buy ZCHF", pay: "Pay with ZCHF", save: "Save in Swiss francs",
  borrow: "Borrow ZCHF", invest: "Invest in Frankencoin",
};
const idPattern = /^[a-z0-9][a-z0-9-]{0,79}$/;

function parseDirectory(text, previouslyMapped) {
  const { cases, gettingStarted } = JSON.parse(text);
  if (!Array.isArray(cases)) throw new Error("Invalid use-case directory");
  const mapped = gettingStarted !== undefined;
  if ((!mapped && previouslyMapped) || (mapped && (!gettingStarted || typeof gettingStarted !== "object" || Array.isArray(gettingStarted)))) throw new Error("Invalid guide selection");
  const byId = new Map();
  const listings = cases.map(row => {
    if (![row.title, row.partner, row.description, row.link].every(v => typeof v === "string" && v.trim())) throw new Error("Invalid listing");
    const link = new URL(row.link, SITE_ORIGIN);
    if (!/^https?:$/.test(link.protocol) || link.username || link.password) throw new Error("Invalid listing link");
    const item = { title: row.title, partner: row.partner, description: row.description, category: row.category, link: link.href };
    if (mapped) {
      if (typeof row.id !== "string" || !idPattern.test(row.id) || byId.has(row.id)) throw new Error("Invalid listing ID");
      byId.set(row.id, item);
    }
    return item;
  });
  const examples = {};
  for (const key of Object.keys(headings)) {
    const ids = mapped ? gettingStarted[key] : [];
    if (!Array.isArray(ids) || !ids.every(id => typeof id === "string" && idPattern.test(id))) throw new Error("Invalid example IDs");
    examples[key] = [...new Set(ids)].filter(id => byId.has(id)).map(id => byId.get(id));
  }
  return { listings, examples, mapped };
}

// One validated snapshot per server process. A successful empty directory replaces the previous one.
let current, pending, retryAt = 0;
export async function readUseCaseDirectory() {
  if (config.cacheEnabled && current && Date.now() < retryAt) return current;
  if (pending) return pending;
  pending = (async () => {
    const checkedAt = new Date().toISOString();
    try {
      const data = parseDirectory(await fetchFile(SITE_REPO, path), current?.data?.mapped);
      current = { data, health: { status: "available", source, checkedAt, lastSuccessAt: checkedAt } };
      retryAt = Date.now() + 5 * 60_000;
    } catch {
      current = { data: current?.data ?? null, health: { status: current?.data ? "stale" : "unavailable",
        source, checkedAt, lastSuccessAt: current?.health.lastSuccessAt ?? null } };
      retryAt = Date.now() + 30_000;
    }
    return current;
  })().finally(() => { pending = null; });
  return pending;
}

export function renderGettingStarted(data) {
  const lines = ["ZCHF is a digital Swiss franc you can hold in your wallet and send to others.", ""];
  for (const [key, heading] of Object.entries(headings)) {
    const entries = data?.examples[key] ?? [];
    const examples = entries.map(row => {
      const label = row.partner.replace(/[\\[\]]/g, "\\$&");
      const url = row.link.replace(/\(/g, "%28").replace(/\)/g, "%29");
      return `[${label}](${url}) — ${row.description}`;
    });
    lines.push(`- **${heading}.**${examples.length ? " " + examples.join(" ") : ""}`);
  }
  return [...lines, "", `[Explore more use cases](${SITE_ORIGIN}/use-cases)`].join("\n");
}
