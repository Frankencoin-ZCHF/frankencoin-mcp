/**
 * Static content: docs, links, token addresses, media, merch, website content.
 */

import { githubFile, githubJson, SITE_REPO, DOCS_REPO } from "./helpers.js";

// Strip HTML tags from strings
const stripHtml = (str) => str?.replace(/<[^>]+>/g, "") ?? "";

const WEBSITE_SECTIONS = {
  faq: "src/content/en/faq.json",
  governance: "src/content/en/governance.json",
  compliance: "src/content/en/compliance.json",
  what_is: "src/content/en/what-is-frankencoin.json",
  homepage: "src/content/en/index.json",
};

export async function getWebsiteContent({ section = "faq" } = {}) {
  const file = WEBSITE_SECTIONS[section];
  if (!file) {
    return {
      error: `Unknown section: "${section}"`,
      availableSections: Object.keys(WEBSITE_SECTIONS),
    };
  }

  const data = await githubJson(SITE_REPO, file);

  switch (section) {
    case "faq":
      return {
        section,
        title: data.title,
        categories: data.categories.map((cat) => ({
          category: cat.category,
          questions: cat.questions.map((q) => ({
            question: q.question,
            answer: q.answer,
          })),
        })),
        availableSections: Object.keys(WEBSITE_SECTIONS),
        note: "FAQ content from frankencoin.com — use for answering common user questions.",
      };

    case "governance":
      return {
        section,
        title: data.header?.title,
        subtitle: data.header?.subtitle,
        sections: data.sections.map((s) => ({
          title: s.title,
          description: stripHtml(s.description),
        })),
        availableSections: Object.keys(WEBSITE_SECTIONS),
        note: "FPS governance content — how governance works, FPS token mechanics, proposal process.",
      };

    case "compliance":
      return {
        section,
        title: data.title,
        intro: data.intro,
        swiss: {
          title: data.swiss.title,
          subtitle: data.swiss.subtitle,
          description: data.swiss.description,
          keyPoints: data.swiss.keyPoints,
          fpsTitle: data.swiss.fpsTitle,
          fpsDescription: data.swiss.fpsDescription,
          documentLabel: data.swiss.documentLabel,
          documentHref: data.swiss.documentHref,
        },
        eu: {
          title: data.eu.title,
          subtitle: data.eu.subtitle,
          description: data.eu.description,
          keyPoints: data.eu.keyPoints,
          documentLabel: data.eu.documentLabel,
          documentHref: data.eu.documentHref,
        },
        summary: data.summary,
        disclaimer: data.disclaimer,
        availableSections: Object.keys(WEBSITE_SECTIONS),
        note: "Swiss FINMA and EU MiCA regulatory classification — use for compliance questions.",
      };

    case "what_is":
      return {
        section,
        title: data.header?.title,
        subtitle: data.header?.subtitle,
        introduction: data.introduction.map((i) => ({
          title: i.title,
          description: i.description,
        })),
        availableSections: Object.keys(WEBSITE_SECTIONS),
        note: "What is Frankencoin — history, oracle problem, why Frankencoin exists.",
      };

    case "homepage":
      return {
        section,
        tagline: data.hero?.title,
        subtitle: data.hero?.subtitle,
        what_is: {
          title: data.what_is?.title,
          subtitle: data.what_is?.subtitle,
          explanation: data.what_is?.explanation?.map((e) => ({
            title: e.title,
            description: e.description,
          })),
        },
        core_features: {
          title: data.core_features?.title,
          features: data.core_features?.features?.map((f) => ({
            title: f.title,
            description: f.description,
            examples: f.examples,
          })),
        },
        how_it_works: {
          title: data.how_it_works?.title,
          subtitle: data.how_it_works?.subtitle,
          steps: data.how_it_works?.steps?.map((step) => ({
            title: step.title,
            description: Array.isArray(step.description)
              ? step.description.map((d) => `${d.step}: ${d.content}`).join(" ")
              : step.description,
          })),
        },
        how_does_it_work: {
          title: data.how_does_it_work?.title,
          explanation: data.how_does_it_work?.explanation?.map((e) => ({
            title: e.title,
            description: e.description,
            link: e.link,
            linkLabel: e.linkLabel,
          })),
        },
        trust_security: {
          regulatory: {
            title: data.trust_security?.regulatory?.title,
            description: data.trust_security?.regulatory?.description,
          },
          audits_description: data.trust_security?.audits?.description,
        },
        foundation: {
          title: data.foundation?.title,
          description: data.foundation?.description,
          href: data.foundation?.href,
        },
        availableSections: Object.keys(WEBSITE_SECTIONS),
        note: "Homepage content — tagline, features, how it works, trust/security, foundation.",
      };

    default:
      return { error: `Unhandled section: ${section}` };
  }
}

const DOC_FILES = {
  overview: "README.md",
  savings: "savings.md",
  pool_shares: "pool-shares.md",
  governance: "governance.md",
  reserve: "reserve.md",
  risks: "risks.md",
  faq: "faq.md",
  minting: "positions/README.md",
  opening_positions: "positions/open.md",
  auctions: "positions/auctions.md",
  api: "api-docs/README.md",
};

export async function getTokenAddresses() {
  const data = await githubJson(SITE_REPO, "src/content/en/token.json");

  return {
    zchf: {
      name: "Frankencoin",
      symbol: "ZCHF",
      description: data.tokens?.subtitle ?? "Swiss franc ERC-20 stablecoin",
      chains: (data.tokens?.chains ?? []).map((c) => ({
        name: c.name,
        address: c.contract,
        explorer: c.explorerBaseUrl ? `${c.explorerBaseUrl}/${c.contract}` : null,
      })),
    },
    fps: {
      name: "Frankencoin Pool Shares",
      symbol: "FPS",
      description: data.fps?.subtitle ?? "Governance and equity token (Ethereum only)",
      chain: "Ethereum",
      address: data.fps?.chain?.contract ?? "0x1bA26788dfDe592fec8bcB0Eaff472a42BE341B2",
      explorer: `https://etherscan.io/address/${data.fps?.chain?.contract ?? "0x1bA26788dfDe592fec8bcB0Eaff472a42BE341B2"}`,
    },
    svzchf: {
      name: "Frankencoin Savings Vault",
      symbol: "svZCHF",
      description: data.svzchf?.subtitle ?? "ERC-4626 savings vault token",
      chains: (data.svzchf?.chains ?? []).map((c) => ({
        name: c.name,
        address: c.contract,
        explorer: c.explorerBaseUrl ? `${c.explorerBaseUrl}/${c.contract}` : null,
      })),
    },
    note: "Addresses sourced live from the Frankencoin website repository.",
  };
}

export async function getLinks() {
  const [footerData, exchangeData, useCaseData] = await Promise.all([
    githubJson(SITE_REPO, "src/content/en/shared/footer.json"),
    githubJson(SITE_REPO, "src/content/en/exchanges.json"),
    githubJson(SITE_REPO, "src/content/en/use-cases.json"),
  ]);

  const footerLinks = {};
  for (const col of (footerData.footer?.columns ?? [])) {
    const key = col.title.toLowerCase().replace(/[^a-z]/g, "_");
    const links = [
      ...(col.links ?? []),
      ...((col.sections ?? []).flatMap((s) => s.links ?? [])),
    ].map((l) => ({
      label: l.label,
      url: l.href?.startsWith("http") ? l.href : `https://frankencoin.com${l.href}`,
      external: l.external ?? false,
    }));
    footerLinks[key] = links;
  }

  const communityLinks = footerLinks["community"] ?? [];
  const findUrl = (label) => communityLinks.find((l) => l.label.toLowerCase().includes(label.toLowerCase()))?.url ?? null;

  return {
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
      name: e.name,
      type: e.type,
      url: e.link,
      description: e.description,
    })),
    useCaseHighlights: (useCaseData.cases ?? []).map((c) => ({
      title: c.title,
      partner: c.partner,
      category: c.category,
      url: c.link,
    })),
    note: "Links sourced live from the Frankencoin website repository.",
  };
}

export async function getDocs({ section = "overview" } = {}) {
  const file = DOC_FILES[section];
  if (!file) {
    return {
      error: `Unknown section: "${section}"`,
      availableSections: Object.keys(DOC_FILES),
    };
  }

  const content = await githubFile(DOCS_REPO, file);
  return {
    section,
    file,
    source: `https://github.com/${DOCS_REPO}/blob/main/${file}`,
    docsUrl: `https://docs.frankencoin.com/${file.replace(/\.md$/, "").replace(/\/README$/, "")}`,
    content,
    availableSections: Object.keys(DOC_FILES),
  };
}

export async function getMediaAndUseCases() {
  const [mediaData, useCaseData, ecosystemData] = await Promise.all([
    githubJson(SITE_REPO, "src/content/shared/media.json"),
    githubJson(SITE_REPO, "src/content/en/use-cases.json"),
    githubJson(SITE_REPO, "src/content/en/ecosystem.json"),
  ]);

  const articles = (mediaData.articles ?? []).map((url) => {
    const meta = mediaData.articleMetadata?.[url] ?? {};
    return { url, title: meta.title ?? null, description: meta.description ?? null,
      siteName: meta.siteName ?? null, publishedDate: meta.publishedDate ?? null, image: meta.image ?? null };
  });

  const videos = (mediaData.videos ?? []).map((url) => {
    const meta = mediaData.videoMetadata?.[url] ?? {};
    return { url, title: meta.title ?? null, description: meta.description ?? null,
      author: meta.author ?? null, publishedDate: meta.publishedDate ?? null };
  });

  return {
    media: {
      articles,
      videos,
    },
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
  const res = await fetch("https://merch.frankencoin.com/products.json?limit=250", {
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Merch store error ${res.status}`);
  const { products } = await res.json();

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
        title: v.title, price: v.price, compareAtPrice: v.compare_at_price || null,
        available: v.available, sku: v.sku || null,
      })),
      minPrice: p.variants.reduce((min, v) => Math.min(min, parseFloat(v.price)), Infinity).toFixed(2),
      maxPrice: p.variants.reduce((max, v) => Math.max(max, parseFloat(v.price)), 0).toFixed(2),
      available: p.variants.some((v) => v.available),
    })),
    note: "Live from merch.frankencoin.com — prices in USD.",
  };
}
