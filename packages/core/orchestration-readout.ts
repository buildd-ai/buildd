/**
 * The orchestration shadow readout (knowledge-base: buildd/design/conflict-aware-orchestration.md
 * §6, Step I). Pure: the loaders are in ./orchestration-readout-source.ts and
 * the operator command is scripts/orchestration-readout.ts.
 *
 * What it does, per decision (§5a creation manifest pick, §5b claim hold/start):
 *
 *  1. **Split by whole work unit.** Units that share a task, a retry chain, a
 *     PR or a recorded neighbour are one component (union-find) and land in
 *     one split, so a retry never trains on its own outcome. Components wholly
 *     after `laterFrom` are the later window; components straddling it are
 *     excluded and counted; the rest are hashed into train / held-out.
 *  2. **Replay through `runDecisionEval`.** The recorded shadow answers are
 *     replayed through the kit's eval with a fetch seam that returns each
 *     row's own recorded answer (no model call, no key), then the recorded
 *     latency and cost are restored. Rows are grouped by decision id,
 *     measured identity / fingerprint, model, candidate policy and arm.
 *  3. **Calibrate on train, judge on held-out and the later window.** The
 *     threshold is the smallest kit eval threshold whose covered train rows
 *     beat the deterministic baseline on the same rows by a Wilson lower
 *     bound. Held-out and later must each have enough covered rows and not be
 *     worse than the baseline there. Nothing here is a copied constant: with
 *     too few labels the verdict is `insufficient_n` and the threshold null.
 *  4. **Report** per-label error and coverage (the kit's summary), candidate
 *     recall, whole-set precision/recall against the regex and neighbour-union
 *     baselines (§5a), unsafe start, wait, stranded and throughput (§5b, from
 *     ./orchestration-claim-readout.ts), latency and censored/missing share.
 *
 * Verdicts: `insufficient_n`, `worse_than_baseline`, `eligible_for_gated`.
 * Only the last carries a threshold, and even then nothing is applied: a
 * reviewer turns it into a committed `PromotionEvidence` entry
 * (./orchestration-promotion.ts) with a cohort ceiling.
 *
 * A §5a group's verdict also carries `eligibility` (jev-scheduling §1d): the
 * same verdict as **lease** eligibility (gated manifest application, refuses
 * unknown scope), and a separate **ordering** eligibility graded on whole-set
 * precision/recall with unknown scope as a covariate (`judgeOrdering`).
 *
 * The output contains workspace data. It is written to a private path and
 * moved to the private knowledge base, never committed.
 */
import { createHash } from 'node:crypto';
import {
  DEFAULT_EVAL_THRESHOLDS,
  percentile,
  runDecisionEval,
  summarizeDecisionEval,
  type Decision,
  type DecisionQuestions,
  type EvalPrediction,
  type EvalSummary,
  type Rate,
} from '@builddai/ai-kit/decide';
import { CLAIM_HOLD_DECISION } from './orchestration-claim-decision';
import {
  labelClaimHoldDecisions,
  summarizeClaimHoldReadout,
  type ClaimDecisionForReadout,
  type ClaimHoldGroupSummary,
  type ClaimHoldReadoutInput,
} from './orchestration-claim-readout';
import {
  buildPickDecision,
  candidateLabel,
  DONE_LABEL,
  MANIFEST_PICK_QUESTION,
  scoreManifestSet,
  type ManifestPredictionLabel,
} from './manifest-prediction';
import { manifestPickIdentity, measuredIdentity, type PromotionEvidence, type ReadoutVerdict } from './orchestration-promotion';

export type ReadoutSplit = 'train' | 'held_out' | 'later';
export const READOUT_SPLITS: readonly ReadoutSplit[] = ['train', 'held_out', 'later'];

/**
 * Default sample floor per split (labelled rows, and covered rows at the
 * chosen threshold). A floor on evidence, not a confidence threshold;
 * `--min-n` overrides it.
 */
export const READOUT_MIN_LABELLED_PER_SPLIT = 30;
export const READOUT_DEFAULT_HELD_OUT_SHARE = 0.3;
/** z for the Wilson lower bound used when calibrating on train (95%). */
export const READOUT_WILSON_Z = 1.96;

// ── 1. Split ─────────────────────────────────────────────────────────────────

export interface WorkUnit {
  id: string;
  at: Date;
  /** Shared keys: `task:<id>`, `chain:<root>`, `pr:<n>`, `neighbour:<id>`, `mission:<id>`. */
  links: readonly string[];
}

export interface SplitPlan {
  laterFrom: Date;
  heldOutShare?: number;
  salt?: string;
}

export interface SplitResult {
  splitOf: Map<string, ReadoutSplit | 'excluded'>;
  components: number;
  straddling: number;
}

export function splitWorkUnits(units: readonly WorkUnit[], plan: SplitPlan): SplitResult {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== r) { const n = parent.get(c)!; parent.set(c, r); c = n; }
    return r;
  };
  const add = (x: string) => { if (!parent.has(x)) parent.set(x, x); };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };
  for (const u of units) {
    const self = `unit:${u.id}`;
    add(self);
    for (const l of u.links) { add(l); union(self, l); }
  }

  const byComponent = new Map<string, WorkUnit[]>();
  for (const u of units) {
    const root = find(`unit:${u.id}`);
    const list = byComponent.get(root) ?? [];
    list.push(u);
    byComponent.set(root, list);
  }

  const share = Math.min(1, Math.max(0, plan.heldOutShare ?? READOUT_DEFAULT_HELD_OUT_SHARE));
  const salt = plan.salt ?? 'orchestration-readout';
  const cut = plan.laterFrom.getTime();
  const splitOf = new Map<string, ReadoutSplit | 'excluded'>();
  let straddling = 0;
  for (const [root, members] of byComponent) {
    const before = members.some(m => m.at.getTime() < cut);
    const after = members.some(m => m.at.getTime() >= cut);
    let split: ReadoutSplit | 'excluded';
    if (before && after) { split = 'excluded'; straddling++; }
    else if (after) split = 'later';
    else {
      // Hash the component by its smallest member id: stable under link order.
      const key = members.map(m => m.id).sort()[0];
      const u = createHash('sha256').update(`${salt}:${key}`).digest().readUInt32BE(0) / 0x1_0000_0000;
      split = u < share ? 'held_out' : 'train';
    }
    void root;
    for (const m of members) splitOf.set(m.id, split);
  }
  return { splitOf, components: byComponent.size, straddling };
}

// ── 2. Replay through runDecisionEval ────────────────────────────────────────

export interface ReplayRow {
  id: string;
  truth: string;
  /** The recorded answer label; null when the call produced none (fallback). */
  suggested: string | null;
  confidence: number | null;
  latencyMs: number;
  costUsd: number | null;
  model: string | null;
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * Score recorded answers with the kit's own eval. The fetch seam answers each
 * request with that row's recorded label and confidence, so the kit parses,
 * validates and scores exactly as for a live run; nothing leaves the process.
 */
export async function replayDecisionEval<Q extends DecisionQuestions>(input: {
  decision: Decision<Q>;
  question: keyof Q & string;
  rows: readonly ReplayRow[];
  thresholds?: readonly number[];
}): Promise<{ predictions: EvalPrediction[]; summary: EvalSummary; fingerprint: string }> {
  const byId = new Map(input.rows.map(r => [r.id, r]));
  const replayFetch = async (_url: string | URL | Request, init: RequestInit = {}) => {
    let id: string | undefined;
    try { id = (JSON.parse(String(init.body)).state as { replay?: string })?.replay; } catch { /* malformed */ }
    const row = id ? byId.get(id) : undefined;
    if (!row || row.suggested === null || row.confidence === null) return jsonResponse({ error: 'no recorded answer' }, 400);
    return jsonResponse({
      model: row.model ?? 'replay',
      answers: { [input.question]: { type: 'choice', choice: row.suggested, probabilities: { [row.suggested]: row.confidence }, confidence: row.confidence } },
      usage: { input_tokens: 0, output_tokens: 0, cost: 0 },
    });
  };
  const report = await runDecisionEval({
    decision: input.decision,
    question: input.question,
    rows: input.rows,
    stateOf: r => ({ replay: r.id }),
    labelOf: r => r.truth,
    idOf: r => r.id,
    thresholds: input.thresholds,
    run: { apiKey: 'replay', fetch: replayFetch as never, sleep: async () => {}, maxAttempts: 1 },
  });
  const predictions = report.predictions.map(p => {
    const row = byId.get(String(p.id))!;
    return { ...p, latencyMs: row.latencyMs, costUsd: row.costUsd ?? 0 };
  });
  return { predictions, summary: summarizeDecisionEval(predictions, { thresholds: input.thresholds }), fingerprint: report.fingerprint };
}

// ── 3. Calibration and verdict ───────────────────────────────────────────────

export function wilsonLowerBound(correct: number, n: number, z: number = READOUT_WILSON_Z): number {
  if (n <= 0) return 0;
  const p = correct / n;
  const z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
}

const rateOf = (correct: number, n: number): Rate => ({ n, correct, rate: n ? correct / n : null });

export interface SplitJudgement {
  n: number;
  answered: number;
  summary: EvalSummary;
  /** The deterministic baseline's accuracy over the same answered rows. */
  baselineAccuracy: Rate;
  /** At the chosen threshold (null when none was chosen). */
  atThreshold: { threshold: number; coverage: number | null; accuracy: Rate; baseline: Rate } | null;
}

export interface Verdict {
  verdict: ReadoutVerdict;
  /** Set only for `eligible_for_gated`. */
  threshold: number | null;
  reasons: string[];
  splits: Record<ReadoutSplit, SplitJudgement>;
  /** §5a only (jev-scheduling §1d): lease and ordering graded separately. */
  eligibility?: ManifestEligibility;
}

export type OrderingVerdict = 'insufficient_n' | 'worse_than_baseline' | 'eligible_for_ordering';

export interface OrderingSplit {
  model: SetAggregate;
  regex: SetAggregate;
  neighbourUnion: SetAggregate;
  /** The covariate: the model's set scores split by the prediction's unknown-scope marker. */
  knownScope: SetAggregate;
  unknownScope: SetAggregate;
}

export interface OrderingEligibility {
  verdict: OrderingVerdict;
  reasons: string[];
  splits: Record<ReadoutSplit, OrderingSplit>;
}

/**
 * Two eligibilities for one manifest group. `lease` is the gated manifest
 * application verdict, unchanged: it is the group's `verdict` and still
 * refuses unknown scope. `ordering` asks only whether the predicted set is a
 * better scheduling hint than the baselines, graded on whole-set
 * precision/recall against labels, with unknown scope reported as a covariate.
 * Nothing reads `ordering` to apply anything.
 */
export interface ManifestEligibility {
  lease: { verdict: ReadoutVerdict; threshold: number | null; reasons: string[] };
  ordering: OrderingEligibility;
}

export interface ExtraCheckResult { insufficient: string[]; worse: string[] }

export function calibrateAndJudge(input: {
  predictions: Record<ReadoutSplit, readonly EvalPrediction[]>;
  /** The deterministic rule's answer for a row. */
  baselineOf: (p: EvalPrediction) => string;
  thresholds?: readonly number[];
  minN?: number;
  /** Capability checks at the chosen threshold (null when none). */
  extraChecks?: (threshold: number | null) => ExtraCheckResult;
}): Verdict {
  const thresholds = [...(input.thresholds ?? DEFAULT_EVAL_THRESHOLDS)].sort((a, b) => a - b);
  const minN = input.minN ?? READOUT_MIN_LABELLED_PER_SPLIT;
  const answeredOf = (rows: readonly EvalPrediction[]) => rows.filter(r => !r.error && r.pred !== null);
  const covered = (rows: readonly EvalPrediction[], t: number) => answeredOf(rows).filter(r => (r.confidence ?? 0) >= t);
  const acc = (rows: readonly EvalPrediction[]) => rateOf(rows.filter(r => r.pred === r.truth).length, rows.length);
  const base = (rows: readonly EvalPrediction[]) => rateOf(rows.filter(r => input.baselineOf(r) === r.truth).length, rows.length);

  const insufficient: string[] = [];
  const worse: string[] = [];
  for (const s of READOUT_SPLITS) {
    const n = answeredOf(input.predictions[s]).length;
    if (n < minN) insufficient.push(`${s}: ${n < 1 ? 'no' : 'too few'} answered labelled rows (floor ${minN})`);
  }

  let threshold: number | null = null;
  if (insufficient.length === 0) {
    for (const t of thresholds) {
      const c = covered(input.predictions.train, t);
      if (c.length < minN) continue;
      const a = acc(c);
      const b = base(c);
      if (wilsonLowerBound(a.correct, a.n) >= (b.rate ?? 1) && (a.rate ?? 0) > (b.rate ?? 1)) { threshold = t; break; }
    }
    if (threshold === null) worse.push('train: no eval threshold covers enough rows and beats the deterministic baseline');
  }

  if (threshold !== null) {
    for (const s of ['held_out', 'later'] as const) {
      const c = covered(input.predictions[s], threshold);
      if (c.length < minN) { insufficient.push(`${s}: too few rows at the train threshold (floor ${minN})`); continue; }
      const a = acc(c);
      const b = base(c);
      if ((a.rate ?? 0) < (b.rate ?? 0)) worse.push(`${s}: worse than the deterministic baseline at the train threshold`);
    }
  }

  const extra = input.extraChecks?.(threshold) ?? { insufficient: [], worse: [] };
  insufficient.push(...extra.insufficient);
  worse.push(...extra.worse);

  const splits = Object.fromEntries(READOUT_SPLITS.map((s) => {
    const rows = input.predictions[s];
    const answered = answeredOf(rows);
    const at = threshold === null ? null : (() => {
      const c = covered(rows, threshold!);
      return { threshold: threshold!, coverage: answered.length ? c.length / answered.length : null, accuracy: acc(c), baseline: base(c) };
    })();
    return [s, { n: rows.length, answered: answered.length, summary: summarizeDecisionEval(rows, { thresholds }), baselineAccuracy: base(answered), atThreshold: at } satisfies SplitJudgement];
  })) as Record<ReadoutSplit, SplitJudgement>;

  const verdict: ReadoutVerdict = insufficient.length > 0 ? 'insufficient_n' : worse.length > 0 ? 'worse_than_baseline' : 'eligible_for_gated';
  return {
    verdict,
    threshold: verdict === 'eligible_for_gated' ? threshold : null,
    reasons: [...insufficient, ...worse],
    splits,
  };
}

// ── Group readout shape ──────────────────────────────────────────────────────

export interface GroupKey {
  decisionId: string;
  /** The recorded fingerprint (claim) or the pick template identity (manifest). */
  fingerprint: string;
  /** `measuredIdentity` of the matched current definition; null when no current definition matches. */
  identity: string | null;
  model: string | null;
  candidatePolicyVersion: string;
  arm: 'apply' | 'observe';
}

export interface SetAggregate { n: number; precision: number | null; recall: number | null; f1: number | null; candidateRecall: number | null; omittedPathRate: number | null }

export interface GroupReadout {
  capability: 'orchestration_claim' | 'orchestration_manifest';
  key: GroupKey;
  counts: { decisions: number; labelled: number; censored: number; missing: number; excludedStraddle: number; fingerprintMismatch: number };
  censoredShare: number;
  missingShare: number;
  split: { components: number; straddling: number; units: Record<ReadoutSplit, number> };
  splits: Record<ReadoutSplit, SplitJudgement>;
  verdict: Verdict;
  /** Recorded latency over every decision in the group. */
  latencyMs: { p50: number | null; p90: number | null };
  /** §5b: unsafe start, wait, stranded, throughput, from ./orchestration-claim-readout.ts. */
  claim?: ClaimHoldGroupSummary;
  /** §5a: whole-set scores at the chosen threshold (as recorded when none). */
  sets?: Record<ReadoutSplit, { model: SetAggregate; regex: SetAggregate; neighbourUnion: SetAggregate; knownScope: number }>;
}

const share = (a: number, b: number) => (b > 0 ? a / b : 0);

/** The committable promotion record for an eligible group; null otherwise. A reviewer sets the cohort ceiling. */
export function promotionEvidenceDraft(g: GroupReadout): PromotionEvidence | null {
  if (g.verdict.verdict !== 'eligible_for_gated' || g.verdict.threshold === null || !g.key.identity) return null;
  return {
    decisionId: g.key.decisionId,
    candidatePolicyVersion: g.key.candidatePolicyVersion,
    measuredFingerprint: g.key.identity,
    verdict: 'eligible_for_gated',
    threshold: g.verdict.threshold,
    maxApplyingFraction: null,
    readoutRef: '',
  };
}

// ── §5b: claim hold/start ────────────────────────────────────────────────────

export interface ClaimReadoutRow extends ClaimDecisionForReadout {
  confidence: number | null;
  latencyMs: number;
  costUsd: number | null;
}

export async function buildClaimReadout(input: {
  rows: readonly ClaimReadoutRow[];
  hold: ClaimHoldReadoutInput;
  /** Per task: chain / PR / neighbour / mission link keys. */
  links: ReadonlyMap<string, readonly string[]>;
  plan: SplitPlan;
  minN?: number;
  thresholds?: readonly number[];
  /** Current definitions a recorded fingerprint may match (default: the shipped one). */
  definitions?: readonly Decision<DecisionQuestions>[];
}): Promise<GroupReadout[]> {
  const defs = input.definitions ?? [CLAIM_HOLD_DECISION as unknown as Decision<DecisionQuestions>];
  const labels = new Map(labelClaimHoldDecisions({ decisions: [...input.rows], labels: input.hold.labels }).map(l => [l.decisionId, l]));
  const split = splitWorkUnits(input.rows.map(r => ({
    id: r.id,
    at: r.createdAt,
    links: r.taskId ? [`task:${r.taskId}`, ...(input.links.get(r.taskId) ?? [])] : [],
  })), input.plan);

  const groups = new Map<string, ClaimReadoutRow[]>();
  for (const r of input.rows) {
    const k = [r.decisionId, r.fingerprint, r.model ?? '', r.candidatePolicyVersion, r.experimentArm].join('\u0000');
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }

  const out: GroupReadout[] = [];
  for (const rows of groups.values()) {
    const first = rows[0];
    const def = defs.find(d => d.id === first.decisionId && d.fingerprint === first.fingerprint) ?? null;
    const counts = { decisions: rows.length, labelled: 0, censored: 0, missing: 0, excludedStraddle: 0, fingerprintMismatch: def ? 0 : rows.length };
    const bySplit: Record<ReadoutSplit, ReplayRow[]> = { train: [], held_out: [], later: [] };
    for (const r of rows) {
      const l = labels.get(r.id);
      const s = l?.startSafety;
      if (!s || s.status === 'missing') { counts.missing++; continue; }
      if (s.status !== 'observed') { counts.censored++; continue; }
      const where = split.splitOf.get(r.id);
      if (where === 'excluded' || !where) { counts.excludedStraddle++; continue; }
      counts.labelled++;
      bySplit[where].push({
        id: r.id,
        truth: s.value ? 'HOLD' : 'START',
        suggested: r.status === 'fallback' ? null : r.suggested,
        confidence: r.confidence,
        latencyMs: r.latencyMs,
        costUsd: r.costUsd,
        model: r.model,
      });
    }

    const predictions: Record<ReadoutSplit, EvalPrediction[]> = { train: [], held_out: [], later: [] };
    if (def) {
      for (const s of READOUT_SPLITS) {
        if (bySplit[s].length === 0) continue;
        predictions[s] = (await replayDecisionEval({ decision: def, question: 'action' as never, rows: bySplit[s], thresholds: input.thresholds })).predictions;
      }
    }

    const verdict = calibrateAndJudge({
      predictions,
      baselineOf: () => 'HOLD',
      thresholds: input.thresholds,
      minN: input.minN,
      extraChecks: () => ({
        insufficient: [
          ...(def ? [] : ['fingerprint matches no current definition: re-run on the current definition']),
          ...(counts.labelled === 0
            ? ['no applied START with an observed outcome: shadow observes only the rule\'s holds, which are censored (a gated measurement cohort is needed to label starts)']
            : []),
        ],
        worse: [],
      }),
    });

    const summary = summarizeClaimHoldReadout({ ...input.hold, decisions: rows, labels: input.hold.labels.filter(l => rows.some(r => r.id === l.decisionId)) })[0];
    const units = { train: 0, held_out: 0, later: 0 };
    for (const r of rows) { const w = split.splitOf.get(r.id); if (w && w !== 'excluded') units[w]++; }
    const lat = rows.map(r => r.latencyMs);
    out.push({
      capability: 'orchestration_claim',
      key: {
        decisionId: first.decisionId,
        fingerprint: first.fingerprint,
        identity: def ? measuredIdentity(def) : null,
        model: first.model,
        candidatePolicyVersion: first.candidatePolicyVersion,
        arm: first.experimentArm,
      },
      counts,
      censoredShare: summary?.censoredShare ?? share(counts.censored, counts.decisions),
      missingShare: summary?.missingShare ?? share(counts.missing, counts.decisions),
      split: { components: split.components, straddling: split.straddling, units },
      splits: verdict.splits,
      verdict,
      latencyMs: { p50: percentile(lat, 50), p90: percentile(lat, 90) },
      claim: summary,
    });
  }
  return out;
}

// ── §5a: creation manifest picks ─────────────────────────────────────────────

export interface RecordedPick {
  step: number;
  /** Indices into `candidates`: the pick's own dynamic definition. */
  offered: number[];
  suggested: string | null;
  confidence: number | null;
  fingerprint: string;
  status: string;
}

export interface ManifestReadoutPrediction {
  predictionId: string;
  taskId: string;
  createdAt: Date;
  decisionId: string;
  candidatePolicyVersion: string;
  candidates: string[];
  picks: RecordedPick[];
  selected: string[];
  unknownScope: boolean;
  regexPaths: string[];
  neighbourUnionPaths: string[];
  label: ManifestPredictionLabel;
  /** Ledger rows per pick step (model, arm, recorded latency and cost). */
  pickRows: Array<{ model: string | null; experimentArm: 'apply' | 'observe'; latencyMs: number; costUsd: number | null } | undefined>;
}

const mean = (xs: Array<number | null>): number | null => {
  const v = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const f1 = (p: number | null, r: number | null) => (p === null || r === null ? null : p + r === 0 ? 0 : (2 * p * r) / (p + r));

function aggregate(scores: Array<ReturnType<typeof scoreManifestSet>>): SetAggregate {
  return {
    n: scores.length,
    precision: mean(scores.map(s => s.precision)),
    recall: mean(scores.map(s => s.recall)),
    f1: mean(scores.map(s => f1(s.precision, s.recall))),
    candidateRecall: mean(scores.map(s => s.candidateRecall)),
    omittedPathRate: mean(scores.map(s => s.omittedPathRate)),
  };
}

/**
 * On-policy truth for a recorded pick: any actual file still offered is a
 * correct pick, so a model that picks a true file out of rank order is right.
 * Otherwise the truth is the first actual file in candidate rank order, or
 * DONE when none is offered. Deterministic.
 */
function pickTruth(offeredPaths: readonly string[], actual: ReadonlySet<string>, suggestedPath: string | null): string {
  if (suggestedPath && actual.has(suggestedPath)) return candidateLabel(offeredPaths.indexOf(suggestedPath));
  const i = offeredPaths.findIndex(p => actual.has(p));
  return i === -1 ? DONE_LABEL : candidateLabel(i);
}

/** The selection a gated policy at `t` would keep: picks in order until the first below `t`. */
function selectionAt(p: ManifestReadoutPrediction, t: number | null): string[] {
  if (t === null) return p.selected;
  const out: string[] = [];
  for (const k of [...p.picks].sort((a, b) => a.step - b.step)) {
    if (k.confidence === null || k.confidence < t || !k.suggested || k.suggested === DONE_LABEL) break;
    const offered = k.offered.map(i => p.candidates[i]);
    const path = offered[Number(k.suggested.replace(/^c/, ''))];
    if (!path) break;
    out.push(path);
  }
  return out;
}

const observedActual = (p: ManifestReadoutPrediction) => (p.label as Extract<ManifestPredictionLabel, { status: 'observed' }>).actual;

/**
 * Ordering eligibility: the recorded selection as a scheduling hint, graded on
 * whole-set F1 against the regex and neighbour-union baselines. Every split
 * needs the labelled floor; train must beat the better baseline and held-out
 * and later must not fall below it. Unknown scope is reported per split, never
 * a disqualifier.
 */
export function judgeOrdering(labelled: Record<ReadoutSplit, readonly ManifestReadoutPrediction[]>, minN: number): OrderingEligibility {
  const splits = Object.fromEntries(READOUT_SPLITS.map((s) => {
    const rows = labelled[s].filter(p => p.label.status === 'observed');
    const score = (subset: readonly ManifestReadoutPrediction[], sel: (p: ManifestReadoutPrediction) => readonly string[]) =>
      aggregate(subset.map(p => scoreManifestSet({ selected: sel(p), candidates: p.candidates, actual: observedActual(p) })));
    return [s, {
      model: score(rows, p => p.selected),
      regex: score(rows, p => p.regexPaths),
      neighbourUnion: score(rows, p => p.neighbourUnionPaths),
      knownScope: score(rows.filter(p => !p.unknownScope), p => p.selected),
      unknownScope: score(rows.filter(p => p.unknownScope), p => p.selected),
    } satisfies OrderingSplit];
  })) as Record<ReadoutSplit, OrderingSplit>;

  const insufficient: string[] = [];
  const worse: string[] = [];
  for (const s of READOUT_SPLITS) {
    if (splits[s].model.n < minN) insufficient.push(`ordering ${s}: ${splits[s].model.n < 1 ? 'no' : 'too few'} labelled predictions (floor ${minN})`);
  }
  if (insufficient.length === 0) {
    for (const s of READOUT_SPLITS) {
      const m = splits[s].model.f1 ?? 0;
      const best = Math.max(splits[s].regex.f1 ?? 0, splits[s].neighbourUnion.f1 ?? 0);
      if (s === 'train' ? m <= best : m < best) {
        worse.push(`ordering ${s}: whole-set F1 ${s === 'train' ? 'does not beat' : 'is below'} the regex / neighbour-union baseline`);
      }
    }
  }
  const verdict: OrderingVerdict = insufficient.length ? 'insufficient_n' : worse.length ? 'worse_than_baseline' : 'eligible_for_ordering';
  return { verdict, reasons: [...insufficient, ...worse], splits };
}

export async function buildManifestReadout(input: {
  predictions: readonly ManifestReadoutPrediction[];
  links: ReadonlyMap<string, readonly string[]>;
  plan: SplitPlan;
  minN?: number;
  thresholds?: readonly number[];
}): Promise<GroupReadout[]> {
  const identity = manifestPickIdentity();
  const split = splitWorkUnits(input.predictions.map(p => ({
    id: p.predictionId,
    at: p.createdAt,
    links: [`task:${p.taskId}`, ...(input.links.get(p.taskId) ?? [])],
  })), input.plan);

  const groups = new Map<string, ManifestReadoutPrediction[]>();
  for (const p of input.predictions) {
    const meta = p.pickRows.find(Boolean);
    const k = [p.decisionId, p.candidatePolicyVersion, meta?.model ?? '', meta?.experimentArm ?? 'observe'].join('\u0000');
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }

  const out: GroupReadout[] = [];
  for (const preds of groups.values()) {
    const first = preds[0];
    const meta = first.pickRows.find(Boolean);
    const counts = { decisions: preds.length, labelled: 0, censored: 0, missing: 0, excludedStraddle: 0, fingerprintMismatch: 0 };
    const labelled: Record<ReadoutSplit, ManifestReadoutPrediction[]> = { train: [], held_out: [], later: [] };
    const predictions: Record<ReadoutSplit, EvalPrediction[]> = { train: [], held_out: [], later: [] };

    for (const p of preds) {
      if (p.label.status !== 'observed') { counts.missing++; continue; }
      const where = split.splitOf.get(p.predictionId);
      if (!where || where === 'excluded') { counts.excludedStraddle++; continue; }
      counts.labelled++;
      labelled[where].push(p);
      const actual = new Set(p.label.actual);
      for (const k of p.picks) {
        const offered = k.offered.map(i => p.candidates[i]).filter((x): x is string => typeof x === 'string');
        if (offered.length === 0) continue;
        const { decision } = buildPickDecision(offered);
        if (decision.fingerprint !== k.fingerprint) { counts.fingerprintMismatch++; continue; }
        const suggested = k.status === 'fallback' ? null : k.suggested;
        const suggestedPath = suggested && suggested !== DONE_LABEL ? offered[Number(suggested.replace(/^c/, ''))] ?? null : null;
        const row = p.pickRows[k.step];
        const [prediction] = (await replayDecisionEval({
          decision,
          question: MANIFEST_PICK_QUESTION,
          rows: [{
            id: `${p.predictionId}:${k.step}`,
            truth: pickTruth(offered, actual, suggestedPath),
            suggested,
            confidence: k.confidence,
            latencyMs: row?.latencyMs ?? 0,
            costUsd: row?.costUsd ?? null,
            model: row?.model ?? null,
          }],
          thresholds: input.thresholds,
        })).predictions;
        predictions[where].push(prediction);
      }
    }

    const setsAt = (t: number | null) => Object.fromEntries(READOUT_SPLITS.map((s) => {
      const rows = labelled[s].filter(p => p.label.status === 'observed');
      const score = (sel: (p: ManifestReadoutPrediction) => readonly string[]) => aggregate(rows.map(p =>
        scoreManifestSet({ selected: sel(p), candidates: p.candidates, actual: (p.label as Extract<ManifestPredictionLabel, { status: 'observed' }>).actual })));
      return [s, {
        model: score(p => selectionAt(p, t)),
        regex: score(p => p.regexPaths),
        neighbourUnion: score(p => p.neighbourUnionPaths),
        knownScope: rows.filter(p => !p.unknownScope).length,
      }];
    })) as NonNullable<GroupReadout['sets']>;

    const verdict = calibrateAndJudge({
      predictions,
      // The deterministic pick: the top-ranked remaining candidate.
      baselineOf: () => candidateLabel(0),
      thresholds: input.thresholds,
      minN: input.minN,
      extraChecks: (t) => {
        const sets = setsAt(t);
        const insufficient: string[] = [];
        const worse: string[] = [];
        if (counts.labelled > 0 && READOUT_SPLITS.every(s => sets[s].knownScope === 0)) {
          insufficient.push('unknown scope on every labelled prediction: gated application refuses unknown scope (truncated candidates, a named new file, or no tree-pinned candidate source)');
        }
        if (t !== null) {
          for (const s of ['held_out', 'later'] as const) {
            const m = sets[s].model.f1 ?? 0;
            const best = Math.max(sets[s].regex.f1 ?? 0, sets[s].neighbourUnion.f1 ?? 0);
            if (m < best) worse.push(`${s}: whole-set F1 at the threshold is below the regex / neighbour-union baseline`);
          }
        }
        return { insufficient, worse };
      },
    });

    verdict.eligibility = {
      lease: { verdict: verdict.verdict, threshold: verdict.threshold, reasons: [...verdict.reasons] },
      ordering: judgeOrdering(labelled, input.minN ?? READOUT_MIN_LABELLED_PER_SPLIT),
    };

    const units = { train: 0, held_out: 0, later: 0 };
    for (const p of preds) { const w = split.splitOf.get(p.predictionId); if (w && w !== 'excluded') units[w]++; }
    const lat = preds.flatMap(p => p.pickRows.filter(Boolean).map(r => r!.latencyMs));
    out.push({
      capability: 'orchestration_manifest',
      key: {
        decisionId: first.decisionId,
        fingerprint: identity,
        identity,
        model: meta?.model ?? null,
        candidatePolicyVersion: first.candidatePolicyVersion,
        arm: meta?.experimentArm ?? 'observe',
      },
      counts,
      censoredShare: 0,
      missingShare: share(counts.missing, counts.decisions),
      split: { components: split.components, straddling: split.straddling, units },
      splits: verdict.splits,
      verdict,
      latencyMs: { p50: percentile(lat, 50), p90: percentile(lat, 90) },
      sets: setsAt(verdict.threshold),
    });
  }
  return out;
}

// ── 4. Whole readout ─────────────────────────────────────────────────────────

export interface CapabilityReadout {
  capability: GroupReadout['capability'];
  verdict: ReadoutVerdict;
  reasons: string[];
  groups: GroupReadout[];
}

export interface OrchestrationReadout {
  generatedAt: string;
  window: { since: string; until: string; laterFrom: string };
  minLabelledPerSplit: number;
  capabilities: CapabilityReadout[];
  /** `blocked` unless some group is eligible; even then a reviewer commits the evidence. */
  promotion: { status: 'blocked' | 'reviewable'; eligible: PromotionEvidence[] };
}

function rollUp(capability: GroupReadout['capability'], groups: GroupReadout[]): CapabilityReadout {
  if (groups.length === 0) return { capability, verdict: 'insufficient_n', reasons: ['no labelled rows in the window: nothing has been recorded for this decision'], groups };
  const verdict: ReadoutVerdict = groups.some(g => g.verdict.verdict === 'eligible_for_gated')
    ? 'eligible_for_gated'
    : groups.some(g => g.verdict.verdict === 'worse_than_baseline') ? 'worse_than_baseline' : 'insufficient_n';
  return { capability, verdict, reasons: [...new Set(groups.flatMap(g => g.verdict.reasons))], groups };
}

export async function buildOrchestrationReadout(input: {
  claim: { rows: readonly ClaimReadoutRow[]; hold: ClaimHoldReadoutInput; links: ReadonlyMap<string, readonly string[]> };
  manifest: { predictions: readonly ManifestReadoutPrediction[]; links: ReadonlyMap<string, readonly string[]> };
  window: { since: Date; until: Date };
  plan: SplitPlan;
  minN?: number;
  thresholds?: readonly number[];
  now?: () => Date;
}): Promise<OrchestrationReadout> {
  const minN = input.minN ?? READOUT_MIN_LABELLED_PER_SPLIT;
  const claim = await buildClaimReadout({ ...input.claim, plan: input.plan, minN, thresholds: input.thresholds });
  const manifest = await buildManifestReadout({ ...input.manifest, plan: input.plan, minN, thresholds: input.thresholds });
  const capabilities = [rollUp('orchestration_manifest', manifest), rollUp('orchestration_claim', claim)];
  const eligible = [...manifest, ...claim].map(promotionEvidenceDraft).filter((e): e is PromotionEvidence => e !== null);
  return {
    generatedAt: (input.now?.() ?? new Date()).toISOString(),
    window: { since: input.window.since.toISOString(), until: input.window.until.toISOString(), laterFrom: input.plan.laterFrom.toISOString() },
    minLabelledPerSplit: minN,
    capabilities,
    promotion: { status: eligible.length > 0 ? 'reviewable' : 'blocked', eligible },
  };
}
