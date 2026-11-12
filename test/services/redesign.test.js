import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
process.env.CACHE_ENABLED = "false";
const { setFetchImpl } = await import("../../src/upstream/client.js");
const { dispatchTool } = await import("../../src/tools/dispatch.js");
const { SITE_REPO } = await import("../../src/lib/constants.js");
const { siteAbs, absoluteContent } = await import("../../src/services/website.js");
const fixture = JSON.parse(readFileSync(new URL("../fixtures/redesign.json", import.meta.url)));
let calls, failed;
beforeEach(() => {
  calls = []; failed = new Set();
  setFetchImpl(async (url) => {
    calls.push(url);
    assert.ok(url.includes(`${SITE_REPO}/`), "only the redesign repo is queried");
    const api = url.startsWith("https://api.github.com/");
    const path = new URL(url).pathname.split(api ? "/contents/" : "/main/")[1];
    if (failed.has(path) || !fixture[path]) return new Response("not found", { status: 404 });
    const text = JSON.stringify(fixture[path]);
    return new Response(api ? JSON.stringify({ content: Buffer.from(text).toString("base64") }) : text);
  });
});

test("news preserves every media item and both new partners, with usable asset URLs", async () => {
  const out = await dispatchTool("get_news", {});
  assert.equal(out.status, "available");
  assert.equal(out.sourceRepository, "Frankencoin-ZCHF/frankencoin-site-redesign");
  assert.equal(out.media.articles.length, 30);
  assert.equal(out.media.videos.length, 20);
  assert.equal(out.useCases.length, 17);
  assert.equal(out.ecosystem.length, 21);
  assert.ok(!out.ecosystem.some((c) => c.name === "Stay Liquid"));
  for (const name of ["Kraken", "ether.fi"]) {
    assert.ok(out.useCases.some((c) => c.partner === name));
    assert.ok(out.ecosystem.some((c) => c.name === name));
  }
  assert.deepEqual([...new Set(out.media.articles.filter((a) => a.url.includes("tippinpoint.ch")).map((a) => a.siteName))], ["TippinPoint"]);
  assert.deepEqual([...new Set(out.media.articles.filter((a) => a.url.includes("nzz.ch")).map((a) => a.siteName))], ["NZZ"]);
  assert.ok(out.media.videos[0].thumbnail.startsWith("https://frankencoin.com/images/"));
  assert.ok(out.useCases[0].image.startsWith("https://frankencoin.com/images/"));
});

test("redesign compliance retains both legal assessments, all documents, audits and glossary links", async () => {
  const out = await dispatchTool("get_compliance", {});
  assert.equal(out.status, "available");
  assert.match(out.regulatory.swiss.summary, /August 2024/);
  assert.match(out.regulatory.euMica.summary, /February 2026/);
  assert.match(out.regulatory.serviceProviders.summary, /licensing/);
  assert.equal(out.papers.length, 4);
  assert.equal(out.audits.reports.length, 8);
  assert.ok(out.audits.reports.some((r) => r.label.includes("Uniswap")));
  assert.ok(out.audits.reports.some((r) => r.label.includes("FCS")));
  assert.equal(out.contact.url, "mailto:compliance@frankencoin.com");
  assert.equal(out.terminology.length, 3);
  assert.ok(out.regulatory.euMica.documents.some((d) => d.url.includes("%20")));
  assert.ok(out.papers.every((d) => !d.url.includes("%2520")));
});

test("audit failure preserves legal content and marks missing audit data explicitly", async () => {
  failed.add("src/content/en/security.json");
  const out = await dispatchTool("get_compliance", {});
  assert.equal(out.status, "partial");
  assert.equal(out.papers.length, 4);
  assert.equal(out.audits.reports, null);
  assert.equal(out.sources.security.status, "unavailable");
});

test("links use redesigned press assets, current whitepaper and complete exchanges", async () => {
  const out = await dispatchTool("get_knowledge", { topic: "links" });
  assert.equal(out.brand.guidelines, "https://frankencoin.com/press/frankencoin_brand_guidelines.pdf");
  assert.equal(out.brand.assets.length, 6);
  assert.ok(out.developers.whitepaper.includes("zora.uzh.ch"));
  assert.ok(out.exchanges.some((e) => e.name === "Kraken"));
});

test("website discovery has no I/O and complete English/German pages preserve structured content", async () => {
  const catalogue = await dispatchTool("get_knowledge", { topic: "website" });
  assert.equal(calls.length, 0);
  assert.ok(catalogue.pages.length >= 30);
  for (const page of ["association", "press", "security", "integrate", "collateral", "referral", "glossary"]) assert.ok(catalogue.pages.some((p) => p.page === page));
  for (const language of ["en", "de"]) {
    const out = await dispatchTool("get_knowledge", { topic: "website", page: "association", language });
    assert.equal(out.status, "available");
    assert.equal(out.content.people.board.items.length, 3);
    assert.equal(out.content.people.advisers.items.length, 5);
    assert.ok(out.content.people.board.items[0].photo.startsWith("https://frankencoin.com/images/"));
    assert.ok(out.url.endsWith(language === "de" ? "/de/association" : "/association"));
    assert.deepEqual(out.content.membership, absoluteContent(fixture[`src/content/${language}/association.json`].membership));
  }
  const faq = await dispatchTool("get_knowledge", { topic: "website", page: "faq" });
  assert.ok(faq.relatedContent.questions.categories[0].questions.length > 0);
});

test("website failures are partial or unavailable, never empty successful content", async () => {
  failed.add("src/content/de/association.json");
  let out = await dispatchTool("get_knowledge", { topic: "website", page: "association", language: "de" });
  assert.equal(out.status, "partial");
  assert.deepEqual(out.fallbackToEnglish, ["content"]);
  assert.ok(out.content.people);
  failed.add("src/content/en/association.json");
  out = await dispatchTool("get_knowledge", { topic: "website", page: "association", language: "de" });
  assert.equal(out.status, "unavailable");
  assert.equal(out.content, null);
});

test("untrusted page/language values never become outbound paths", async () => {
  for (const page of ["__proto__", "constructor", "../../secrets", "https://evil.example"]) {
    const out = await dispatchTool("get_knowledge", { topic: "website", page });
    assert.match(out.error, /Unknown website page/);
  }
  await assert.rejects(() => dispatchTool("get_knowledge", { topic: "website", language: "../../en" }));
  assert.deepEqual(calls, []);
});

test("asset URLs preserve existing percent encoding and safe schemes", () => {
  assert.equal(siteAbs("/report%20name.pdf"), "https://frankencoin.com/report%20name.pdf");
  assert.equal(siteAbs("/report name.pdf"), "https://frankencoin.com/report%20name.pdf");
  assert.equal(siteAbs("mailto:info@frankencoin.com"), "mailto:info@frankencoin.com");
  assert.equal(siteAbs("javascript:alert(1)"), null);
});

test("insurance uses published terms and does not fabricate missing live quotes", async () => {
  let out = await dispatchTool("get_insurance_products", {});
  assert.equal(out.status, "available");
  assert.equal(out.products[0].roles.issuerOrUnderwriter, "Nexus Mutual");
  assert.equal(out.products[0].pricing.premiumRate, null);
  assert.equal(out.products[0].capacity.underwritingCapacityUsd, null);
  failed.add("src/content/en/insurance.json");
  out = await dispatchTool("get_insurance_products", {});
  assert.equal(out.status, "unavailable");
  assert.equal(out.products, null);
  assert.equal(out.count, null);
});
