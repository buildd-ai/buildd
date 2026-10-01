import { describe, it, expect } from 'bun:test';
import { MAX_CHOICE_OPTIONS } from '@builddai/ai-kit/decide';
import {
  DONE_LABEL,
  MANIFEST_MAX_CANDIDATES,
  DEFAULT_MANIFEST_PICK_CAP,
  MAX_MANIFEST_PICK_CAP,
  GATED_MANIFEST_APPLICATION_ENABLED,
  buildManifestCandidates,
  buildPickDecision,
  buildPickEvalRows,
  candidateLabel,
  evaluateManifestPicks,
  isConcreteCandidatePath,
  labelManifestPrediction,
  prepareGatedManifest,
  resolvePickCap,
  runRepeatedManifestChoice,
  scoreManifestSet,
  type PickRunner,
  type ManifestPredictionRecord,
} from '../manifest-prediction';
import type { OrchestrationDecisionOutcome } from '../orchestration-decision';

/**
 * The pure half of creation-time manifest prediction (design §5a): candidate
 * assembly, the bounded repeated Choice, gated-application eligibility and the
 * labels. All synthetic fixtures; no DB, no network.
 */

const CUTOFF = new Date('2026-09-10T00:00:00Z');
const BEFORE = new Date('2026-09-09T00:00:00Z');
const AFTER = new Date('2026-09-11T00:00:00Z');
const UNAVAILABLE = { status: 'unavailable' as const, reason: 'no server-side index' };

const outcome = (o: Partial<OrchestrationDecisionOutcome>): OrchestrationDecisionOutcome => ({
  effective: DONE_LABEL,
  applied: false,
  status: 'suggested',
  reason: 'shadow',
  suggested: null,
  confidence: 0.9,
  row: null,
  ...o,
});

/** A runner that answers with the label whose path is next in `wanted`, then DONE. */
function scriptedRunner(wanted: string[], extra: Partial<OrchestrationDecisionOutcome> = {}): { run: PickRunner; calls: Parameters<PickRunner>[0][] } {
  const calls: Parameters<PickRunner>[0][] = [];
  const run: PickRunner = async (args) => {
    calls.push(args);
    const next = wanted.find(p => Object.values(args.labelMap).includes(p));
    const label = next ? Object.entries(args.labelMap).find(([, p]) => p === next)![0] : DONE_LABEL;
    return outcome({ suggested: label, ...extra });
  };
  return { run, calls };
}

describe('constants', () => {
  it('254 candidates plus DONE is exactly the kit choice maximum', () => {
    expect(MANIFEST_MAX_CANDIDATES + 1).toBe(MAX_CHOICE_OPTIONS);
  });
  it('gated application ships disabled', () => {
    expect(GATED_MANIFEST_APPLICATION_ENABLED).toBe(false);
  });
});

describe('isConcreteCandidatePath', () => {
  it('accepts repo-relative files and rejects wildcards, globs, traversal, absolute and directories', () => {
    expect(isConcreteCandidatePath('apps/web/src/lib/foo.ts')).toBe(true);
    expect(isConcreteCandidatePath('README.md')).toBe(true);
    for (const bad of ['**', 'apps/**', 'src/*.ts', '../etc/passwd', '/abs/path.ts', 'apps/web/', '', '  ', 'a/{b,c}.ts']) {
      expect(isConcreteCandidatePath(bad)).toBe(false);
    }
  });
});

describe('buildManifestCandidates', () => {
  it('ranks diff paths by summed neighbour score, dedupes, and records neighbour-only coverage when CBM is unavailable', () => {
    const set = buildManifestCandidates({
      cutoff: CUTOFF,
      neighbours: [
        { taskId: 't1', score: 0.9, completedAt: BEFORE, paths: ['a.ts', 'b.ts'] },
        { taskId: 't2', score: 0.5, completedAt: BEFORE, paths: ['b.ts', 'c.ts', '**'] },
      ],
      cbm: UNAVAILABLE,
    });
    expect(set.candidates).toEqual(['b.ts', 'a.ts', 'c.ts']);
    expect(set.sources).toEqual(['diff', 'diff', 'diff']);
    expect(set.truncated).toBe(false);
    expect(set.coverage.cbm).toBe('unavailable');
    expect(set.coverage.source).toBe('neighbour_diff_only');
    expect(set.coverage.revisionPinned).toBe(false);
    // CBM could not enumerate files the neighbours never touched: omissions are unknown.
    expect(set.unknownScope).toBe(true);
  });

  it('excludes neighbours completed at or after the cutoff and undated neighbours (no future leakage)', () => {
    const set = buildManifestCandidates({
      cutoff: CUTOFF,
      neighbours: [
        { taskId: 'past', score: 0.4, completedAt: BEFORE, paths: ['past.ts'] },
        { taskId: 'future', score: 0.99, completedAt: AFTER, paths: ['future.ts'] },
        { taskId: 'same', score: 0.99, completedAt: CUTOFF, paths: ['same.ts'] },
        { taskId: 'undated', score: 0.99, completedAt: null, paths: ['undated.ts'] },
      ],
      cbm: UNAVAILABLE,
    });
    expect(set.candidates).toEqual(['past.ts']);
    expect(set.coverage.excludedFuture).toBe(2);
    expect(set.coverage.excludedUndated).toBe(1);
    expect(set.coverage.neighboursUsed).toBe(1);
  });

  it('caps at 254, marks truncation and counts omitted candidates', () => {
    const paths = Array.from({ length: 300 }, (_, i) => `f${String(i).padStart(3, '0')}.ts`);
    const set = buildManifestCandidates({
      cutoff: CUTOFF,
      neighbours: [{ taskId: 't', score: 1, completedAt: BEFORE, paths }],
      cbm: UNAVAILABLE,
    });
    expect(set.candidates).toHaveLength(MANIFEST_MAX_CANDIDATES);
    expect(set.truncated).toBe(true);
    expect(set.omitted).toBe(300 - MANIFEST_MAX_CANDIDATES);
    expect(set.unknownScope).toBe(true);
  });

  it('prefers diff evidence over CBM-only paths and marks paths found by both', () => {
    const set = buildManifestCandidates({
      cutoff: CUTOFF,
      neighbours: [{ taskId: 't', score: 0.3, completedAt: BEFORE, paths: ['d.ts', 'both.ts'] }],
      cbm: { status: 'ok', revision: 'abc123', paths: ['cbm-only.ts', 'both.ts'], complete: true },
    });
    expect(set.candidates).toEqual(['both.ts', 'd.ts', 'cbm-only.ts']);
    expect(set.sources).toEqual(['diff+cbm', 'diff', 'cbm']);
    expect(set.coverage.source).toBe('neighbour_diff_and_cbm');
    expect(set.coverage.revision).toBe('abc123');
    expect(set.coverage.revisionPinned).toBe(true);
    expect(set.unknownScope).toBe(false);
  });

  it('an incomplete CBM answer still leaves scope unknown', () => {
    const set = buildManifestCandidates({
      cutoff: CUTOFF,
      neighbours: [],
      cbm: { status: 'ok', revision: 'abc', paths: ['x.ts'], complete: false },
    });
    expect(set.unknownScope).toBe(true);
  });

  it('no neighbours and no CBM is an empty, unknown-scope set', () => {
    const set = buildManifestCandidates({ cutoff: CUTOFF, neighbours: [], cbm: UNAVAILABLE });
    expect(set.candidates).toEqual([]);
    expect(set.unknownScope).toBe(true);
  });

  it('is deterministic regardless of neighbour order', () => {
    const n = [
      { taskId: 'a', score: 0.5, completedAt: BEFORE, paths: ['x.ts', 'y.ts'] },
      { taskId: 'b', score: 0.5, completedAt: BEFORE, paths: ['z.ts', 'x.ts'] },
    ];
    const one = buildManifestCandidates({ cutoff: CUTOFF, neighbours: n, cbm: UNAVAILABLE });
    const two = buildManifestCandidates({ cutoff: CUTOFF, neighbours: [...n].reverse(), cbm: UNAVAILABLE });
    expect(one.candidates).toEqual(two.candidates);
  });
});

describe('buildPickDecision', () => {
  it('maps opaque labels to files, adds DONE and fingerprints the dynamic definition', () => {
    const a = buildPickDecision(['a.ts', 'b.ts']);
    expect(a.labelMap).toEqual({ c0: 'a.ts', c1: 'b.ts' });
    const criteria = (a.decision.questions.pick as any).criteria;
    expect(Object.keys(criteria)).toEqual(['c0', 'c1', DONE_LABEL]);
    expect(a.decision.policyOf('pick').mode).toBe('shadow');
    const b = buildPickDecision(['a.ts']);
    expect(b.decision.fingerprint).not.toBe(a.decision.fingerprint);
    expect(buildPickDecision(['a.ts', 'b.ts']).decision.fingerprint).toBe(a.decision.fingerprint);
  });

  it('accepts exactly 254 candidates and refuses 255 or none before any call', () => {
    const files = Array.from({ length: MANIFEST_MAX_CANDIDATES }, (_, i) => `f${i}.ts`);
    expect(Object.keys((buildPickDecision(files).decision.questions.pick as any).criteria)).toHaveLength(MAX_CHOICE_OPTIONS);
    expect(() => buildPickDecision([...files, 'one-more.ts'])).toThrow();
    expect(() => buildPickDecision([])).toThrow();
  });

  it('labels are short opaque tokens the content-free ledger stores verbatim', () => {
    expect(candidateLabel(253)).toBe('c253');
  });
});

describe('resolvePickCap', () => {
  it('defaults, clamps and rejects junk', () => {
    expect(resolvePickCap(undefined)).toBe(DEFAULT_MANIFEST_PICK_CAP);
    expect(resolvePickCap(3)).toBe(3);
    expect(resolvePickCap(0)).toBe(DEFAULT_MANIFEST_PICK_CAP);
    expect(resolvePickCap(-1)).toBe(DEFAULT_MANIFEST_PICK_CAP);
    expect(resolvePickCap(2.5)).toBe(DEFAULT_MANIFEST_PICK_CAP);
    expect(resolvePickCap(10_000)).toBe(MAX_MANIFEST_PICK_CAP);
  });
});

describe('runRepeatedManifestChoice', () => {
  const now = () => 1_000;

  it('selects multiple files, removing each between picks, and stops at DONE', async () => {
    const { run, calls } = scriptedRunner(['b.ts', 'c.ts']);
    const r = await runRepeatedManifestChoice({ candidates: ['a.ts', 'b.ts', 'c.ts'], pickCap: 5, deadlineAt: 9_999, now, runPick: run });
    expect(r.selected).toEqual(['b.ts', 'c.ts']);
    expect(r.stop).toBe('done');
    expect(r.complete).toBe(true);
    expect(calls).toHaveLength(3);
    expect(Object.values(calls[1].labelMap)).toEqual(['a.ts', 'c.ts']);
    expect(Object.values(calls[2].labelMap)).toEqual(['a.ts']);
    expect(calls.map(c => c.step)).toEqual([0, 1, 2]);
    // Every pick shares one overall deadline and the deterministic rule is DONE.
    expect(new Set(calls.map(c => c.deadlineAt))).toEqual(new Set([9_999]));
    expect(calls.every(c => c.ruleVerdict === DONE_LABEL)).toBe(true);
    // Each dynamic definition is recorded with its own fingerprint and map.
    expect(r.picks.map(p => p.offered)).toEqual([[0, 1, 2], [0, 2], [0]]);
    expect(new Set(r.picks.map(p => p.fingerprint)).size).toBe(3);
    expect(r.picks[0].path).toBe('b.ts');
    expect(r.picks[2].suggested).toBe(DONE_LABEL);
  });

  it('stops at the pick cap and marks truncation', async () => {
    const { run, calls } = scriptedRunner(['a.ts', 'b.ts', 'c.ts']);
    const r = await runRepeatedManifestChoice({ candidates: ['a.ts', 'b.ts', 'c.ts'], pickCap: 2, deadlineAt: 9_999, now, runPick: run });
    expect(calls).toHaveLength(2);
    expect(r.selected).toEqual(['a.ts', 'b.ts']);
    expect(r.stop).toBe('pick_cap');
    expect(r.complete).toBe(false);
  });

  it('exhausting the candidates ends the loop without a DONE call', async () => {
    const { run, calls } = scriptedRunner(['a.ts']);
    const r = await runRepeatedManifestChoice({ candidates: ['a.ts'], pickCap: 5, deadlineAt: 9_999, now, runPick: run });
    expect(calls).toHaveLength(1);
    expect(r.stop).toBe('exhausted');
    expect(r.complete).toBe(true);
  });

  it('empty candidates make no call', async () => {
    const { run, calls } = scriptedRunner([]);
    const r = await runRepeatedManifestChoice({ candidates: [], pickCap: 5, deadlineAt: 9_999, now, runPick: run });
    expect(calls).toHaveLength(0);
    expect(r.stop).toBe('no_candidates');
    expect(r.complete).toBe(false);
  });

  it('refuses an overflowing candidate list before calling', async () => {
    const { run, calls } = scriptedRunner([]);
    const files = Array.from({ length: MANIFEST_MAX_CANDIDATES + 1 }, (_, i) => `f${i}.ts`);
    const r = await runRepeatedManifestChoice({ candidates: files, pickCap: 5, deadlineAt: 9_999, now, runPick: run });
    expect(calls).toHaveLength(0);
    expect(r.stop).toBe('invalid');
  });

  it('a spent shared deadline stops before the next pick', async () => {
    let t = 0;
    const clock = () => t;
    const run: PickRunner = async (args) => {
      t = 10_000; // the first pick used the whole budget
      return outcome({ suggested: Object.keys(args.labelMap)[0] });
    };
    const r = await runRepeatedManifestChoice({ candidates: ['a.ts', 'b.ts'], pickCap: 5, deadlineAt: 5_000, now: clock, runPick: run });
    expect(r.selected).toEqual(['a.ts']);
    expect(r.stop).toBe('deadline');
    expect(r.complete).toBe(false);
  });

  it('a fallback pick (deadline or error) truncates; nothing fabricated', async () => {
    const run: PickRunner = async () => outcome({ status: 'fallback', reason: 'deadline', suggested: null });
    const r = await runRepeatedManifestChoice({ candidates: ['a.ts'], pickCap: 5, deadlineAt: 9_999, now, runPick: run });
    expect(r.selected).toEqual([]);
    expect(r.stop).toBe('deadline');
    const run2: PickRunner = async () => outcome({ status: 'fallback', reason: 'missing_key', suggested: null });
    const r2 = await runRepeatedManifestChoice({ candidates: ['a.ts'], pickCap: 5, deadlineAt: 9_999, now, runPick: run2 });
    expect(r2.stop).toBe('fallback');
    expect(r2.complete).toBe(false);
  });

  it('a throwing runner falls back deterministically', async () => {
    const run: PickRunner = async () => { throw new Error('boom'); };
    const r = await runRepeatedManifestChoice({ candidates: ['a.ts'], pickCap: 5, deadlineAt: 9_999, now, runPick: run });
    expect(r.stop).toBe('fallback');
    expect(r.selected).toEqual([]);
  });

  it('an answer outside the offered map is rejected by isValidAnswer', async () => {
    const { run, calls } = scriptedRunner([]);
    await runRepeatedManifestChoice({ candidates: ['a.ts', 'b.ts'], pickCap: 5, deadlineAt: 9_999, now, runPick: run });
    expect(calls[0].isValidAnswer('c0')).toBe(true);
    expect(calls[0].isValidAnswer(DONE_LABEL)).toBe(true);
    expect(calls[0].isValidAnswer('c9')).toBe(false);
  });

  it('records whether every pick applied', async () => {
    const { run } = scriptedRunner(['a.ts'], { status: 'applied', applied: true, reason: null });
    const r = await runRepeatedManifestChoice({ candidates: ['a.ts', 'b.ts'], pickCap: 5, deadlineAt: 9_999, now, runPick: run });
    expect(r.allApplied).toBe(true);
    const { run: shadow } = scriptedRunner(['a.ts']);
    const s = await runRepeatedManifestChoice({ candidates: ['a.ts', 'b.ts'], pickCap: 5, deadlineAt: 9_999, now, runPick: shadow });
    expect(s.allApplied).toBe(false);
  });
});

function record(over: Partial<ManifestPredictionRecord> = {}): ManifestPredictionRecord {
  return {
    candidates: ['a.ts', 'b.ts', 'c.ts'],
    selected: ['a.ts'],
    picks: [
      { step: 0, fingerprint: 'f0', decisionVersion: 'v', offered: [0, 1, 2], suggested: 'c0', path: 'a.ts', confidence: 0.95, status: 'applied', reason: null, applied: true },
      { step: 1, fingerprint: 'f1', decisionVersion: 'v', offered: [1, 2], suggested: DONE_LABEL, path: null, confidence: 0.95, status: 'applied', reason: null, applied: true },
    ],
    stop: 'done',
    complete: true,
    unknownScope: false,
    allApplied: true,
    decisionId: 'buildd.orchestration_manifest_pick',
    candidatePolicyVersion: 'mc1',
    ...over,
  };
}

describe('prepareGatedManifest', () => {
  const inject = (m: string[]) => (m.some(p => p.startsWith('packages/core/drizzle/')) ? ['packages/core/drizzle/meta/_journal.json'] : []);

  it('is disabled by default', () => {
    const r = prepareGatedManifest({ prediction: record(), callerManifest: null, eligibleMissingScope: true, minConfidence: 0.9, injectAnchors: inject });
    expect(r).toEqual({ apply: false, reason: 'disabled' });
  });

  it('explicit caller manifests always win', () => {
    const r = prepareGatedManifest({ enabled: true, prediction: record(), callerManifest: ['x.ts'], eligibleMissingScope: true, minConfidence: 0.9, injectAnchors: inject });
    expect(r).toEqual({ apply: false, reason: 'caller_declared' });
  });

  it('refuses unknown scope, incomplete, unapplied, unmeasured and below-threshold results', () => {
    const base = { enabled: true, callerManifest: null, eligibleMissingScope: true, minConfidence: 0.9, injectAnchors: inject };
    expect(prepareGatedManifest({ ...base, prediction: record({ unknownScope: true }) })).toEqual({ apply: false, reason: 'unknown_scope' });
    expect(prepareGatedManifest({ ...base, prediction: record({ complete: false, stop: 'pick_cap' }) })).toEqual({ apply: false, reason: 'incomplete' });
    expect(prepareGatedManifest({ ...base, prediction: record({ allApplied: false }) })).toEqual({ apply: false, reason: 'not_applied' });
    expect(prepareGatedManifest({ ...base, minConfidence: null, prediction: record() })).toEqual({ apply: false, reason: 'unmeasured' });
    expect(prepareGatedManifest({ ...base, minConfidence: 0.99, prediction: record() })).toEqual({ apply: false, reason: 'below_threshold' });
    expect(prepareGatedManifest({ ...base, eligibleMissingScope: false, prediction: record() })).toEqual({ apply: false, reason: 'not_eligible' });
    expect(prepareGatedManifest({ ...base, prediction: record({ selected: [] }) })).toEqual({ apply: false, reason: 'empty' });
    expect(prepareGatedManifest({ ...base, prediction: null })).toEqual({ apply: false, reason: 'no_prediction' });
  });

  it('a complete eligible result yields a concrete manifest with anchors and provenance, never the wildcard', () => {
    const r = prepareGatedManifest({
      enabled: true,
      prediction: record({ selected: ['packages/core/drizzle/0001_x.sql'] }),
      callerManifest: ['**'],
      eligibleMissingScope: true,
      minConfidence: 0.9,
      injectAnchors: inject,
    });
    expect(r.apply).toBe(true);
    if (!r.apply) return;
    expect(r.manifest).toEqual(['packages/core/drizzle/0001_x.sql', 'packages/core/drizzle/meta/_journal.json']);
    expect(r.manifest).not.toContain('**');
    expect(r.provenance).toEqual({ source: 'orchestration_manifest', decisionId: 'buildd.orchestration_manifest_pick', candidatePolicyVersion: 'mc1', fingerprints: ['f0', 'f1'] });
    expect(r.originalUnknownScope).toBe(true);
  });
});

describe('scoreManifestSet', () => {
  it('computes precision, recall, omitted rate and candidate recall separately', () => {
    const s = scoreManifestSet({ selected: ['a.ts', 'x.ts'], candidates: ['a.ts', 'b.ts', 'x.ts'], actual: ['a.ts', 'b.ts', 'new.ts'] });
    expect(s.precision).toBeCloseTo(0.5);
    expect(s.recall).toBeCloseTo(1 / 3);
    expect(s.omittedPathRate).toBeCloseTo(2 / 3);
    expect(s.candidateRecall).toBeCloseTo(2 / 3);
    expect(s.candidateMisses).toEqual(['new.ts']);
  });

  it('a perfect pick score cannot hide missing candidates', () => {
    const s = scoreManifestSet({ selected: ['a.ts'], candidates: ['a.ts'], actual: ['a.ts', 'b.ts'] });
    expect(s.precision).toBe(1);
    expect(s.candidateRecall).toBe(0.5);
    expect(s.candidateMisses).toEqual(['b.ts']);
  });

  it('empty sets give null rates rather than fake perfection', () => {
    const s = scoreManifestSet({ selected: [], candidates: [], actual: [] });
    expect(s.precision).toBeNull();
    expect(s.recall).toBeNull();
    expect(s.candidateRecall).toBeNull();
  });
});

describe('buildPickEvalRows', () => {
  it('teacher-forces a deterministic truth order (candidate rank) and ends with DONE', () => {
    const rows = buildPickEvalRows({ id: 't1', candidates: ['a.ts', 'b.ts', 'c.ts'], actual: ['c.ts', 'a.ts', 'zz.ts'], pickCap: 8 });
    expect(rows.map(r => r.truthPath)).toEqual(['a.ts', 'c.ts', null]);
    expect(rows[0].offered).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(rows[0].truth).toBe('c0');
    expect(rows[1].offered).toEqual(['b.ts', 'c.ts']);
    expect(rows[1].truth).toBe('c1');
    expect(rows[2].truth).toBe(DONE_LABEL);
    expect(rows.map(r => r.id)).toEqual(['t1:0', 't1:1', 't1:2']);
  });

  it('respects the pick cap and offers nothing when no candidates exist', () => {
    expect(buildPickEvalRows({ id: 't', candidates: ['a.ts', 'b.ts'], actual: ['a.ts', 'b.ts'], pickCap: 1 })).toHaveLength(1);
    expect(buildPickEvalRows({ id: 't', candidates: [], actual: ['a.ts'], pickCap: 8 })).toEqual([]);
  });
});

describe('evaluateManifestPicks', () => {
  it('runs runDecisionEval per labelled pick (each with its own definition) and pools the summary', async () => {
    const rows = buildPickEvalRows({ id: 't1', candidates: ['a.ts', 'b.ts'], actual: ['b.ts'], pickCap: 8 });
    // A fake fetch-free decide: answer the first offered label every time.
    const report = await evaluateManifestPicks({
      rows,
      stateOf: (row) => ({ selected: row.selectedBefore }),
      run: {
        apiKey: 'k',
        sleep: () => Promise.resolve(),
        fetch: (async () => new Response(JSON.stringify({
          model: 'typesafe/jev-1.13-20260917',
          answers: { pick: { type: 'choice', choice: 'c0', probabilities: {}, confidence: 0.9 } },
          usage: { input_tokens: 1, output_tokens: 1, cost: 0 },
        }), { status: 200, headers: { 'content-type': 'application/json' } })) as any,
      } as any,
    });
    expect(report.summary.n).toBe(2);
    expect(report.predictions.map(p => p.truth)).toEqual(['c1', DONE_LABEL]);
    expect(report.predictions.map(p => p.pred)).toEqual(['c0', 'c0']);
    expect(report.summary.accuracy.correct).toBe(0);
    expect(report.fingerprints).toHaveLength(2);
  });
});

describe('labelManifestPrediction', () => {
  it('labels against actual touched files, records candidate misses and baselines on the same task', () => {
    const l = labelManifestPrediction({
      prediction: { ...record(), regexPaths: ['b.ts'], neighbourUnionPaths: ['a.ts', 'b.ts', 'c.ts'] },
      touched: [{ paths: ['a.ts', 'new.ts'], landed: true, failed: false }],
    });
    expect(l.status).toBe('observed');
    if (l.status !== 'observed') return;
    expect(l.actual).toEqual(['a.ts', 'new.ts']);
    expect(l.landed).toBe(true);
    expect(l.model.candidateMisses).toEqual(['new.ts']);
    expect(l.model.precision).toBe(1);
    expect(l.baselines.regex.precision).toBe(0);
    expect(l.baselines.neighbourUnion.recall).toBe(0.5);
    expect(l.unknownScope).toBe(false);
  });

  it('no terminal observation is missing, not an empty truth', () => {
    const l = labelManifestPrediction({ prediction: { ...record(), regexPaths: [], neighbourUnionPaths: [] }, touched: [] });
    expect(l.status).toBe('missing');
  });
});
