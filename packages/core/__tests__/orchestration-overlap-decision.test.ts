import { describe, it, expect } from 'bun:test';
import {
  OVERLAP_REAL_DECISION,
  OVERLAP_REAL_LABELS,
  OVERLAP_REAL_MAX_PAIRS_PER_TASK,
  OVERLAP_REAL_MIN_CONFIDENCE,
  buildOverlapState,
  findSoftOverlapPairs,
  overlapStateDigest,
  type OverlapTaskScope,
} from '../orchestration-overlap-decision';

/**
 * The overlap-real decision (jev-scheduling §5), pure half: pair selection
 * (which soft pairs may be asked about at all) and the content-free state
 * builders. The decision definition's own gating (gated mode, threshold,
 * fallback ladder) is exercised generically by orchestration-decision.test.ts.
 */

const scope = (over: Partial<OverlapTaskScope> = {}): OverlapTaskScope => ({
  taskId: 't-a',
  title: 'Task A',
  description: 'does something',
  declaredScope: null,
  predictedScope: null,
  setConfidence: null,
  ...over,
});

describe('findSoftOverlapPairs', () => {
  it('pairs the new (predicted) task with another predicted task that overlaps', () => {
    const newTask = scope({ taskId: 'new', predictedScope: ['apps/web/src/a.ts', 'apps/web/src/b.ts'], setConfidence: 0.9 });
    const other = scope({ taskId: 'other', predictedScope: ['apps/web/src/a.ts'], setConfidence: 0.8 });
    const pairs = findSoftOverlapPairs(newTask, [other]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].a.taskId).toBe('new');
    expect(pairs[0].b.taskId).toBe('other');
    expect(pairs[0].overlap).toBeGreaterThan(0);
  });

  it('pairs a predicted new task with a DECLARED sibling (at least one side predicted is enough)', () => {
    const newTask = scope({ taskId: 'new', predictedScope: ['apps/web/src/a.ts'], setConfidence: 0.9 });
    const other = scope({ taskId: 'other', declaredScope: ['apps/web/src/a.ts'] });
    const pairs = findSoftOverlapPairs(newTask, [other]);
    expect(pairs).toHaveLength(1);
  });

  it('never pairs the new task with itself', () => {
    const newTask = scope({ taskId: 'new', predictedScope: ['x.ts'], setConfidence: 0.9 });
    const pairs = findSoftOverlapPairs(newTask, [scope({ taskId: 'new', predictedScope: ['x.ts'], setConfidence: 0.9 })]);
    expect(pairs).toHaveLength(0);
  });

  it('dedupes a candidate list that names the same task id twice', () => {
    const newTask = scope({ taskId: 'new', predictedScope: ['x.ts'], setConfidence: 0.9 });
    const other = scope({ taskId: 'other', predictedScope: ['x.ts'], setConfidence: 0.9 });
    const pairs = findSoftOverlapPairs(newTask, [other, { ...other }]);
    expect(pairs).toHaveLength(1);
  });

  it('no usable scope on the new task ⇒ no pairs', () => {
    const newTask = scope({ taskId: 'new' });
    const other = scope({ taskId: 'other', declaredScope: ['x.ts'] });
    expect(findSoftOverlapPairs(newTask, [other])).toHaveLength(0);
  });

  it('two DECLARED sides never form a soft pair (that is hard-edge territory, not this decision)', () => {
    const newTask = scope({ taskId: 'new', declaredScope: ['x.ts'] });
    const other = scope({ taskId: 'other', declaredScope: ['x.ts'] });
    expect(findSoftOverlapPairs(newTask, [other])).toHaveLength(0);
  });

  it('no file overlap ⇒ not a pair, even with both predicted', () => {
    const newTask = scope({ taskId: 'new', predictedScope: ['a.ts'], setConfidence: 0.9 });
    const other = scope({ taskId: 'other', predictedScope: ['b.ts'], setConfidence: 0.9 });
    expect(findSoftOverlapPairs(newTask, [other])).toHaveLength(0);
  });

  it('a predicted scope below thetaOrder is not usable, so the pair is dropped', () => {
    const newTask = scope({ taskId: 'new', predictedScope: ['a.ts'], setConfidence: 0.2 });
    const other = scope({ taskId: 'other', declaredScope: ['a.ts'] });
    expect(findSoftOverlapPairs(newTask, [other], { thetaOrder: 0.5 })).toHaveLength(0);
    expect(findSoftOverlapPairs(newTask, [other], { thetaOrder: 0 })).toHaveLength(1);
  });

  it('bounds to `max`, highest overlap first', () => {
    const newTask = scope({ taskId: 'new', predictedScope: ['a.ts', 'b.ts', 'c.ts', 'd.ts'], setConfidence: 0.9 });
    const others = [
      scope({ taskId: 'quarter', declaredScope: ['a.ts', 'p.ts', 'q.ts', 'r.ts', 's.ts'] }), // self's 4 is smaller: 1/4
      scope({ taskId: 'full', declaredScope: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'] }), // 4/4
      scope({ taskId: 'half', declaredScope: ['a.ts', 'b.ts', 'x.ts', 'y.ts', 'z.ts'] }), // 2/4
    ];
    const pairs = findSoftOverlapPairs(newTask, others, { max: 2 });
    expect(pairs.map(p => p.b.taskId)).toEqual(['full', 'half']);
  });

  it('respects the default max (OVERLAP_REAL_MAX_PAIRS_PER_TASK)', () => {
    const newTask = scope({ taskId: 'new', predictedScope: ['a.ts'], setConfidence: 0.9 });
    const others = Array.from({ length: OVERLAP_REAL_MAX_PAIRS_PER_TASK + 5 }, (_, i) => scope({ taskId: `t${i}`, declaredScope: ['a.ts'] }));
    expect(findSoftOverlapPairs(newTask, others)).toHaveLength(OVERLAP_REAL_MAX_PAIRS_PER_TASK);
  });
});

describe('buildOverlapState / overlapStateDigest', () => {
  const a = scope({ taskId: 'a', title: 'Fix the claim route', description: 'touches apps/web/src/app/api/workers/claim/route.ts', predictedScope: ['x.ts'], setConfidence: 0.9 });
  const b = scope({ taskId: 'b', title: 'Add a retry', declaredScope: ['x.ts'] });

  it('the state carries both sides, content-free beyond each task\'s own declared/predicted scope', () => {
    const state = buildOverlapState({ a, b, overlap: 1 }) as any;
    expect(state.taskA.scope).toEqual(['x.ts']);
    expect(state.taskA.scopeKind).toBe('predicted');
    expect(state.taskB.scope).toEqual(['x.ts']);
    expect(state.taskB.scopeKind).toBe('declared');
    expect(state.rule.verdict).toBe('REAL');
  });

  it('the digest is order-independent (so asking a↔b always re-uses the same recent-ask key)', () => {
    expect(overlapStateDigest({ a, b, overlap: 1 })).toBe(overlapStateDigest({ a: b, b: a, overlap: 1 }));
  });

  it('the digest changes when either side\'s scope changes', () => {
    const changed = { ...b, declaredScope: ['y.ts'] };
    expect(overlapStateDigest({ a, b, overlap: 1 })).not.toBe(overlapStateDigest({ a, b: changed, overlap: 1 }));
  });
});

describe('OVERLAP_REAL_DECISION', () => {
  it('is gated with a starting threshold, never shadow (applies from the first PR; see module header)', () => {
    const policy = OVERLAP_REAL_DECISION.policyOf('overlap');
    expect(policy.mode).toBe('gated');
    expect(policy.minConfidence).toBe(OVERLAP_REAL_MIN_CONFIDENCE);
  });

  it('labels are exactly REAL / NOT_REAL', () => {
    expect(OVERLAP_REAL_LABELS).toEqual(['REAL', 'NOT_REAL']);
  });
});
