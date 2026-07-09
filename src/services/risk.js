/**
 * get_risk — independent third-party risk ratings for Frankencoin (ZCHF), the same
 * ratings surfaced on frankencoin.com's Trust & Security section.
 *
 *   source=pharos   → Pharos stablecoin-safety report card (overall grade/score +
 *                     five dimensions: peg stability, liquidity, resilience,
 *                     decentralization, dependency risk).
 *   source=xerberus → Xerberus composite risk scores (0–100) for the Frankencoin
 *                     protocol, DAO, and Ethereum savings vault.
 *   source=all      → both (default).
 *
 * Degradable (like get_dune_stats): a provider WITHOUT its API key returns a soft
 * "not configured" note instead of throwing, so the tool never hard-fails.
 * Ratings are produced by EXTERNAL protocols, not the Frankencoin DAO.
 */

import { pharosReportCards } from "../upstream/pharos.js";
import { xerberusRegistryScores } from "../upstream/xerberus.js";
import { isoFromUnix } from "../lib/numbers.js";
import { PHAROS_STABLECOIN_ID, PHAROS_DIMENSIONS, XERBERUS_FC_ENTITIES } from "../lib/constants.js";
import { MissingSecretError } from "../lib/errors.js";

const isRecord = (v) => typeof v === "object" && v !== null;
const str = (v) => (typeof v === "string" && v ? v : null);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Interpret a 0–100 composite/dimension score as a coarse band (mirrors the site). */
function scoreBand(score) {
  if (score == null) return "not_rated";
  if (score >= 70) return "strong";
  if (score >= 40) return "moderate";
  return "weak";
}

// ── Pharos ────────────────────────────────────────────────────────────────────

function parsePharos(body) {
  if (!isRecord(body) || !Array.isArray(body.cards)) return null;
  const card = body.cards.find((c) => isRecord(c) && c.id === PHAROS_STABLECOIN_ID);
  if (!isRecord(card)) return null;

  const cardDims = isRecord(card.dimensions) ? card.dimensions : {};
  const dimensions = PHAROS_DIMENSIONS.map(({ key, label }) => {
    const d = isRecord(cardDims[key]) ? cardDims[key] : {};
    const score = num(d.score);
    return {
      key,
      label,
      grade: str(d.grade) ?? "NR",
      score,
      band: scoreBand(score),
      detail: str(d.detail) ?? "Dimension unavailable",
    };
  });

  const overallScore = num(card.overallScore);
  const methodology = isRecord(body.methodology) ? body.methodology : null;

  return {
    provider: "Pharos",
    providerUrl: "https://pharos.watch",
    name: str(card.name) ?? "Frankencoin",
    symbol: str(card.symbol) ?? "ZCHF",
    overallGrade: str(card.overallGrade) ?? "NR",
    overallScore,
    overallBand: scoreBand(overallScore),
    methodologyVersion: methodology ? str(methodology.version) : null,
    updatedAt: isoFromUnix(num(body.updatedAt)),
    dimensions,
    note: "Stablecoin-safety report card. Scores are 0–100; higher is safer.",
  };
}

async function getPharosSection() {
  try {
    const parsed = parsePharos(await pharosReportCards());
    if (!parsed) {
      return { note: "Pharos returned no report card for ZCHF.", rating: null };
    }
    return parsed;
  } catch (e) {
    if (e instanceof MissingSecretError) {
      return { note: "Pharos API key not configured — stablecoin-safety ratings unavailable.", rating: null };
    }
    throw e;
  }
}

// ── Xerberus ────────────────────────────────────────────────────────────────

function parseXerberus(body) {
  const data = isRecord(body) && Array.isArray(body.data) ? body.data : [];
  const byKey = new Map(
    data.filter(isRecord).map((r) => [`${r.type}:${r.id}`, r]),
  );

  return XERBERUS_FC_ENTITIES.map((e) => {
    const r = byKey.get(`${e.type}:${e.id}`) ?? {};
    const score = num(r.score);
    return {
      entity: e.name,
      subtitle: e.subtitle,
      type: e.type,
      id: e.id,
      score,
      band: scoreBand(score),
      platform: str(r.platform),
      address: str(r.address),
    };
  });
}

async function getXerberusSection() {
  try {
    const ratings = parseXerberus(await xerberusRegistryScores());
    return {
      provider: "Xerberus",
      providerUrl: "https://xerberus.io",
      ratings,
      note: "Composite on-chain risk scores (0–100; higher is safer). Covers the Frankencoin protocol, DAO, and Ethereum savings vault.",
    };
  } catch (e) {
    if (e instanceof MissingSecretError) {
      return { note: "Xerberus API key not configured — composite risk scores unavailable.", ratings: null };
    }
    throw e;
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function getRisk({ source = "all" } = {}) {
  const wantPharos = source === "all" || source === "pharos";
  const wantXerberus = source === "all" || source === "xerberus";

  const [pharos, xerberus] = await Promise.all([
    wantPharos ? getPharosSection() : Promise.resolve(undefined),
    wantXerberus ? getXerberusSection() : Promise.resolve(undefined),
  ]);

  const result = {
    disclaimer:
      "Independent third-party risk ratings for Frankencoin (ZCHF). Produced by external protocols (Pharos, Xerberus), NOT the Frankencoin DAO. Informational only — not financial advice.",
  };
  if (wantPharos) result.pharos = pharos;
  if (wantXerberus) result.xerberus = xerberus;
  return result;
}
