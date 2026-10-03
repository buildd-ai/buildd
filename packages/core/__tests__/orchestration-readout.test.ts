import { describe, it, expect } from 'bun:test';
import { choice, defineDecision, JEV_MODEL, type EvalPrediction } from '@builddai/ai-kit/decide';
import {
  buildClaimReadout,
  buildManifestReadout,
  buildOrchestrationReadout,
  calibrateAndJudge,
  promotionEvidenceDraft,
  replayDecisionEval,
  splitWorkUnits,
  wilsonLowerBound,
  type ClaimReadoutRow,
  type ManifestReadoutPrediction,
  type SplitPlan,
} from '../orchestration-readout';
import { CLAIM_HOLD_DECISION } from '../orchestration-claim-decision';
import { buildPickDecision, candidateLabel, DONE_LABEL, MANIFEST_CANDIDATE_POLICY_VERSION, MANIFEST_DECISION_ID } from '../manifest-prediction';
import { claimHoldIdentity, manifestPickIdentity } from '../orchestration-promotion';
import type { DecisionOutcomeLabels } from '../orchestration-outcomes';

/**
 * The Step I readout (§6). Synthetic fixtures only: no production row shape
 * beyond what the ledger columns already define, no real ids or paths.
 */

const T0 = new Date('2026-01-01T00:00:00.000Z');
const day = (d: number) => new Date(T0.getTime() + d * 86_400_000);
const PLAN: SplitPlan = { laterFrom: day(20), heldOutShare: 0.5, salt: 'fixture' };

// ── Split ───────────────────────────────────────────────────────────────────

describe('splitWorkUnits: whole work units, no leakage', () => {
  it('keeps every unit sharing a link (retry chain, PR, neighbour) in one split', () => {
    const units = [
      { id: 'a', at: day(1), links: ['chain:x'] },
      { id: 'b', at: day(2), links: ['chain:x', 'pr:1'] },
      { id: 'c', at: day(3), links: ['pr:1'] },
      ...Array.from({ length: 40 }, (_, i) => ({ id: `u${i}`, at: day(4), links: [`chain:u${i}`] })),
    ];
    const s = splitWorkUnits(units, PLAN);
    expect(s.splitOf.get('a')).toBe(s.splitOf.get('b'));
    expect(s.splitOf.get('b')).toBe(s.splitOf.get('c'));
    expect(['train', 'held_out']).toContain(s.splitOf.get('a')!);
    // Both pre-window splits get something at a half share over many components.
    const values = [...s.splitOf.values()];
    expect(values).toContain('train');
    expect(values).toContain('held_out');
  });

  it('puts components wholly after laterFrom in the later window, and excludes one that straddles it', () => {
    const s = splitWorkUnits([
      { id: 'late', at: day(25), links: ['chain:l'] },
      { id: 'early-half', at: day(10), links: ['chain:s'] },
      { id: 'late-half', at: day(22), links: ['chain:s'] },
    ], PLAN);
    expect(s.splitOf.get('late')).toBe('later');
    expect(s.splitOf.get('early-half')).toBe('excluded');
    expect(s.splitOf.get('late-half')).toBe('excluded');
    expect(s.straddling).toBe(1);
  });

  it('is deterministic for the same salt', () => {
    const units = Array.from({ length: 30 }, (_, i) => ({ id: `u${i}`, at: day(1), links: [] as string[] }));
    const a = splitWorkUnits(units, PLAN);
    const b = splitWorkUnits(units, PLAN);
    expect([...a.splitOf.entries()]).toEqual([...b.splitOf.entries()]);
  });
});

// ── Replay through runDecisionEval ──────────────────────────────────────────

describe('replayDecisionEval', () => {
  const decision = defineDecision({ id: 'test.replay', promptVersion: 'v1', questions: { action: choice('q', { HOLD: 'h', START: 's' }) }, mode: 'shadow' });

  it('scores the recorded answers with the kit eval, keeping recorded latency and cost', async () => {
    const out = await replayDecisionEval({
      decision,
      question: 'action',
      rows: [
        { id: 'r1', truth: 'START', suggested: 'START', confidence: 0.9, latencyMs: 120, costUsd: 0.001, model: JEV_MODEL },
        { id: 'r2', truth: 'HOLD', suggested: 'START', confidence: 0.6, latencyMs: 300, costUsd: 0.001, model: JEV_MODEL },
        { id: 'r3', truth: 'HOLD', suggested: null, confidence: null, latencyMs: 5000, costUsd: null, model: null },
      ],
    });
    expect(out.fingerprint).toBe(decision.fingerprint);
    expect(out.predictions.map(p => [p.id, p.pred, p.truth])).toEqual([['r1', 'START', 'START'], ['r2', 'START', 'HOLD'], ['r3', null, 'HOLD']]);
    expect(out.predictions.find(p => p.id === 'r3')!.error).toBeTruthy();
    expect(out.summary.accuracy).toEqual({ n: 2, correct: 1, rate: 0.5 });
    expect(out.summary.errors).toBe(1);
    expect(out.predictions.find(p => p.id === 'r2')!.latencyMs).toBe(300);
    expect(out.summary.costUsd).toBeCloseTo(0.002, 9);
  });
});

// ── Calibration and verdict ─────────────────────────────────────────────────

const pred = (id: string, truth: string, p: string, confidence: number): EvalPrediction => ({ id, truth, pred: p, confidence, costUsd: 0, latencyMs: 10 });
const many = (prefix: string, n: number, make: (i: number) => [string, string, number]) =>
  Array.from({ length: n }, (_, i) => { const [t, p, c] = make(i); return pred(`${prefix}${i}`, t, p, c); });

describe('wilsonLowerBound', () => {
  it('is below the point estimate and tightens with n', () => {
    expect(wilsonLowerBound(9, 10)).toBeLessThan(0.9);
    expect(wilsonLowerBound(90, 100)).toBeGreaterThan(wilsonLowerBound(9, 10));
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });
});

describe('calibrateAndJudge', () => {
  // The rule always says HOLD. Every fifth row is a low-confidence wrong START
  // (truth HOLD); the rest are confident and right, a quarter of them START.
  // At 0.5 the model only ties the rule; at 0.7 it beats it on the covered rows.
  const good = (i: number): [string, string, number] => {
    if (i % 5 === 0) return ['HOLD', 'START', 0.55];
    const truth = i % 4 === 1 ? 'START' : 'HOLD';
    return [truth, truth, 0.93];
  };
  const baselineOf = () => 'HOLD';

  it('insufficient_n emits no threshold, even when the model looks good', () => {
    const v = calibrateAndJudge({
      predictions: { train: many('t', 5, good), held_out: many('h', 5, good), later: many('l', 5, good) },
      baselineOf, minN: 30,
    });
    expect(v.verdict).toBe('insufficient_n');
    expect(v.threshold).toBeNull();
    expect(v.reasons.join(' ')).toContain('train');
  });

  it('chooses the smallest threshold that beats the baseline on train, confirmed on held-out and later', () => {
    const v = calibrateAndJudge({
      predictions: { train: many('t', 60, good), held_out: many('h', 60, good), later: many('l', 60, good) },
      baselineOf, minN: 20,
    });
    expect(v.verdict).toBe('eligible_for_gated');
    // 0.5 covers the low-confidence wrong rows and only ties the rule; 0.7 is the first cut that beats it.
    expect(v.threshold).toBe(0.7);
    expect(v.splits.held_out.atThreshold!.accuracy.rate).toBe(1);
    expect(v.splits.held_out.atThreshold!.baseline.rate).toBeLessThan(1);
  });

  it('a model no better than the rule is worse_than_baseline, with no threshold', () => {
    const rule = (i: number): [string, string, number] => ['HOLD', i % 2 ? 'START' : 'HOLD', 0.96];
    const v = calibrateAndJudge({
      predictions: { train: many('t', 60, rule), held_out: many('h', 60, rule), later: many('l', 60, rule) },
      baselineOf, minN: 20,
    });
    expect(v.verdict).toBe('worse_than_baseline');
    expect(v.threshold).toBeNull();
  });

  it('a threshold that holds on train but fails the later window is worse_than_baseline, no threshold', () => {
    const drift = (i: number): [string, string, number] => ['START', 'HOLD', 0.95 + (i % 2) * 0.01];
    const v = calibrateAndJudge({
      predictions: { train: many('t', 60, good), held_out: many('h', 60, good), later: many('l', 60, drift) },
      baselineOf: () => 'START', minN: 20,
    });
    expect(v.verdict).not.toBe('eligible_for_gated');
    expect(v.threshold).toBeNull();
  });

  it('an extra check can block (insufficient or worse) and always clears the threshold', () => {
    const p = { train: many('t', 60, good), held_out: many('h', 60, good), later: many('l', 60, good) };
    const a = calibrateAndJudge({ predictions: p, baselineOf, minN: 20, extraChecks: () => ({ insufficient: ['unknown scope everywhere'], worse: [] }) });
    expect(a).toMatchObject({ verdict: 'insufficient_n', threshold: null });
    const b = calibrateAndJudge({ predictions: p, baselineOf, minN: 20, extraChecks: () => ({ insufficient: [], worse: ['set F1 below baseline'] }) });
    expect(b).toMatchObject({ verdict: 'worse_than_baseline', threshold: null });
  });
});

// ── Claim (§5b) ─────────────────────────────────────────────────────────────

const observedLabel = (decisionId: string, risk: boolean): DecisionOutcomeLabels => ({
  decisionId,
  task: { status: 'observed', value: 'completed' },
  touched: { status: 'observed', value: { paths: ['a.ts'], landed: true, failed: false, truncated: false } },
  conflictCreated: { status: 'observed', value: risk, count: risk ? 1 : 0, joinKey: 'pr' },
  collision: { status: 'observed', value: false, count: 0 },
  mergeBaseRefusal: { status: 'observed', value: false, count: 0, joinKey: 'pr' },
  risk: { status: 'observed', value: risk },
});

const claimRow = (i: number, over: Partial<ClaimReadoutRow> = {}): ClaimReadoutRow => ({
  id: `d${i}`,
  taskId: `task-${i}`,
  workspaceId: 'ws',
  decisionId: CLAIM_HOLD_DECISION.id,
  fingerprint: CLAIM_HOLD_DECISION.fingerprint,
  candidatePolicyVersion: 'ch1.open_pr_overlap',
  model: JEV_MODEL,
  experimentArm: 'observe',
  propensity: 1,
  applied: false,
  effective: 'HOLD',
  suggested: i % 2 ? 'START' : 'HOLD',
  status: 'suggested',
  reason: 'shadow',
  confidence: 0.9,
  latencyMs: 200,
  costUsd: 0.0001,
  createdAt: day(1 + (i % 30)),
  ...over,
});

describe('buildClaimReadout', () => {
  it('shadow-only evidence is insufficient by construction: every hold is censored, no threshold', async () => {
    const decisions = Array.from({ length: 40 }, (_, i) => claimRow(i));
    const [g] = await buildClaimReadout({
      rows: decisions,
      hold: { decisions, labels: decisions.map(d => observedLabel(d.id, false)), tasks: decisions.map(d => ({ id: d.taskId!, status: 'completed' })), starts: [], windowEnd: day(40) },
      links: new Map(),
      plan: PLAN,
      minN: 5,
    });
    expect(g.verdict.verdict).toBe('insufficient_n');
    expect(g.verdict.threshold).toBeNull();
    expect(g.verdict.reasons.join(' ')).toMatch(/applied START/);
    expect(g.counts.labelled).toBe(0);
    expect(g.censoredShare).toBe(1);
    // HOLD-everything still reports its costs: wait, stranded and throughput are present.
    expect(g.claim).toBeDefined();
    expect(g.claim!.throughput.starts).toBe(0);
    expect(g.claim!.stranded).toBeDefined();
    expect(g.key.identity).toBe(claimHoldIdentity(CLAIM_HOLD_DECISION));
    expect(promotionEvidenceDraft(g)).toBeNull();
  });

  it('grades only applied STARTs (truth = observed risk) against the rule baseline HOLD', async () => {
    const decisions = Array.from({ length: 30 }, (_, i) => claimRow(i, {
      experimentArm: 'apply', propensity: 0.1, applied: true, effective: 'START', suggested: 'START', status: 'applied', reason: null, confidence: 0.95,
    }));
    const [g] = await buildClaimReadout({
      rows: decisions,
      hold: {
        decisions,
        labels: decisions.map((d, i) => observedLabel(d.id, i % 10 === 0)),
        tasks: decisions.map(d => ({ id: d.taskId!, status: 'completed' })),
        starts: decisions.map(d => ({ taskId: d.taskId!, startedAt: d.createdAt })),
        windowEnd: day(40),
      },
      links: new Map(),
      plan: PLAN,
      minN: 2,
    });
    expect(g.counts.labelled).toBe(30);
    expect(g.claim!.unsafeStartRate).toBeCloseTo(0.1, 9);
    expect(g.key.arm).toBe('apply');
    // Model always says START; truth is START on most rows; baseline HOLD is right only on the risky ones.
    expect(g.splits.train.summary.accuracy.rate).toBeGreaterThan(g.splits.train.baselineAccuracy.rate!);
  });

  it('a row whose fingerprint is not the current definition is excluded and counted', async () => {
    const decisions = [claimRow(1, { fingerprint: '000000000000' }), claimRow(2)];
    const groups = await buildClaimReadout({
      rows: decisions,
      hold: { decisions, labels: [], tasks: [], starts: [], windowEnd: day(40) },
      links: new Map(),
      plan: PLAN,
      minN: 1,
    });
    const stale = groups.find(g => g.key.fingerprint === '000000000000')!;
    expect(stale.counts.fingerprintMismatch).toBe(1);
    expect(stale.verdict.verdict).toBe('insufficient_n');
    expect(stale.verdict.reasons.join(' ')).toMatch(/fingerprint/);
  });
});

// ── Manifest (§5a) ──────────────────────────────────────────────────────────

const CANDS = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
const pickRow = (step: number, offered: number[], suggested: string | null, confidence: number | null) => ({
  step,
  offered,
  suggested,
  confidence,
  fingerprint: buildPickDecision(offered.map(i => CANDS[i])).decision.fingerprint,
  status: suggested === null ? 'fallback' : 'suggested',
});

const manifestPrediction = (i: number, over: Partial<ManifestReadoutPrediction> = {}): ManifestReadoutPrediction => ({
  predictionId: `p${i}`,
  taskId: `task-${i}`,
  createdAt: day(1 + (i % 15)),
  candidatePolicyVersion: MANIFEST_CANDIDATE_POLICY_VERSION,
  decisionId: MANIFEST_DECISION_ID,
  candidates: CANDS,
  // Picks a (c0), then b (c0 of the remaining two), then DONE.
  picks: [pickRow(0, [0, 1, 2], candidateLabel(0), 0.95), pickRow(1, [1, 2], candidateLabel(0), 0.9), pickRow(2, [2], DONE_LABEL, 0.8)],
  selected: ['src/a.ts', 'src/b.ts'],
  unknownScope: true,
  regexPaths: ['src'],
  neighbourUnionPaths: CANDS,
  label: {
    status: 'observed',
    actual: ['src/a.ts', 'src/new.ts'],
    landed: true,
    failed: false,
    failedWork: [],
    unknownScope: true,
    model: {} as any,
    baselines: {} as any,
  },
  pickRows: [{ model: JEV_MODEL, experimentArm: 'observe', latencyMs: 300, costUsd: 0.0001 }],
  ...over,
});

describe('buildManifestReadout', () => {
  it('replays picks on-policy, scores sets against overlap-scored baselines, and blocks on unknown scope', async () => {
    const preds = Array.from({ length: 30 }, (_, i) => manifestPrediction(i));
    const [g] = await buildManifestReadout({ predictions: preds, links: new Map(), plan: PLAN, minN: 2 });
    expect(g.key.identity).toBe(manifestPickIdentity());
    expect(g.counts.decisions).toBe(30);
    // Three picks per prediction: a is right, b is wrong (truth: DONE, since nothing left is actual), DONE right.
    const s = g.splits.train.summary;
    expect(s.accuracy.n % 3).toBe(0);
    expect(s.accuracy.rate).toBeCloseTo(2 / 3, 9);
    // Whole-set: one of two selected is actual; one of two actual is selected; new.ts is a candidate miss.
    expect(g.sets!.train.model.precision).toBeCloseTo(0.5, 9);
    expect(g.sets!.train.model.recall).toBeCloseTo(0.5, 9);
    expect(g.sets!.train.model.candidateRecall).toBeCloseTo(0.5, 9);
    // The regex baseline names the directory: overlap credits both actual files.
    expect(g.sets!.train.regex.recall).toBe(1);
    expect(g.verdict.verdict).toBe('insufficient_n');
    expect(g.verdict.threshold).toBeNull();
    expect(g.verdict.reasons.join(' ')).toMatch(/unknown scope/);
  });

  it('grades ordering and lease eligibility separately: ordering-eligible while lease-ineligible on unknown scope', async () => {
    // Model selects exactly the actual file; baselines over-select. Every prediction has unknown scope.
    const preds = Array.from({ length: 40 }, (_, i) => manifestPrediction(i, {
      createdAt: day(1 + (i % 30)),
      selected: ['src/a.ts'],
      picks: [pickRow(0, [0, 1, 2], candidateLabel(0), 0.95), pickRow(1, [1, 2], DONE_LABEL, 0.9)],
      regexPaths: ['lib'],
      neighbourUnionPaths: CANDS,
      label: { status: 'observed', actual: ['src/a.ts'], landed: true, failed: false, failedWork: [], unknownScope: true, model: {} as any, baselines: {} as any },
    }));
    const [g] = await buildManifestReadout({ predictions: preds, links: new Map(), plan: PLAN, minN: 2 });
    const e = g.verdict.eligibility!;
    // Lease (gated manifest application) still refuses unknown scope.
    expect(e.lease.verdict).not.toBe('eligible_for_gated');
    expect(e.lease.verdict).toBe(g.verdict.verdict);
    expect(e.lease.reasons.join(' ')).toMatch(/unknown scope/);
    // Ordering is graded on set precision/recall; unknown scope is a covariate, not a disqualifier.
    expect(e.ordering.verdict).toBe('eligible_for_ordering');
    expect(e.ordering.reasons).toEqual([]);
    for (const s of ['train', 'held_out', 'later'] as const) {
      expect(e.ordering.splits[s].model.precision).toBe(1);
      expect(e.ordering.splits[s].model.recall).toBe(1);
      expect(e.ordering.splits[s].unknownScope.n).toBe(e.ordering.splits[s].model.n);
      expect(e.ordering.splits[s].knownScope.n).toBe(0);
    }
  });

  it('ordering is worse_than_baseline when the selection loses to a baseline on set F1', async () => {
    const preds = Array.from({ length: 40 }, (_, i) => manifestPrediction(i, {
      createdAt: day(1 + (i % 30)),
      selected: ['src/c.ts'],
      regexPaths: ['src/a.ts'],
      label: { status: 'observed', actual: ['src/a.ts'], landed: true, failed: false, failedWork: [], unknownScope: false, model: {} as any, baselines: {} as any },
    }));
    const [g] = await buildManifestReadout({ predictions: preds, links: new Map(), plan: PLAN, minN: 2 });
    expect(g.verdict.eligibility!.ordering.verdict).toBe('worse_than_baseline');
  });

  it('ordering is insufficient_n below the per-split floor', async () => {
    const [g] = await buildManifestReadout({ predictions: [manifestPrediction(1)], links: new Map(), plan: PLAN, minN: 5 });
    expect(g.verdict.eligibility!.ordering.verdict).toBe('insufficient_n');
  });

  it('counts missing and failed-only labels as missing, not as truth', async () => {
    const preds = [
      manifestPrediction(1, { label: { status: 'missing', reason: 'no_terminal_observation' } }),
      manifestPrediction(2, { label: { status: 'missing', reason: 'failed_work_only', failedWork: ['x.ts'] } }),
      manifestPrediction(3),
    ];
    const [g] = await buildManifestReadout({ predictions: preds, links: new Map(), plan: PLAN, minN: 1 });
    expect(g.counts.missing).toBe(2);
    expect(g.missingShare).toBeCloseTo(2 / 3, 9);
  });

  it('a pick whose recorded fingerprint does not match its rebuilt definition is excluded and counted', async () => {
    const p = manifestPrediction(1);
    p.picks[0] = { ...p.picks[0], fingerprint: '000000000000' };
    const [g] = await buildManifestReadout({ predictions: [p], links: new Map(), plan: PLAN, minN: 1 });
    expect(g.counts.fingerprintMismatch).toBe(1);
  });
});

// ── Whole readout ───────────────────────────────────────────────────────────

describe('buildOrchestrationReadout', () => {
  it('with no deployed evidence: both decisions insufficient, no threshold anywhere, promotion blocked', async () => {
    const r = await buildOrchestrationReadout({
      claim: { rows: [], hold: { decisions: [], labels: [], tasks: [], starts: [], windowEnd: day(40) }, links: new Map() },
      manifest: { predictions: [], links: new Map() },
      window: { since: day(0), until: day(40) },
      plan: PLAN,
      minN: 30,
    });
    expect(r.capabilities.map(c => c.capability).sort()).toEqual(['orchestration_claim', 'orchestration_manifest']);
    for (const c of r.capabilities) {
      expect(c.verdict).toBe('insufficient_n');
      expect(c.reasons.join(' ')).toMatch(/no labelled/);
      for (const g of c.groups) expect(g.verdict.threshold).toBeNull();
    }
    expect(r.promotion).toEqual({ status: 'blocked', eligible: [] });
    expect(JSON.stringify(r)).not.toMatch(/"threshold":0\.\d/);
  });
});
