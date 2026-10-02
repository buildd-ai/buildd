/**
 * Artificial Analysis as a quality prior for tier pools
 * (knowledge-base: buildd/design/model-quality-signals.md, unit Q1).
 *
 * Pure: parsing, scoring, the prior, trust and the price-fallback rule are all
 * functions of their arguments. Fetching AA, mapping its ids to the catalog and
 * wiring the result into the daily explore step are later units (Q2-Q10); this
 * file only supplies the math they will call.
 *
 * AA measures whether a model is good at the work a pool serves — a different
 * thing from OpenRouter's rankings, which measure adoption
 * (`./openrouter-rankings.ts`). The two priors are sized differently and never
 * substitute for each other (design §5a).
 */
import type { PoolSurface } from './tier-pool';
import type { TokenPrice } from './model-catalog';

export const QUALITY_POLICY = {
  version: 1,
  /** Index points at which a gap saturates the prior (§5a). */
  span: 10,
  /** Pseudo-units at full trust, MIN_GRADED_UNITS / 5 per surface (§5a). */
  aaUnits: { agent: 6, chat: 10 } satisfies Record<PoolSurface, number>,
  /** A successor scoring this much worse blocks the auto-challenger add (§5d). */
  vetoMargin: 3,
  /** A cheaper-but-worse challenger needs at least this gap to preset `low` (§6). */
  lowerMargin: 5,
  /** Trust before 8 observations exist (§7b). */
  trustStart: 0.5,
  trustMinObservations: 8,
  /** Chat latency log-scale anchors, seconds (§4b). */
  latencyAnchors: { fast: 0.3, slow: 10 },
  /** Chat throughput log-scale anchors, tokens/second (§4b). */
  speedAnchors: { slow: 20, fast: 300 },
} as const;

export type AaTier = 'free' | 'pro' | 'commercial';

export type LadderEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type AaEffort = LadderEffort | 'reasoning' | 'non_reasoning' | 'adaptive' | 'none' | 'conflict';

const TB_FIELDS = ['terminalbench_v4_0', 'terminalbench_v2_1', 'terminalbench_hard'] as const;
export type TerminalBenchField = typeof TB_FIELDS[number];

export interface AaModelRow {
  aaId: string;
  slug: string;
  name: string;
  creatorName: string | null;
  releaseDate: string | null;
  /** Pro only. */
  reasoningModel: boolean | null;
  /** Pro only. */
  openRouterApiId: string | null;
  intelligence: number | null;
  coding: number | null;
  agentic: number | null;
  /** Pro only. */
  ifbench: number | null;
  tau2Telecom: number | null;
  tauBanking: number | null;
  terminalBench: Record<TerminalBenchField, number | null>;
  priceInput: number | null;
  priceOutput: number | null;
  priceCacheHit: number | null;
  priceCacheWrite: number | null;
  medianOutputTokensPerSecond: number | null;
  medianTimeToFirstTokenSeconds: number | null;
  medianTimeToFirstAnswerTokenSeconds: number | null;
  /**
   * Pro exposes q75 latency percentiles, but the OpenAPI document's §1b
   * bucket ("p05, q25, q75 and p95 ... of TTFT") does not give this design a
   * confirmed field name. Stays null until Q4's live fetch confirms one;
   * `chatScore` falls back to the median either way (§4b).
   */
  ttftP75Seconds: number | null;
}

export interface AaPage {
  tier: AaTier;
  indexVersion: number | null;
  pagination: { page: number; pageSize: number; totalPages: number; hasMore: boolean } | null;
  rows: AaModelRow[];
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Parse one page of `/free` or `/language/models`, or null when the shape is not the documented one (§1a, §1b). */
export function normalizeAaResponse(raw: unknown): AaPage | null {
  const body = raw as Record<string, unknown> | null;
  if (!body || !Array.isArray(body.data)) return null;
  const tier = body.tier === 'free' || body.tier === 'pro' || body.tier === 'commercial' ? body.tier : null;
  if (!tier) return null;
  const indexVersion = num(body.intelligence_index_version);
  const pag = body.pagination as Record<string, unknown> | undefined;
  const pagination = pag && typeof pag.page === 'number'
    ? { page: pag.page, pageSize: Number(pag.page_size) || 0, totalPages: Number(pag.total_pages) || 0, hasMore: !!pag.has_more }
    : null;

  const rows: AaModelRow[] = [];
  for (const r of body.data as Array<Record<string, unknown>>) {
    const aaId = typeof r.id === 'string' ? r.id : null;
    if (!aaId) continue;
    const creator = r.model_creator as Record<string, unknown> | undefined;
    rows.push({
      aaId,
      slug: typeof r.slug === 'string' ? r.slug : '',
      name: typeof r.name === 'string' ? r.name : '',
      creatorName: typeof creator?.name === 'string' ? creator.name : null,
      releaseDate: typeof r.release_date === 'string' ? r.release_date : null,
      reasoningModel: typeof r.reasoning_model === 'boolean' ? r.reasoning_model : null,
      openRouterApiId: typeof r.openrouter_api_id === 'string' ? r.openrouter_api_id : null,
      intelligence: num(r.artificial_analysis_intelligence_index),
      coding: num(r.artificial_analysis_coding_index),
      agentic: num(r.artificial_analysis_agentic_index),
      ifbench: num(r.ifbench),
      tau2Telecom: num(r.tau2_telecom),
      tauBanking: num(r.tau_banking),
      terminalBench: {
        terminalbench_v4_0: num(r.terminalbench_v4_0),
        terminalbench_v2_1: num(r.terminalbench_v2_1),
        terminalbench_hard: num(r.terminalbench_hard),
      },
      priceInput: num(r.price_1m_input_tokens),
      priceOutput: num(r.price_1m_output_tokens),
      priceCacheHit: num(r.price_1m_cache_hit_tokens),
      priceCacheWrite: num(r.price_1m_cache_write_tokens),
      medianOutputTokensPerSecond: num(r.median_output_tokens_per_second),
      medianTimeToFirstTokenSeconds: num(r.median_time_to_first_token_seconds),
      medianTimeToFirstAnswerTokenSeconds: num(r.median_time_to_first_answer_token_seconds),
      ttftP75Seconds: null,
    });
  }
  return { tier, indexVersion, pagination, rows };
}

// ── Effort parsing (§2b) ─────────────────────────────────────────────────────

const LADDER: readonly LadderEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

const MARKER_TOKENS: Record<string, AaEffort> = {
  minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max',
  thinking: 'reasoning', reasoning: 'reasoning', 'non-reasoning': 'non_reasoning', adaptive: 'adaptive',
};
// Longest token first, so `non-reasoning` matches before `reasoning`.
const MARKER_KEYS = Object.keys(MARKER_TOKENS).sort((a, b) => b.length - a.length);

function slugMarker(slug: string): AaEffort | null {
  const s = slug.toLowerCase();
  for (const token of MARKER_KEYS) if (s === token || s.endsWith(`-${token}`)) return MARKER_TOKENS[token];
  return null;
}

function nameMarker(name: string): AaEffort | null {
  const m = /\(([^)]+)\)\s*$/.exec(name.trim());
  if (!m) return null;
  const inner = m[1].toLowerCase().trim().replace(/\s+/g, '-');
  return MARKER_TOKENS[inner] ?? null;
}

/**
 * One AA row's effort, from its slug and name (§2b). `conflict` when the two
 * disagree, or when `reasoning_model === false` (Pro only) contradicts a
 * ladder marker.
 */
export function parseAaEffort(slug: string, name: string, reasoningModel?: boolean | null): AaEffort {
  const bySlug = slugMarker(slug);
  const byName = nameMarker(name);
  if (bySlug && byName && bySlug !== byName) return 'conflict';
  const marker = bySlug ?? byName;
  if (reasoningModel === false) {
    if (marker && (LADDER as readonly string[]).includes(marker)) return 'conflict';
    return marker ?? 'non_reasoning';
  }
  return marker ?? 'none';
}

// ── Scoring (§4) ─────────────────────────────────────────────────────────────

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function meanNonNull(values: readonly (number | null)[]): number | null {
  const present = values.filter((v): v is number => v != null);
  return present.length ? present.reduce((s, v) => s + v, 0) / present.length : null;
}

/** Weighted mean over the present terms, their weights rescaled to sum to 1. Null with nothing present. */
function weightedScore(terms: ReadonlyArray<{ weight: number; value: number | null }>): number | null {
  const present = terms.filter(t => t.value != null && t.weight > 0);
  const total = present.reduce((s, t) => s + t.weight, 0);
  if (total <= 0) return null;
  return present.reduce((s, t) => s + (t.weight / total) * (t.value as number), 0);
}

/**
 * The Terminal-Bench field usable across a comparison set: the first (newest)
 * of `terminalbench_v4_0`, `terminalbench_v2_1`, `terminalbench_hard` that is
 * non-null for **every** row. Null (dropped) when none qualifies (§4a).
 */
export function selectTerminalBenchField(rows: readonly AaModelRow[]): TerminalBenchField | null {
  if (rows.length === 0) return null;
  for (const f of TB_FIELDS) if (rows.every(r => r.terminalBench[f] != null)) return f;
  return null;
}

function tauValue(row: Pick<AaModelRow, 'tau2Telecom' | 'tauBanking'>): number | null {
  return meanNonNull([row.tau2Telecom, row.tauBanking]);
}

/** Is a TAU value computable for every row in the set (§4a, "the same rule applies to TAU")? */
export function tauAvailableForAll(rows: readonly AaModelRow[]): boolean {
  return rows.length > 0 && rows.every(r => tauValue(r) != null);
}

function agentRowScore(row: AaModelRow, tier: AaTier, tbField: TerminalBenchField | null, tauOk: boolean): number | null {
  if (tier === 'free') return weightedScore([{ weight: 0.5, value: row.coding }, { weight: 0.5, value: row.agentic }]);
  return weightedScore([
    { weight: 0.35, value: row.coding },
    { weight: 0.35, value: row.agentic },
    { weight: 0.15, value: tbField ? row.terminalBench[tbField] : null },
    { weight: 0.15, value: tauOk ? tauValue(row) : null },
  ]);
}

function chatRowScore(row: AaModelRow, tier: AaTier): number | null {
  if (row.intelligence == null) return null;
  const t = row.medianTimeToFirstAnswerTokenSeconds ?? (tier === 'pro' ? row.ttftP75Seconds : null) ?? row.medianTimeToFirstTokenSeconds;
  const r = row.medianOutputTokensPerSecond;
  const lat = t != null && t > 0
    ? 100 * clamp(Math.log(QUALITY_POLICY.latencyAnchors.slow / t) / Math.log(QUALITY_POLICY.latencyAnchors.slow / QUALITY_POLICY.latencyAnchors.fast), 0, 1)
    : null;
  const speed = r != null && r > 0
    ? 100 * clamp(Math.log(r / QUALITY_POLICY.speedAnchors.slow) / Math.log(QUALITY_POLICY.speedAnchors.fast / QUALITY_POLICY.speedAnchors.slow), 0, 1)
    : null;
  if (tier === 'free') {
    return weightedScore([{ weight: 0.60, value: row.intelligence }, { weight: 0.25, value: lat }, { weight: 0.15, value: speed }]);
  }
  return weightedScore([
    { weight: 0.45, value: row.intelligence },
    { weight: 0.15, value: row.ifbench != null ? 100 * row.ifbench : null },
    { weight: 0.25, value: lat },
    { weight: 0.15, value: speed },
  ]);
}

export interface SurfaceScoreResult {
  /** aaId → score, or null when the row lacks what its surface needs. */
  scores: Map<string, number | null>;
  /** Which optional fields the comparison set could use, for evidence. */
  fields: { terminalBench: TerminalBenchField | null; tau: boolean };
}

/**
 * Per-row scores for one comparison set on one surface (§4a, §4b). The
 * Terminal-Bench field and TAU's availability are chosen once, across every
 * row passed in — comparing rows that used different fields would not be
 * comparable (§4c).
 */
export function surfaceScore(rows: readonly AaModelRow[], surface: PoolSurface, tier: AaTier): SurfaceScoreResult {
  if (surface === 'chat') {
    return { scores: new Map(rows.map(r => [r.aaId, chatRowScore(r, tier)])), fields: { terminalBench: null, tau: false } };
  }
  const tbField = tier === 'free' ? null : selectTerminalBenchField(rows);
  const tauOk = tier !== 'free' && tauAvailableForAll(rows);
  return {
    scores: new Map(rows.map(r => [r.aaId, agentRowScore(r, tier, tbField, tauOk)])),
    fields: { terminalBench: tbField, tau: tauOk },
  };
}

// ── Prior (§5a) ──────────────────────────────────────────────────────────────

export interface QualityPrior {
  alpha0: number;
  beta0: number;
  /** ∈ [0.35, 0.65]. */
  m: number;
  /** Pseudo-units actually applied, ≤ `AA_UNITS[surface]`. */
  n: number;
}

/**
 * Beta pseudo-counts for a challenger from its AA gap against the incumbent,
 * scaled by trust. Null (neutral prior) when either score is missing or trust
 * is zero (§5a) — the caller is responsible for staleness and mapping gates
 * (Q3, Q4), which are not this module's job.
 */
export function qualityPrior(args: {
  challengerScore: number | null;
  incumbentScore: number | null;
  trust: number;
  surface: PoolSurface;
}): QualityPrior | null {
  if (args.challengerScore == null || args.incumbentScore == null || !(args.trust > 0)) return null;
  const gap = args.challengerScore - args.incumbentScore;
  const s = clamp(0.5 + gap / (2 * QUALITY_POLICY.span), 0, 1);
  const m = 0.5 + 0.3 * (s - 0.5);
  const n = args.trust * QUALITY_POLICY.aaUnits[args.surface];
  return { alpha0: n * m, beta0: n * (1 - m), m, n };
}

// ── Trust (§7b) ──────────────────────────────────────────────────────────────

/**
 * τ from the latest concordance observations (1 agree, 0.5 near-tie, 0
 * disagree). Below 8 observations, trust is unproven and reads as the start
 * value; §7b's clamp is what drives it to 0 once AA stops predicting outcomes.
 */
export function trustFromObservations(concordances: readonly number[]): number {
  if (concordances.length < QUALITY_POLICY.trustMinObservations) return QUALITY_POLICY.trustStart;
  const c = concordances.reduce((s, v) => s + v, 0) / concordances.length;
  return clamp((c - 0.5) / 0.25, 0, 1);
}

// ── Price fallback (§6) ──────────────────────────────────────────────────────

export type PriceSource = 'openrouter-catalog' | 'artificial-analysis' | 'unknown';

export interface SuggestionPrice {
  source: PriceSource;
  challenger: TokenPrice | null;
  incumbent: TokenPrice | null;
}

/**
 * Which price pair `suggestWeight` (`./tier-weights.ts`) should compare: the
 * catalog when both arms have a catalog price, else AA when both have a
 * mapped price in one fresh snapshot, else unknown. The two sources are never
 * mixed inside one ratio (§6).
 */
export function suggestionPrice(args: {
  challengerCatalog: TokenPrice | null;
  incumbentCatalog: TokenPrice | null;
  challengerAa: TokenPrice | null;
  incumbentAa: TokenPrice | null;
  /** AA snapshot within the §3c staleness window. */
  aaFresh: boolean;
}): SuggestionPrice {
  if (args.challengerCatalog && args.incumbentCatalog) {
    return { source: 'openrouter-catalog', challenger: args.challengerCatalog, incumbent: args.incumbentCatalog };
  }
  if (args.aaFresh && args.challengerAa && args.incumbentAa) {
    return { source: 'artificial-analysis', challenger: args.challengerAa, incumbent: args.incumbentAa };
  }
  return { source: 'unknown', challenger: null, incumbent: null };
}
