/**
 * Acceptance tests for spec "Staged self-review before complete_task
 * (intent-only, measured)" revision 1: the shared half (mode switch, experiment
 * kind and arm draw, kill criterion, rubber-stamp readout, off = no footprint).
 * Written before the build; every test fails until the build lands.
 *
 * Contract (module `packages/core/staged-self-review.ts`):
 *  - STAGED_SELF_REVIEW_FEATURE = 'staged_self_review'
 *  - resolveStagedReviewMode(row|null|undefined) -> 'off'|'recording'|'acting'
 *  - assignStagedReviewArm({ taskId, experiment }) -> assignment with propensity
 *  - classifyStagedReview(rows) -> { touchRate, flipRate, contradictionRate, rubberStamped }
 *  - evaluateKillCriterion({ readout, criterion, measuredAddedCost }) -> { kill, reasons }
 *  - stagedReviewFootprint(mode, ...) : nothing is created while off.
 *
 * Run: bun run scripts/run-unit-tests.ts packages/core/__tests__/staged-self-review.test.ts
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { stagedReviewRecordsFromMilestones, stagedReviewRecordsFromWorkers, classifyStagedReview, stagedReviewLabel } from '../staged-draw';

const load = () => import('../staged-draw');

describe('R-4: off by default, with a recording mode', () => {
  test('R-4: no stored row means off; recording and acting are recognised', async () => {
    const m = await load();
    expect(m.STAGED_SELF_REVIEW_FEATURE).toBe('staged_self_review');
    expect(m.resolveStagedReviewMode(null)).toBe('off');
    expect(m.resolveStagedReviewMode(undefined)).toBe('off');
    expect(m.resolveStagedReviewMode({ mode: 'recording' } as any)).toBe('recording');
  });

  test('R-4: acting pinned to the checklist version falls back to recording when the version changes', async () => {
    const m = await load();
    const row = { mode: 'acting', checklistVersion: 'v1' } as any;
    expect(m.resolveStagedReviewMode(row, { checklistVersion: 'v1' })).toBe('acting');
    expect(m.resolveStagedReviewMode(row, { checklistVersion: 'v2' })).toBe('recording');
  });
});

describe('R-5 / AC-6: acting applies only to the treatment arm of its own experiment kind', () => {
  test('R-5: staged_self_review is a registered experiment kind', async () => {
    const src = readFileSync(new URL('../../../apps/web/src/lib/experiments.ts', import.meta.url), 'utf8');
    const types = readFileSync(new URL('../../shared/src/types.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/EXPERIMENT_KINDS[^\n]*'staged_self_review'/);
    expect(types).toMatch(/type ExperimentKind[^;]*'staged_self_review'/);
  });

  test('R-5: arm is drawn per task with the existing randomiser and propensity is recorded', async () => {
    const m = await load();
    const experiment = { id: 'exp-1', policyVersion: 'p1', treatmentFraction: 0.5 };
    const a = m.assignStagedReviewArm({ taskId: 'task-a', experiment } as any);
    expect(['control', 'treatment']).toContain(a.arm);
    expect(a.propensity).toBeGreaterThan(0);
    expect(a.propensity).toBeLessThanOrEqual(1);
    expect(m.assignStagedReviewArm({ taskId: 'task-a', experiment } as any)).toEqual(a);
    const arms = new Set(Array.from({ length: 60 }, (_, i) => m.assignStagedReviewArm({ taskId: `t${i}`, experiment } as any).arm));
    expect(arms.size).toBe(2);
  });

  test('R-5: recording and off modes never yield a treatment draw that acts', async () => {
    const m = await load();
    expect(m.effectiveStagedArm({ mode: 'recording', arm: 'treatment' })).toBe('control');
    expect(m.effectiveStagedArm({ mode: 'acting', arm: 'treatment' })).toBe('treatment');
  });
});

describe('R-7 / AC-8: rubber-stamping is measurable and reported', () => {
  const stamped = (n: number) => Array.from({ length: n }, (_, i) => ({
    taskId: `t${i}`, toolCallsBetween: [], changedAfterDenial: false, answers: ['met', 'met'],
    evidenceEchoesSummary: true, laterIntentFinding: false,
  }));

  test('AC-8: no tool calls and no change gives high touch rate, ~zero flip rate, rubberStamped', async () => {
    const m = await load();
    const r = m.classifyStagedReview(stamped(20) as any);
    expect(r.touchRate).toBeGreaterThanOrEqual(0.9);
    expect(r.flipRate).toBeLessThanOrEqual(0.05);
    expect(r.rubberStamped).toBe(true);
  });

  test('R-7: a stage whose agents act on it is not labelled rubber-stamped', async () => {
    const m = await load();
    const rows = stamped(20).map((r, i) => i % 2 ? { ...r, toolCallsBetween: ['Read', 'Edit'], changedAfterDenial: true, answers: ['unmet', 'met'] } : r);
    const r = m.classifyStagedReview(rows as any);
    expect(r.rubberStamped).toBe(false);
    expect(r.flipRate).toBeGreaterThan(0.3);
  });

  test('R-7: contradiction rate counts met answers later contradicted by a reviewer finding', async () => {
    const m = await load();
    const rows = stamped(10).map((r, i) => ({ ...r, laterIntentFinding: i < 4 }));
    expect(m.classifyStagedReview(rows as any).contradictionRate).toBeCloseTo(0.4, 5);
  });
});

describe('R-8: pre-registered kill criterion', () => {
  const criterion = { minSample: 30, maxAddedCostPerTask: 5000, rubberStampTouchRate: 0.8, rubberStampFlipRate: 0.05 };

  test('R-8: an experiment without a stored kill criterion cannot start', async () => {
    const m = await load();
    expect(m.validateStagedExperimentConfig({}).ok).toBe(false);
    expect(m.validateStagedExperimentConfig({ killCriterion: criterion }).ok).toBe(true);
  });

  test('R-8: meeting any limb means kill (switch off), never "tune the checklist"', async () => {
    const m = await load();
    const base = { readout: { verdict: 'treatment_better', touchRate: 0.1, flipRate: 0.5 }, criterion, measuredAddedCost: 100 };
    expect(m.evaluateKillCriterion(base as any).kill).toBe(false);
    expect(m.evaluateKillCriterion({ ...base, readout: { ...base.readout, verdict: 'no_detectable_difference' } } as any).kill).toBe(true);
    expect(m.evaluateKillCriterion({ ...base, readout: { ...base.readout, touchRate: 0.95, flipRate: 0.01 } } as any).kill).toBe(true);
    expect(m.evaluateKillCriterion({ ...base, measuredAddedCost: 9000 } as any).kill).toBe(true);
    const k = m.evaluateKillCriterion({ ...base, measuredAddedCost: 9000 } as any);
    expect(k.action).toBe('switch_off');
    expect(k.reasons.length).toBeGreaterThan(0);
  });
});

describe('AC-9: off leaves no footprint', () => {
  test('AC-9: off creates no hook state, no log row and no arm draw', async () => {
    const m = await load();
    const calls: string[] = [];
    const out = m.stagedReviewFootprint('off', {
      draw: () => { calls.push('draw'); return { arm: 'treatment' }; },
      record: () => calls.push('record'),
      initState: () => calls.push('state'),
    } as any);
    expect(calls).toEqual([]);
    expect(out).toBeNull();
  });
});

describe('stagedReviewRecordsFromMilestones', () => {
  const label = (o: object) => ({ type: 'status', label: `Self-review: ${JSON.stringify(o)}` });
  test('turns stored answered records into a rubber-stamp readout and counts truncated labels', () => {
    const { records, skipped } = stagedReviewRecordsFromMilestones([
      { taskId: 't1', milestones: [label({ outcome: 'denied' }), label({ outcome: 'answered', answers: [{ id: 'a', answer: 'met' }], toolCallsBetween: [], workChangedAfterDenial: false })] },
      { taskId: 't2', milestones: [{ type: 'status', label: 'Self-review: {"outcome":"answ' }, { label: 'other' }] },
    ]);
    expect(records).toHaveLength(1);
    expect(skipped).toBe(1);
    expect(classifyStagedReview(records).rubberStamped).toBe(true);
  });
  test('labels without the prefix are not counted', () => {
    const { records, skipped } = stagedReviewRecordsFromMilestones([{ milestones: [{ label: 'other' }, { label: 'Self-review' }, { label: 5 }, null] as any }]);
    expect(records).toHaveLength(0);
    expect(skipped).toBe(0);
  });
  test('reads edits as a flip', () => {
    const { records } = stagedReviewRecordsFromMilestones([{ milestones: [label({ outcome: 'answered', answers: [{ answer: 'unmet' }], toolCallsBetween: ['Edit'], workChangedAfterDenial: true })] }]);
    expect(classifyStagedReview(records).flipRate).toBe(1);
  });
});

describe('stagedReviewLabel (one readout for /readout and /staged-readout)', () => {
  const label = (o: object) => ({ type: 'status', label: `Self-review: ${JSON.stringify(o)}` });
  const answered = (o: object) => label({ outcome: 'answered', ...o });
  const stamped = { answers: [{ id: 'a', answer: 'met' }], toolCallsBetween: [], workChangedAfterDenial: false };
  const milestones = (n: number) => Array.from({ length: n }, (_, i) => ({ taskId: `t${i}`, milestones: [answered(stamped)] }));

  test('an empty cohort is no_records, never a stamp', () => {
    expect(stagedReviewLabel(classifyStagedReview([]))).toBe('no_records');
  });
  test('untouched, unchanged, all-met answers are rubber_stamped', () => {
    const { records } = stagedReviewRecordsFromMilestones(milestones(10));
    expect(stagedReviewLabel(classifyStagedReview(records))).toBe('rubber_stamped');
  });
  test('answers that touch and flip the work are not_rubber_stamped', () => {
    const { records } = stagedReviewRecordsFromMilestones([{ taskId: 'x', milestones: [answered({ answers: [{ answer: 'unmet' }], toolCallsBetween: ['Edit'], workChangedAfterDenial: true })] }]);
    expect(stagedReviewLabel(classifyStagedReview(records))).toBe('not_rubber_stamped');
  });
  test('a truncated label is skipped, not counted as a record', () => {
    const { records, skipped } = stagedReviewRecordsFromMilestones([{ taskId: 'x', milestones: [{ label: 'Self-review: {"outcome":"answered","answers":[{"id"' }] }]);
    expect(records).toHaveLength(0);
    expect(skipped).toBe(1);
    expect(stagedReviewLabel(classifyStagedReview(records))).toBe('no_records');
  });
});
describe('stagedReviewRecordsFromWorkers (AC-8)', () => {
  test('reads resultMeta.stagedSelfReview with only short milestone labels -> rubberStamped', () => {
    const meta = (o: object) => ({ stagedSelfReview: [{ outcome: 'denied', ts: 1 }, { ...o, ts: 2 }] });
    const rows = Array.from({ length: 3 }, (_, i) => ({
      taskId: `t${i}`,
      milestones: [{ type: 'status', label: 'Self-review: answered (treatment, acting)' }],
      resultMeta: meta({ outcome: 'answered', answers: [{ id: 'a', answer: 'met' }], toolCallsBetween: [], workChangedAfterDenial: false }),
    }));
    const { records, skipped } = stagedReviewRecordsFromWorkers(rows);
    expect(records).toHaveLength(3);
    expect(skipped).toBe(0);
    expect(classifyStagedReview(records).rubberStamped).toBe(true);
  });
  test('falls back to legacy JSON milestones when resultMeta has no records', () => {
    const { records } = stagedReviewRecordsFromWorkers([{ resultMeta: null, milestones: [{ label: 'Self-review: {"outcome":"answered","answers":[{"answer":"met"}]}' }] }]);
    expect(records).toHaveLength(1);
  });
});

describe('realistic multi-answer record (R-6)', () => {
  const long = {
    mode: 'acting', arm: 'treatment', outcome: 'answered', propensity: 0.5, checklistVersion: 'v1',
    itemIds: ['i1', 'i2', 'i3', 'i4'],
    answers: ['i1', 'i2', 'i3', 'i4'].map(id => ({ id, answer: 'met', evidence: 'x'.repeat(80) })),
    toolCallsBetween: [], workChangedAfterDenial: false, addedTurns: 2, addedTokens: 1200,
  };
  test('record over 300 chars is read from resultMeta, not lost to the milestone cap', () => {
    expect(JSON.stringify(long).length).toBeGreaterThan(300);
    const truncated = { type: 'status', label: `Self-review: ${JSON.stringify(long)}`.slice(0, 300) };
    const { records, skipped } = stagedReviewRecordsFromWorkers([{ taskId: 't', milestones: [truncated], resultMeta: { stagedSelfReview: [long] } }]);
    expect(skipped).toBe(0);
    expect(records).toHaveLength(1);
    expect(classifyStagedReview(records).rubberStamped).toBe(true);
  });
});
