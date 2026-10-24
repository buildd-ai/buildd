/**
 * The `buildd.ui_copy` detector benchmark: corpus, captures, corrections, cache identity and scoring.
 * Pure: no DB, no network. `scripts/ui-copy-benchmark.ts` runs the cases through the production entry point.
 *
 * What this measures and what it does not:
 * - The corpus is composed cards with labels the corpus author wrote (`synthetic_development`). They are
 *   development labels. Only a person-confirmed correction is ever scored as confirmed, and separately.
 * - It reports; it never picks a threshold, writes a policy or promotes anything.
 * - It is not app coverage: a fixed corpus says nothing about cards it does not contain.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { summarizeDecisionEval, type EvalPrediction, type EvalSummary } from '@buildd/ai-kit/decide';
import type { MeasurementReason, StoredMeasurement } from '../decision-model-measurements';
import {
  UI_MATERIAL_ROLES, UI_SURFACE_BLOCK_ROLES, UI_SURFACE_OPERATIONS, parseSurfaceEvidence, uiCopyFeaturesFromSurface,
  type SurfaceEvidence, type UiCopyDecision, type UiCopyFeatures,
} from '../ui-verification';

export const UI_COPY_CORPUS_LABEL_SOURCE = 'synthetic_development' as const;
export const UI_COPY_SPLITS = ['development', 'untouched'] as const;
export type UiCopySplit = (typeof UI_COPY_SPLITS)[number];
type Verdict = 'pass' | 'fail' | 'inconclusive';

/** Fictional capture identity shared by every fixture: no real commit, route or tenant. */
const FIXTURE_SHA = 'e'.repeat(40);
const FIXTURE_TIME = '2026-01-01T00:00:00.000Z';

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
const coverage = z.enum(['complete', 'partial', 'absent']);
const caseSchema = z.object({
  id,
  split: z.enum(UI_COPY_SPLITS),
  category: z.string().min(1).max(60),
  /** `source_string`: text from this repo's own UI source. Its label is still the corpus author's. */
  origin: z.enum(['synthetic', 'source_string']),
  pair: id.optional(),
  collector: z.enum(['runner', 'agent']).optional(),
  blocks: z.array(z.object({ id: z.string().min(1).max(80), role: z.enum(UI_SURFACE_BLOCK_ROLES), text: z.string().min(1).max(1000) }).strict()).max(32),
  actions: z.array(z.object({
    id: z.string().min(1).max(80), label: z.string().min(1).max(120), operation: z.enum(UI_SURFACE_OPERATIONS),
    enabled: z.boolean().optional(), prominence: z.enum(['primary', 'secondary', 'menu']).optional(),
  }).strict()).max(16),
  facts: z.record(z.string(), z.string()),
  coverage: z.object({ renderedText: coverage, actions: coverage, runtimeState: coverage }).partial().strict().optional(),
  criterion: z.object({ id: z.string().regex(/^(R|AC)-\d{1,4}$/), text: z.string().min(1).max(2000) }).strict().optional(),
  expected: z.object({ copy: z.enum(['pass', 'fail', 'inconclusive']), actionState: z.enum(['pass', 'fail', 'inconclusive', 'unsupported']).optional() }).strict(),
  why: z.string().min(1).max(400),
}).strict();
const corpusSchema = z.object({
  corpusVersion: z.string().regex(/^ui-copy-corpus-v\d+$/),
  labelSource: z.literal(UI_COPY_CORPUS_LABEL_SOURCE),
  labelNote: z.string().min(1),
  cases: z.array(caseSchema),
}).strict();

export type UiCopyCase = z.infer<typeof caseSchema>;
export type UiCopyCorpus = z.infer<typeof corpusSchema>;

/** A case as the stored capture production would hold. Fixture identity only; the visible card is the case's. */
export function surfaceOf(c: UiCopyCase): SurfaceEvidence {
  return {
    schemaVersion: 1,
    subject: { commitSha: FIXTURE_SHA, route: '/benchmark/card', scenarioId: c.id, viewport: 'desktop' },
    capture: { captureId: `benchmark-${c.id}`, capturedAt: FIXTURE_TIME, snapshotRef: `benchmark/${c.id}` },
    visible: {
      blocks: c.blocks.map((b, order) => ({ ...b, order, disclosure: 'visible' as const })),
      actions: c.actions.map(a => ({ ...a, enabled: a.enabled ?? true, prominence: a.prominence ?? 'primary', disclosure: 'visible' as const })),
    },
    facts: c.facts as SurfaceEvidence['facts'],
    provenance: {
      collector: c.collector ?? 'runner', collectorVersion: 'ui-copy-benchmark-fixture@1', reportedVia: 'runner',
      factVersion: Object.keys(c.facts).length ? 'ui-copy-benchmark-fixture@1' : 'none',
    },
    coverage: { renderedText: 'complete', actions: 'complete', runtimeState: 'complete', screenshot: 'absent', ...c.coverage },
  };
}

/** Parse and check a corpus. Every case must build a capture production accepts, and a pair must share its words. */
export function parseUiCopyCorpus(input: unknown): { ok: true; corpus: UiCopyCorpus } | { ok: false; problems: string[] } {
  const parsed = corpusSchema.safeParse(input);
  if (!parsed.success) return { ok: false, problems: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) };
  const corpus = parsed.data;
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const c of corpus.cases) {
    if (seen.has(c.id)) problems.push(`${c.id}: duplicate id`);
    seen.add(c.id);
    const surface = parseSurfaceEvidence(surfaceOf(c));
    if (!surface.ok) problems.push(`${c.id}: not a valid capture (${surface.message})`);
  }
  const pairs = new Map<string, UiCopyCase[]>();
  for (const c of corpus.cases) if (c.pair) pairs.set(c.pair, [...(pairs.get(c.pair) ?? []), c]);
  for (const [pair, members] of pairs) {
    if (members.length !== 2) { problems.push(`pair ${pair}: needs exactly 2 cases, has ${members.length}`); continue; }
    const [a, b] = members as [UiCopyCase, UiCopyCase];
    const words = (c: UiCopyCase) => JSON.stringify([c.blocks.map(x => x.text), c.actions.map(x => x.label)]);
    if (words(a) !== words(b)) problems.push(`pair ${pair}: the two cases must show identical words`);
    if (a.split !== b.split) problems.push(`pair ${pair}: both cases must be in one split`);
    const behaviour = (c: UiCopyCase) => JSON.stringify([c.actions.map(x => x.operation), c.facts]);
    if (behaviour(a) === behaviour(b)) problems.push(`pair ${pair}: the two cases must differ in actions or state`);
  }
  return problems.length ? { ok: false, problems } : { ok: true, corpus };
}

/**
 * Which cases a run scores. The untouched split is reserved: it runs only when the caller says it is
 * opening it, so a reader can tell a held-out number from one measured on cases that were looked at.
 */
export function selectCases(
  corpus: UiCopyCorpus, split: UiCopySplit | 'all', opts: { openUntouched?: boolean; ids?: readonly string[]; limit?: number } = {},
): { ok: true; cases: UiCopyCase[] } | { ok: false; reason: string } {
  if (split !== 'development' && !opts.openUntouched) return { ok: false, reason: 'untouched_split_reserved' };
  let cases = corpus.cases.filter(c => split === 'all' || c.split === split);
  if (opts.ids?.length) cases = cases.filter(c => opts.ids!.includes(c.id));
  if (opts.limit !== undefined) cases = cases.slice(0, opts.limit);
  return { ok: true, cases };
}

// ── Person-confirmed corrections ─────────────────────────────────────────────

export interface UiCopyCorrection { caseId: string; expected: Verdict; confirmedBy: { kind: 'person'; id: string } }

/**
 * Corrections as JSONL: `{"caseId","expected","confirmedBy":{"kind":"person","id"}}`. Only a person's
 * confirmation counts, as `evaluationCaseFromCorrection` rules for verifier promotion: an agent's or a model's
 * label is refused, never quietly accepted as truth. A correction for a case the corpus does not hold is refused.
 */
export function parseUiCopyCorrections(text: string, knownIds: ReadonlySet<string>): { accepted: UiCopyCorrection[]; refused: { line: number; reason: string }[] } {
  const accepted = new Map<string, UiCopyCorrection>();
  const refused: { line: number; reason: string }[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('//')) return;
    let row: { caseId?: unknown; expected?: unknown; confirmedBy?: { kind?: unknown; id?: unknown } | null };
    try { row = JSON.parse(line); } catch { refused.push({ line: i + 1, reason: 'invalid_json' }); return; }
    if (typeof row.caseId !== 'string' || !knownIds.has(row.caseId)) { refused.push({ line: i + 1, reason: 'unknown_case' }); return; }
    if (row.expected !== 'pass' && row.expected !== 'fail' && row.expected !== 'inconclusive') { refused.push({ line: i + 1, reason: 'invalid_expected' }); return; }
    if (row.confirmedBy?.kind !== 'person' || typeof row.confirmedBy.id !== 'string' || !row.confirmedBy.id) {
      refused.push({ line: i + 1, reason: 'not_person_confirmed' });
      return;
    }
    accepted.set(row.caseId, { caseId: row.caseId, expected: row.expected, confirmedBy: { kind: 'person', id: row.confirmedBy.id } });
  });
  return { accepted: [...accepted.values()], refused };
}

// ── Cache identity ───────────────────────────────────────────────────────────

function canonical(input: unknown): string {
  if (Array.isArray(input)) return `[${input.map(canonical).join(',')}]`;
  if (input && typeof input === 'object') {
    return `{${Object.entries(input).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(input);
}

/** Everything that decides what the model is asked and how its answer is read. A change in any of it is a different measurement. */
export interface UiCopyPolicyIdentity {
  kind: string;
  policyVersion: string;
  featureSchemaVersion: string;
  promptFingerprint: string;
  configFingerprint: string;
  engine: number;
}

/**
 * One cached answer per identical (state sent, policy identity, requested model, measurement policy). Nothing
 * looser is reused: the stored measurements decide whether an answer is applied and at what confidence, so an
 * answer recorded under one measurement policy is not replayed under another.
 */
export function uiCopyCacheKey(state: unknown, policy: UiCopyPolicyIdentity, model: string, measurementFingerprint: string): string {
  return createHash('sha256').update(canonical({ state, policy, model, measurementFingerprint })).digest('hex');
}

// ── Measurement policy ───────────────────────────────────────────────────────

/** The fields of a stored (kind, model) measurement that `measurementFor` reads: eligibility and threshold. */
export interface UiCopyMeasurementRow {
  kind: string;
  model: string;
  threshold: number;
  measuredFingerprint: string;
  status: StoredMeasurement['status'];
  confidenceSource: NonNullable<StoredMeasurement['confidenceSource']>;
  calibration: StoredMeasurement['calibration'] | null;
  labelThresholds: StoredMeasurement['labelThresholds'] | null;
}
/** The stored measurements a run applied, frozen, with a fingerprint that goes into every cache key. */
export interface UiCopyMeasurementPolicy { fingerprint: string; rows: UiCopyMeasurementRow[] }

/** Freeze the rows production would read for this kind. The empty set is a policy too (Jev at the kind's threshold). */
export function uiCopyMeasurementPolicy(stored: readonly (StoredMeasurement | UiCopyMeasurementRow)[], kind: string): UiCopyMeasurementPolicy {
  const rows = stored.filter(r => r.kind === kind).map((r): UiCopyMeasurementRow => ({
    kind: r.kind, model: r.model, threshold: r.threshold, measuredFingerprint: r.measuredFingerprint, status: r.status,
    confidenceSource: r.confidenceSource ?? 'confidence', calibration: r.calibration ?? null, labelThresholds: r.labelThresholds ?? null,
  })).sort((a, b) => canonical(a).localeCompare(canonical(b)));
  return { fingerprint: createHash('sha256').update(canonical(rows)).digest('hex'), rows };
}

/** The frozen rows as the broker reads them. Fields `measurementFor` ignores are filled, never invented as evidence. */
export const storedFromPolicy = (policy: UiCopyMeasurementPolicy): StoredMeasurement[] => policy.rows.map(r => ({
  ...r, precisionLower: null, coverage: null, n: 0, evalRunId: null, setByAccountId: null, setAt: new Date(0), reason: null,
}));

/** How the applied measurement policy treated one model: may its answer act, and at what confidence. */
export interface UiCopyModelPolicy { model: string; eligible: boolean; threshold: number; reason: MeasurementReason | 'code_listed' }

export interface UiCopyCacheEntry {
  /** The versioned model that answered. */
  modelVersion: string;
  answers: Record<string, { type: 'choice'; choice: string; confidence: number; probabilities?: Record<string, number> }>;
  costUsd: number | null;
  latencyMs: number;
  answeredAt: string;
}
/** Answers, and every measurement policy a network run applied (by fingerprint), so offline replay reapplies it. */
export interface UiCopyCacheFile { version: 1; entries: Record<string, UiCopyCacheEntry>; measurementPolicies: Record<string, UiCopyMeasurementRow[]> }
export const emptyUiCopyCache = (): UiCopyCacheFile => ({ version: 1, entries: {}, measurementPolicies: {} });
export function parseUiCopyCache(input: unknown): UiCopyCacheFile {
  const v = input as Partial<UiCopyCacheFile> | null;
  if (!(v && v.version === 1 && v.entries && typeof v.entries === 'object')) return emptyUiCopyCache();
  return { version: 1, entries: { ...v.entries }, measurementPolicies: { ...(v.measurementPolicies && typeof v.measurementPolicies === 'object' ? v.measurementPolicies : {}) } };
}

/**
 * Which recorded measurement policy an offline replay applies. Named (a fingerprint or its prefix) when the
 * cache holds several; the only one when it holds one; the empty policy when it holds none. Never a guess.
 */
export function selectMeasurementPolicy(cache: UiCopyCacheFile, kind: string, wanted?: string | null): { ok: true; policy: UiCopyMeasurementPolicy } | { ok: false; reason: string } {
  const recorded = Object.entries(cache.measurementPolicies);
  if (wanted) {
    const match = recorded.filter(([fp]) => fp.startsWith(wanted));
    if (match.length !== 1) return { ok: false, reason: `measurement policy ${wanted} ${match.length ? 'is ambiguous' : 'is not recorded in the cache'} (recorded: ${recorded.map(([fp]) => fp.slice(0, 12)).join(', ') || 'none'})` };
    return { ok: true, policy: uiCopyMeasurementPolicy(match[0]![1], kind) };
  }
  if (recorded.length > 1) return { ok: false, reason: `the cache holds ${recorded.length} measurement policies (${recorded.map(([fp]) => fp.slice(0, 12)).join(', ')}): name one with --measurement-policy` };
  return { ok: true, policy: uiCopyMeasurementPolicy(recorded[0]?.[1] ?? [], kind) };
}

// ── Material facts ───────────────────────────────────────────────────────────

export interface MaterialRetention {
  /** Material blocks (consequence, permission, prerequisite, recovery) in the capture. */
  material: number;
  /** Of those, how many reached the model's state with the same text and role. */
  retained: number;
  /** Runtime facts in the capture, and whether all of them reached the state. */
  facts: number;
  factsRetained: boolean;
  /** Material block ids a finding called dispensable: must always be empty. */
  flaggedMaterial: string[];
  ok: boolean;
}

/**
 * Did the card's necessary facts survive into what the model saw? `state` is the kind's model state for
 * these features (`UI_COPY_CONFIG.state`): the exact object production sends.
 */
export function materialRetention(surface: SurfaceEvidence, state: unknown, findings: ReadonlyArray<Record<string, unknown>> = []): MaterialRetention {
  const roles = UI_MATERIAL_ROLES as readonly string[];
  const material = surface.visible.blocks.filter(b => roles.includes(b.role));
  const s = (state ?? {}) as { segments?: Array<{ id: string; text: string; role: string }>; state?: { facts?: Record<string, unknown> } };
  const sent = new Map((s.segments ?? []).map(x => [x.id, x]));
  const retained = material.filter(b => sent.get(b.id)?.text === b.text && sent.get(b.id)?.role === b.role).length;
  const facts = Object.entries(surface.facts);
  const factsRetained = facts.every(([k, v]) => s.state?.facts?.[k] === v);
  const materialIds = new Set(material.map(b => b.id));
  const flaggedMaterial = [...new Set(findings.flatMap(f => (Array.isArray(f.segmentIds) ? f.segmentIds as string[] : []).filter(x => materialIds.has(x))))];
  return { material: material.length, retained, facts: facts.length, factsRetained, flaggedMaterial, ok: retained === material.length && factsRetained && !flaggedMaterial.length };
}

/** The production feature mapping, so retention is read off what production would build. */
export const benchmarkFeatures = (c: UiCopyCase): UiCopyFeatures => uiCopyFeaturesFromSurface(surfaceOf(c), undefined, c.criterion);

// ── Scoring ──────────────────────────────────────────────────────────────────

export const DECISION_VERDICT: Record<UiCopyDecision, Verdict> = { concise: 'pass', needs_edit: 'fail', insufficient_evidence: 'inconclusive' };

/** Why a case that needed a model answer has none. Any of these leaves the run incomplete. */
export type UiCopyNoAnswer = 'no_provider' | 'cache_miss' | 'budget_deferred' | 'provider_failure';

export interface UiCopyCaseResult {
  id: string;
  split: UiCopySplit;
  category: string;
  origin: UiCopyCase['origin'];
  pair: string | null;
  expected: { copy: Verdict; actionState: string | null; source: typeof UI_COPY_CORPUS_LABEL_SOURCE };
  confirmed: UiCopyCorrection | null;
  /** The model's reading through the kind's own interpretation, before the threshold. Null without an answer. */
  raw: { decision: UiCopyDecision; confidence: number; reasonCode: string; axes: Record<string, { choice: string; confidence: number }> } | null;
  /** What production accepted: the evaluator's verdict, method and observation. */
  accepted: { verdict: string; method: string; observed: string | null; confidence: number | null };
  /** The threshold the measurement policy applied to the answering model. Null without an answer. */
  appliedThreshold: number | null;
  /**
   * Why no pass/fail was accepted: answered below the threshold, answered `insufficient_evidence`, answered at
   * the threshold but not applied (a model the kind is not measured on), refused before any call (incomplete
   * evidence), or never answered.
   */
  abstained: null | 'below_threshold' | 'model_uncertain' | 'not_applied' | 'evaluator_refused' | UiCopyNoAnswer;
  actionState: { verdict: string; observed: string | null } | null;
  inspected: string[];
  findings: number;
  retention: MaterialRetention;
  cacheHit: boolean;
  /** This run invoked the provider for the case, whatever came back (an answer, a timeout, a failure). */
  invoked: boolean;
  modelVersion: string | null;
  /** Spent by this run: zero on a cache hit. */
  incrementalCostUsd: number;
  latencyMs: number | null;
}

export type Outcome = 'tp' | 'fp' | 'tn' | 'fn' | 'abstain_on_fail' | 'abstain_on_pass' | 'refused_correctly' | 'judged_incomplete';
export function outcomeOf(expected: Verdict, got: string): Outcome {
  if (expected === 'inconclusive') return got === 'inconclusive' ? 'refused_correctly' : 'judged_incomplete';
  if (got === 'fail') return expected === 'fail' ? 'tp' : 'fp';
  if (got === 'pass') return expected === 'pass' ? 'tn' : 'fn';
  return expected === 'fail' ? 'abstain_on_fail' : 'abstain_on_pass';
}

const tally = (outcomes: Outcome[]) => {
  const t: Record<Outcome, number> = { tp: 0, fp: 0, tn: 0, fn: 0, abstain_on_fail: 0, abstain_on_pass: 0, refused_correctly: 0, judged_incomplete: 0 };
  for (const o of outcomes) t[o]++;
  return t;
};

export interface UiCopyBenchmarkReport {
  corpusVersion: string;
  labelSource: typeof UI_COPY_CORPUS_LABEL_SOURCE;
  mode: 'offline' | 'network';
  split: string;
  policy: UiCopyPolicyIdentity & {
    /** The kind's code threshold: what applies to a model the stored measurements say nothing about. */
    kindThreshold: number;
    /** The stored measurements this run applied, and what they did to each model it saw. */
    measurement: { fingerprint: string; rows: number; models: UiCopyModelPolicy[] };
  };
  requestedModel: string;
  modelVersions: string[];
  status: 'complete' | 'incomplete';
  incompleteReasons: string[];
  cases: UiCopyCaseResult[];
  /** Against the synthetic development labels. */
  synthetic: { accepted: ReturnType<typeof tally>; raw: ReturnType<typeof tally>; actionState: { agree: number; disagree: number } };
  /** Against person-confirmed corrections only; null when there are none. */
  confirmed: { n: number; accepted: ReturnType<typeof tally>; raw: ReturnType<typeof tally> } | null;
  /** The kit's eval summary over raw answers on pass/fail cases: coverage by confidence is shown, never picked. */
  rawEval: EvalSummary;
  retention: { cases: number; ok: number; material: number; retained: number; flaggedMaterial: number };
  inspected: Record<string, number>;
  /** `live`: provider invocations this run, answered or not. `answered`: of those, with an answer. */
  calls: { live: number; answered: number; failed: number; cacheHits: number; incrementalCostUsd: number; latencyMs: { p50: number | null; p90: number | null } };
  correctionsRefused: number;
  limits: string[];
}

/** Coverage gaps this benchmark cannot close, stated with every report. */
export const UI_COPY_BENCHMARK_LIMITS = [
  'A fixed corpus of composed cards; not whole-app or runtime coverage.',
  'Labels are synthetic development labels written with the corpus; only person-confirmed corrections are scored as confirmed.',
  'No enforcement threshold is selected from these cases; the confidence table is descriptive.',
  'Source-string controls are static text placed in a composed card; runtime visibility and state, dynamic strings, .ts catalogs and development fixtures are not covered.',
  'Text and actions only: no pixels are inspected.',
] as const;

export function summarizeUiCopyBenchmark(input: {
  corpus: Pick<UiCopyCorpus, 'corpusVersion'>;
  mode: 'offline' | 'network';
  split: string;
  policy: UiCopyBenchmarkReport['policy'];
  requestedModel: string;
  results: UiCopyCaseResult[];
  correctionsRefused?: number;
  extraIncomplete?: string[];
}): UiCopyBenchmarkReport {
  const r = input.results;
  const incomplete = [...(input.extraIncomplete ?? [])];
  if (!r.length) incomplete.push('zero_cases');
  const unanswered = r.filter(c => c.abstained === 'no_provider' || c.abstained === 'cache_miss' || c.abstained === 'budget_deferred' || c.abstained === 'provider_failure');
  if (unanswered.length) incomplete.push(`${unanswered.length} case(s) without a model answer (${[...new Set(unanswered.map(c => c.abstained))].join(', ')})`);
  const lost = r.filter(c => !c.retention.ok);
  if (lost.length) incomplete.push(`${lost.length} case(s) lost material facts`);
  const passedIncomplete = r.filter(c => c.expected.copy === 'inconclusive' && c.accepted.verdict !== 'inconclusive');
  if (passedIncomplete.length) incomplete.push(`${passedIncomplete.length} incomplete-evidence case(s) were judged`);

  const rawVerdict = (c: UiCopyCaseResult) => (c.raw ? DECISION_VERDICT[c.raw.decision] : 'inconclusive');
  const confirmed = r.filter(c => c.confirmed);
  const rows: EvalPrediction[] = r.filter(c => c.expected.copy !== 'inconclusive' && c.raw).map(c => ({
    id: c.id, truth: c.expected.copy, pred: rawVerdict(c), confidence: c.raw!.confidence, costUsd: c.incrementalCostUsd, latencyMs: c.latencyMs ?? 0,
  }));
  const withState = r.filter(c => c.expected.actionState && c.actionState);
  const latencies = r.filter(c => c.invoked && c.latencyMs !== null).map(c => ({ id: c.id, truth: '', pred: '', confidence: 0, costUsd: 0, latencyMs: c.latencyMs! }));
  const inspected: Record<string, number> = {};
  for (const c of r) for (const cap of c.inspected) inspected[cap] = (inspected[cap] ?? 0) + 1;

  return {
    corpusVersion: input.corpus.corpusVersion,
    labelSource: UI_COPY_CORPUS_LABEL_SOURCE,
    mode: input.mode,
    split: input.split,
    policy: input.policy,
    requestedModel: input.requestedModel,
    modelVersions: [...new Set(r.map(c => c.modelVersion).filter((m): m is string => !!m))].sort(),
    status: incomplete.length ? 'incomplete' : 'complete',
    incompleteReasons: incomplete,
    cases: r,
    synthetic: {
      accepted: tally(r.map(c => outcomeOf(c.expected.copy, c.accepted.verdict))),
      raw: tally(r.filter(c => c.raw || c.expected.copy === 'inconclusive').map(c => outcomeOf(c.expected.copy, rawVerdict(c)))),
      actionState: { agree: withState.filter(c => c.actionState!.verdict === c.expected.actionState).length, disagree: withState.filter(c => c.actionState!.verdict !== c.expected.actionState).length },
    },
    confirmed: confirmed.length ? {
      n: confirmed.length,
      accepted: tally(confirmed.map(c => outcomeOf(c.confirmed!.expected, c.accepted.verdict))),
      raw: tally(confirmed.filter(c => c.raw).map(c => outcomeOf(c.confirmed!.expected, rawVerdict(c)))),
    } : null,
    rawEval: summarizeDecisionEval(rows, { thresholds: [0.5, 0.7, 0.8, 0.85, 0.9, 0.95], applyAt: appliedAt(r, input.policy.kindThreshold) }),
    retention: {
      cases: r.length, ok: r.length - lost.length,
      material: r.reduce((s, c) => s + c.retention.material, 0), retained: r.reduce((s, c) => s + c.retention.retained, 0),
      flaggedMaterial: r.reduce((s, c) => s + c.retention.flaggedMaterial.length, 0),
    },
    inspected,
    calls: {
      live: r.filter(c => c.invoked).length,
      answered: r.filter(c => c.invoked && c.raw).length,
      failed: r.filter(c => c.invoked && !c.raw).length,
      cacheHits: r.filter(c => c.cacheHit).length,
      incrementalCostUsd: r.reduce((s, c) => s + c.incrementalCostUsd, 0),
      latencyMs: summarizeDecisionEval(latencies).latencyMs,
    },
    correctionsRefused: input.correctionsRefused ?? 0,
    limits: [...UI_COPY_BENCHMARK_LIMITS],
  };
}

/** The one threshold the answers were held to, when there is one; the kind's otherwise. */
function appliedAt(r: UiCopyCaseResult[], kindThreshold: number): number {
  const applied = [...new Set(r.map(c => c.appliedThreshold).filter((t): t is number => t !== null))];
  return applied.length === 1 ? applied[0]! : kindThreshold;
}

const pct = (n: number | null) => (n === null ? '-' : `${(n * 100).toFixed(0)}%`);

/** Plain-text readout. Ids, labels, counts and identities only: no card text. */
export function formatUiCopyBenchmark(report: UiCopyBenchmarkReport): string {
  const t = report.synthetic.accepted;
  const raw = report.synthetic.raw;
  const lines = [
    `ui_copy detector benchmark: ${report.corpusVersion}, split ${report.split}, ${report.mode}`,
    `status: ${report.status.toUpperCase()}${report.incompleteReasons.length ? ` (${report.incompleteReasons.join('; ')})` : ''}`,
    `policy ${report.policy.kind} ${report.policy.policyVersion} / ${report.policy.featureSchemaVersion}, prompt ${report.policy.promptFingerprint.slice(0, 12)}, config ${report.policy.configFingerprint.slice(0, 12)}, kind threshold ${report.policy.kindThreshold}`,
    `measurement policy ${report.policy.measurement.fingerprint.slice(0, 12)} (${report.policy.measurement.rows} stored row(s) for this kind)`,
    ...report.policy.measurement.models.map(m => `  ${m.model}: ${m.eligible ? 'applied' : 'recorded only'} at threshold ${m.threshold} (${m.reason})`),
    `model requested ${report.requestedModel}; answered by ${report.modelVersions.join(', ') || 'none'}`,
    `labels: ${report.labelSource} (not ground truth)${report.confirmed ? `; ${report.confirmed.n} person-confirmed` : '; no person-confirmed corrections'}${report.correctionsRefused ? `; ${report.correctionsRefused} correction(s) refused` : ''}`,
    '',
    'against synthetic labels   accepted   raw',
    `  true positives            ${String(t.tp).padStart(4)}    ${String(raw.tp).padStart(4)}`,
    `  false positives           ${String(t.fp).padStart(4)}    ${String(raw.fp).padStart(4)}`,
    `  true negatives            ${String(t.tn).padStart(4)}    ${String(raw.tn).padStart(4)}`,
    `  false negatives           ${String(t.fn).padStart(4)}    ${String(raw.fn).padStart(4)}`,
    `  abstained on a defect     ${String(t.abstain_on_fail).padStart(4)}    ${String(raw.abstain_on_fail).padStart(4)}`,
    `  abstained on clean        ${String(t.abstain_on_pass).padStart(4)}    ${String(raw.abstain_on_pass).padStart(4)}`,
    `  incomplete refused        ${String(t.refused_correctly).padStart(4)}`,
    `  incomplete judged         ${String(t.judged_incomplete).padStart(4)}`,
    `action-state verifier: ${report.synthetic.actionState.agree} agree, ${report.synthetic.actionState.disagree} disagree`,
    ...(report.confirmed ? [`person-confirmed (accepted): tp ${report.confirmed.accepted.tp} fp ${report.confirmed.accepted.fp} tn ${report.confirmed.accepted.tn} fn ${report.confirmed.accepted.fn} abstain ${report.confirmed.accepted.abstain_on_fail + report.confirmed.accepted.abstain_on_pass}`] : []),
    '',
    'raw confidence >=  coverage  agreement (descriptive, not a threshold pick)',
    ...report.rawEval.coverage.map(c => `  ${c.threshold.toFixed(2)}             ${pct(c.coverage).padStart(5)}    ${pct(c.accuracy.rate).padStart(5)} of ${c.accuracy.n}`),
    '',
    `material facts: ${report.retention.retained}/${report.retention.material} material blocks retained, ${report.retention.ok}/${report.retention.cases} cases intact, ${report.retention.flaggedMaterial} flagged as dispensable`,
    `inspected: ${Object.entries(report.inspected).map(([k, v]) => `${k} ${v}`).join(', ') || 'nothing'}`,
    `calls: ${report.calls.live} live (${report.calls.answered} answered, ${report.calls.failed} failed), ${report.calls.cacheHits} cached; incremental cost $${report.calls.incrementalCostUsd.toFixed(6)}; live latency p50 ${report.calls.latencyMs.p50 ?? '-'}ms p90 ${report.calls.latencyMs.p90 ?? '-'}ms`,
    '',
    'case                           expect       raw            conf   accepted      abstained',
    ...report.cases.map(c => `${c.id.padEnd(30)} ${c.expected.copy.padEnd(12)} ${(c.raw?.decision ?? '-').padEnd(14)} ${c.raw ? c.raw.confidence.toFixed(2) : ' -  '}   ${c.accepted.verdict.padEnd(13)} ${c.abstained ?? ''}`),
    '',
    'limits:',
    ...report.limits.map(l => `  - ${l}`),
  ];
  return lines.join('\n');
}
