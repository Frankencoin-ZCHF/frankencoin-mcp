/**
 * get_knowledge (Tool 9), get_news (Tool 10), get_merch (Tool 11).
 *
 * get_knowledge.topic maps through a FIXED allow-list (DOC_FILES / special topics)
 * to a fixed path — an unknown topic returns { error, availableTopics } and NEVER
 * builds a GitHub path from the raw value (no traversal — SECURITY §7 / T28).
 */

import { githubFile, githubJson } from "../upstream/github.js";
import { merchProducts } from "../upstream/merch.js";
import { SITE_REPO, DOCS_REPO, DOC_FILES, KNOWLEDGE_TOPICS, FPS_CONTRACT } from "../lib/constants.js";

export async function getKnowledge({ topic = "overview" } = {}) {
  if (topic === "token_addresses") return getTokenAddresses();
  if (topic === "compliance") return getCompliance();
  if (topic === "links") return getLinks();

  const file = DOC_FILES[topic];
  if (!file) {
    return { error: `Unknown topic: "${topic}"`, availableTopics: KNOWLEDGE_TOPICS };
  }

  const content = await githubFile(DOCS_REPO, file);
  return {
    topic,
    file,
    source: `https://github.com/${DOCS_REPO}/blob/main/${file}`,
    docsUrl: `https://docs.frankencoin.com/${file.replace(/\.md$/, "").replace(/\/README$/, "")}`,
    content,
    availableTopics: KNOWLEDGE_TOPICS,
  };
}

async function getTokenAddresses() {
  const data = await githubJson(SITE_REPO, "src/content/en/token.json");
  const mapChains = (chains) => (chains ?? []).map((c) => ({
    name: c.name,
    address: c.contract,
    explorer: c.explorerBaseUrl ? `${c.explorerBaseUrl}/${c.contract}` : null,
  }));

  return {
    topic: "token_addresses",
    zchf: {
      name: "Frankencoin",
      symbol: "ZCHF",
      description: data.tokens?.subtitle ?? "Swiss franc ERC-20 stablecoin",
      chains: mapChains(data.tokens?.chains),
    },
    fps: {
      name: "Frankencoin Pool Shares",
      symbol: "FPS",
      description: data.fps?.subtitle ?? "Governance and equity token (Ethereum only)",
      chain: "Ethereum",
      address: data.fps?.chain?.contract ?? FPS_CONTRACT,
      explorer: `https://etherscan.io/address/${data.fps?.chain?.contract ?? FPS_CONTRACT}`,
    },
    svzchf: {
      name: "Frankencoin Savings Vault",
      symbol: "svZCHF",
      description: data.svzchf?.subtitle ?? "ERC-4626 savings vault token",
      chains: mapChains(data.svzchf?.chains),
    },
    note: "Addresses sourced live from the Frankencoin website repository.",
  };
}

async function getLinks() {
  const [footerData, exchangeData, useCaseData] = await Promise.all([
    githubJson(SITE_REPO, "src/content/en/shared/footer.json"),
    githubJson(SITE_REPO, "src/content/en/exchanges.json"),
    githubJson(SITE_REPO, "src/content/en/use-cases.json"),
  ]);

  const footerLinks = {};
  for (const col of footerData.footer?.columns ?? []) {
    const key = col.title.toLowerCase().replace(/[^a-z]/g, "_");
    footerLinks[key] = [
      ...(col.links ?? []),
      ...((col.sections ?? []).flatMap((s) => s.links ?? [])),
    ].map((l) => ({
      label: l.label,
      url: l.href?.startsWith("http") ? l.href : `https://frankencoin.com${l.href}`,
      external: l.external ?? false,
    }));
  }

  const communityLinks = footerLinks.community ?? [];
  const findUrl = (label) =>
    communityLinks.find((l) => l.label.toLowerCase().includes(label.toLowerCase()))?.url ?? null;

  return {
    topic: "links",
    app: {
      main: "https://app.frankencoin.com",
      mint: "https://app.frankencoin.com/mint",
      savings: "https://app.frankencoin.com/savings",
      equity: "https://app.frankencoin.com/equity",
      governance: "https://app.frankencoin.com/governance",
      monitoring: "https://app.frankencoin.com/monitoring/collateral",
      bridge: "https://app.frankencoin.com/transfer",
    },
    website: "https://frankencoin.com",
    community: {
      twitter: findUrl("twitter"),
      telegram: findUrl("telegram"),
      linkedin: findUrl("linkedin"),
      youtube: findUrl("youtube"),
      forum: findUrl("discussion"),
      events: findUrl("events"),
      merch: findUrl("merch"),
    },
    developers: {
      docs: "https://docs.frankencoin.com",
      api: "https://api.frankencoin.com",
      whitepaper: "https://app.frankencoin.com/thesis-frankencoin.pdf",
      github: "https://github.com/Frankencoin-ZCHF",
    },
    analytics: {
      defillama: "https://defillama.com/protocol/frankencoin",
      coingecko: "https://www.coingecko.com/en/coins/frankencoin",
      dune: "https://dune.com/frankencoin",
    },
    brand: {
      logos: "https://github.com/Frankencoin-ZCHF/www/tree/main/media_kit",
      guidelines: "https://frankencoin.com/Frankencoin_Brand_Guidelines.pdf",
    },
    footer: footerLinks,
    exchanges: (exchangeData.exchanges ?? []).map((e) => ({
      name: e.name, type: e.type, url: e.link, description: e.description,
    })),
    useCaseHighlights: (useCaseData.cases ?? []).map((c) => ({
      title: c.title, partner: c.partner, category: c.category, url: c.link,
    })),
    note: "Links sourced live from the Frankencoin website repository.",
  };
}

// Prefix relative site paths with the canonical origin; leave absolute + mailto as-is.
const SITE_ORIGIN = "https://frankencoin.com";
function siteAbs(href) {
  if (!href) return null;
  if (/^(https?:|mailto:)/i.test(href)) return href;
  // Site-hosted PDF filenames contain raw spaces — encode so the URL is directly
  // fetchable. encodeURI is idempotent for already-encoded (%20) sequences.
  return encodeURI(`${SITE_ORIGIN}${href.startsWith("/") ? "" : "/"}${href}`);
}

/**
 * get_compliance — legal & regulatory posture with every relevant paper/link.
 * Sourced live from the Frankencoin site repo (compliance.json + the audits block
 * of index.json). Also backs get_knowledge?topic=compliance. Informational, not legal
 * advice.
 */
export async function getCompliance() {
  const [c, index] = await Promise.all([
    githubJson(SITE_REPO, "src/content/en/compliance.json"),
    githubJson(SITE_REPO, "src/content/en/index.json"),
  ]);

  const audits = index.trust_security?.audits ?? {};

  // Some audit partners expose one report, others several (sublinks). Flatten both.
  const auditReports = (audits.partners ?? []).flatMap((p) => {
    if (Array.isArray(p.sublinks) && p.sublinks.length) {
      return p.sublinks.map((s) => ({ firm: p.altText, label: s.label, url: siteAbs(s.href) }));
    }
    return [{ firm: p.altText, label: "Audit report", url: siteAbs(p.href) }];
  }).filter((r) => r.url);

  const swissDoc = c.swiss?.documentHref
    ? { label: c.swiss.documentLabel ?? "Swiss Legal Classification (PDF)", url: siteAbs(c.swiss.documentHref) }
    : null;
  const euDocs = (c.eu?.documents ?? []).map((d) => ({ label: d.label, url: siteAbs(d.href) }));

  // Flat "papers" list agents can cite directly — the legal opinions + white paper + register.
  const papers = [
    swissDoc && { category: "Swiss (FINMA)", ...swissDoc },
    ...euDocs.map((d) => ({ category: "EU (MiCA)", ...d })),
  ].filter(Boolean);

  return {
    topic: "compliance",
    title: c.title ?? "Frankencoin Compliance",
    intro: c.intro ?? null,
    regulatory: {
      swiss: {
        classification: c.swiss?.subtitle ?? null,
        summary: c.swiss?.description ?? null,
        assessor: "LEXR Law Switzerland AG",
        keyPoints: (c.swiss?.keyPoints ?? []).map((k) => ({ title: k.title, description: k.description })),
        fps: c.swiss?.fpsTitle
          ? { title: c.swiss.fpsTitle, description: c.swiss.fpsDescription ?? null }
          : null,
        document: swissDoc,
      },
      euMica: {
        classification: c.eu?.subtitle ?? null,
        summary: c.eu?.description ?? null,
        assessor: "LEXR Germany Rechtsanwalts GmbH",
        keyPoints: (c.eu?.keyPoints ?? []).map((k) => ({ title: k.title, description: k.description })),
        documents: euDocs,
      },
    },
    papers,
    audits: {
      description: audits.description ?? null,
      reports: auditReports,
      bugBounty: audits.bugBounty
        ? { label: audits.bugBounty.label, description: audits.bugBounty.description, url: siteAbs(audits.bugBounty.href) }
        : null,
    },
    contact: {
      title: c.contact?.title ?? null,
      description: c.contact?.description ?? null,
      email: "compliance@frankencoin.com",
      url: siteAbs(c.contact?.ctaHref) ?? "mailto:compliance@frankencoin.com",
    },
    summary: c.summary?.description ?? null,
    disclaimer: c.disclaimer?.text
      ?? "This information summarizes independent legal assessments and does not constitute legal advice.",
    compliancePageUrl: `${SITE_ORIGIN}/compliance`,
    note: "Compliance content sourced live from the Frankencoin website repository. Informational only — not legal advice.",
  };
}

export async function getNews() {
  const [mediaData, useCaseData, ecosystemData] = await Promise.all([
    githubJson(SITE_REPO, "src/content/shared/media.json"),
    githubJson(SITE_REPO, "src/content/en/use-cases.json"),
    githubJson(SITE_REPO, "src/content/en/ecosystem.json"),
  ]);

  const articles = (mediaData.articles ?? []).map((url) => {
    const meta = mediaData.articleMetadata?.[url] ?? {};
    return {
      url,
      title: meta.title ?? null,
      description: meta.description ?? null,
      siteName: meta.siteName ?? null,
      publishedDate: meta.publishedDate ?? null,
      image: meta.image ?? null,
    };
  });

  const videos = (mediaData.videos ?? []).map((url) => {
    const meta = mediaData.videoMetadata?.[url] ?? {};
    return {
      url,
      title: meta.title ?? null,
      description: meta.description ?? null,
      author: meta.author ?? null,
      publishedDate: meta.publishedDate ?? null,
    };
  });

  return {
    media: { articles, videos },
    useCases: (useCaseData.cases ?? []).map((c) => ({
      title: c.title, partner: c.partner, category: c.category, description: c.description, url: c.link,
    })),
    ecosystem: (ecosystemData.tabs ?? []).map((t) => ({
      name: t.name, category: t.category ?? t.badge, description: t.description, url: t.href,
    })),
    note: "Content sourced live from the Frankencoin website repository.",
  };
}

export async function getMerch() {
  const { products } = await merchProducts();
  return {
    storeUrl: "https://merch.frankencoin.com",
    totalProducts: products.length,
    products: products.map((p) => ({
      title: p.title,
      handle: p.handle,
      url: `https://merch.frankencoin.com/products/${p.handle}`,
      description: p.body_html?.replace(/<[^>]+>/g, "").trim() || null,
      type: p.product_type || null,
      tags: p.tags || [],
      images: p.images.map((i) => i.src),
      options: p.options.map((o) => ({ name: o.name, values: o.values })),
      variants: p.variants.map((v) => ({
        title: v.title,
        price: v.price,
        compareAtPrice: v.compare_at_price || null,
        available: v.available,
        sku: v.sku || null,
      })),
      minPrice: p.variants.reduce((min, v) => Math.min(min, parseFloat(v.price)), Infinity).toFixed(2),
      maxPrice: p.variants.reduce((max, v) => Math.max(max, parseFloat(v.price)), 0).toFixed(2),
      available: p.variants.some((v) => v.available),
    })),
    note: "Live from merch.frankencoin.com — prices in USD.",
  };
}
