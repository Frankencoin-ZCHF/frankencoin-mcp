import { pharosReportCards } from "../upstream/pharos.js";
import { xerberusRegistryScores } from "../upstream/xerberus.js";
import { freshness, sourceTime } from "../lib/freshness.js";
import { PHAROS_STABLECOIN_ID, PHAROS_PILLARS, XERBERUS_FC_ENTITIES } from "../lib/constants.js";
import { providerFailure, availability } from "../lib/provider.js";
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

function parsePharos(observation, publicOnly) {
  const body = observation.data;
  if (body?.model !== "v9" || body.schemaVersion !== (publicOnly ? 1 : 9)) return null;
  const cards = publicOnly ? body.grades : body.cards;
  const card = Array.isArray(cards) && cards.find((c) => c?.id === PHAROS_STABLECOIN_ID);
  if (!card || !["rated", "not-rated", "pipeline-gap"].includes(card.ratingStatus)) return null;
  const score = num(card.score);
  if (card.ratingStatus === "rated" && (score === null || score < 0 || score > 100 || !str(card.grade))) return null;
  const pillars = publicOnly ? null : PHAROS_PILLARS.map(({ key, label }) => {
    const p = card.pillars?.[key];
    const n = num(p?.score);
    return { key, label, score: n !== null && n >= 0 && n <= 100 ? n : null,
      evidenceLevel: p?.evidenceLevel ?? null, freshness: p?.freshness ?? null,
      aggregationDisposition: p?.aggregationDisposition ?? null, reasons: p?.reasons ?? [] };
  });
  const publicationStatus = publicOnly ? body.publicationStatus : body.publicationHealth?.status;
  const quality = freshness(body.asOfSec, 7200);
  if (publicationStatus === "held") quality.status = "held";
  const complete = !publicOnly && pillars.every((p) => p.score !== null) && !card.partialEvidence && publicationStatus === "current" && quality.status === "fresh";
  return {
    provider: "Pharos", providerUrl: "https://pharos.watch", name: "Frankencoin", symbol: "ZCHF",
    status: card.ratingStatus === "pipeline-gap" ? "unavailable" : complete ? "available" : "partial",
    overallGrade: str(card.grade), overallScore: card.ratingStatus === "rated" ? score : null,
    overallBand: scoreBand(card.ratingStatus === "rated" ? score : null),
    ratingStatus: card.ratingStatus, partialEvidence: card.partialEvidence ?? null,
    nrReasons: card.nrReasons ?? [], reasonCodes: card.reasonCodes ?? [], gradeHold: card.gradeHold ?? null,
    methodologyVersion: publicOnly ? str(body.methodologyVersion) : str(body.methodology?.version),
    model: body.model, pillars, publicationStatus: publicationStatus ?? null,
    asOf: quality.asOf, updatedAt: sourceTime(body.updatedAt), retrievedAt: observation.retrievedAt,
    freshness: quality, source: { url: observation.url, kind: publicOnly ? "public_overall_grade" : "report_card_v9" },
    note: publicOnly ? "Public overall safety grade; detailed pillar evidence unavailable from this feed."
      : "Pharos v9 backing, exit and control pillars. Scores are 0–100; higher is safer. Provider not-rated and pipeline-gap are distinct from a zero score.",
  };
}

async function getPharosSection() {
  let primary;
  try {
    const parsed = parsePharos(await pharosReportCards(), false);
    if (parsed && parsed.ratingStatus !== "pipeline-gap") return parsed;
    primary = { status: "unavailable", code: parsed ? "pipeline_gap" : "invalid_report_card" };
  } catch (e) { primary = providerFailure(e); }
  try {
    const parsed = parsePharos(await pharosReportCards({ publicOnly: true }), true);
    if (parsed) return { ...parsed, primarySource: primary };
    return { ...primary, rating: null, fallback: { status: "unavailable", code: "invalid_grade_feed" }, note: "Pharos returned no valid current-model ZCHF rating." };
  } catch (e) {
    return { ...primary, fallback: providerFailure(e), rating: null, note: "Pharos report card and public grade feed unavailable." };
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
      status: ratings.every((r) => r.score !== null) ? "available" : ratings.some((r) => r.score !== null) ? "partial" : "unavailable",
      asOf: null,
      checkedAt: new Date().toISOString(),
      freshnessNote: "Provider as-of timestamp not supplied by the registry response contract; checkedAt is an assessment time, not rating freshness.",
      provider: "Xerberus",
      providerUrl: "https://xerberus.io",
      ratings,
      note: "Composite on-chain risk scores (0–100; higher is safer). Covers the Frankencoin protocol, DAO, and Ethereum savings vault.",
    };
  } catch (e) {
    if (e instanceof MissingSecretError) {
      return { ...providerFailure(e), note: "Xerberus API key not configured — composite risk scores unavailable.", ratings: null };
    }
    return { ...providerFailure(e), ratings: null, note: "Xerberus data unavailable; upstream request failed." };
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
  result.status = availability(Object.fromEntries(Object.entries({ pharos, xerberus }).filter(([, v]) => v !== undefined)));
  return result;
}
