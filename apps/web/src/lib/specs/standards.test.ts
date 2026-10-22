import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { GoalCriterion, LivingSpecGoalCriterion } from '@buildd/shared';

// Living Specs D-43: standards. A fake db answers the snapshot's reads in the
// order it makes them, and records the one write.
let answers: unknown[][] = [];
let executed: string[] = [];
let executeRows: unknown[] = [{ id: 'm1' }];
const chain = (): any => {
  const result = () => Promise.resolve(answers.shift() ?? []);
  const c: any = {};
  for (const k of ['from', 'innerJoin', 'where', 'limit', 'orderBy']) c[k] = () => c;
  c.then = (ok: any, err: any) => result().then(ok, err);
  return c;
};
mock.module('@buildd/core/db', () => ({
  db: {
    select: () => chain(),
    selectDistinct: () => chain(),
    execute: (q: any) => {
      executed.push(JSON.stringify(q?.queryChunks ?? q));
      return Promise.resolve({ rows: executeRows });
    },
  },
}));
let afterRuns: Array<() => unknown> = [];
const realNextServer = await import('next/server');
mock.module('next/server', () => ({ ...realNextServer, after: (fn: () => unknown) => { afterRuns.push(fn); } }));

const { planStandardsSnapshot, snapshotMissionStandards, standardMarkRefusal, scheduleStandardsSnapshots, STANDARD_MARK_REFUSAL } = await import('./standards');
const { standardsHoldOf, standardsLine } = await import('./standards-gate');
const { evaluateGoalCriteria } = await import('@buildd/core/mission-helpers');

const pin = (specId: string, title = specId) => ({ specId, specRevisionId: `${specId}-r1`, revision: 1, contentHash: 'h', title });
const build = (id: string) => ({ id, title: `Build ${id}`, roleSlug: 'builder', context: null, taskClass: 'work', kind: null, mode: 'execution', creationSource: null, category: null });
const verification = (id: string) => ({ ...build(id), title: '[final verification] spec', taskClass: 'bookkeeping', context: { finalVerification: { missionId: 'm1' } } });
const mission = (goalCriteria: unknown = [], status = 'active') => [{ id: 'm1', workspaceId: 'ws1', status, goalCriteria }];

beforeEach(() => {
  answers = [];
  executed = [];
  executeRows = [{ id: 'm1' }];
  afterRuns = [];
});

describe('the standard mark is a person\'s (D-43)', () => {
  it('an owner or admin from their own dashboard session may set or clear it', () => {
    expect(standardMarkRefusal({ callerKind: 'user', ownerOrAdmin: true })).toBeNull();
  });

  it('a member who is not an owner or admin is refused', () => {
    expect(standardMarkRefusal({ callerKind: 'user', ownerOrAdmin: false })).toBe(STANDARD_MARK_REFUSAL);
  });

  it('an agent run, an API key or an OAuth session (an account caller) is refused, whoever holds it', () => {
    expect(standardMarkRefusal({ callerKind: 'account', ownerOrAdmin: true })).toBe(STANDARD_MARK_REFUSAL);
  });

  it('a platform write is refused too', () => {
    expect(standardMarkRefusal({ callerKind: 'system', ownerOrAdmin: true })).toBe(STANDARD_MARK_REFUSAL);
  });
});

describe('planStandardsSnapshot', () => {
  it('adds each standard as a living_spec entry tagged role standard, at its approved revision', () => {
    const r = planStandardsSnapshot([{ type: 'no_open_tasks' }], [pin('voice', 'Product voice')]);
    expect(r.added).toHaveLength(1);
    expect(r.criteria[1]).toEqual({
      type: 'living_spec', specId: 'voice', specRevisionId: 'voice-r1', revision: 1, contentHash: 'h', role: 'standard',
      label: 'Standard "Product voice" revision 1',
    });
  });

  it('never re-snapshots a mission that already carries standards', () => {
    const once = planStandardsSnapshot([], [pin('voice')]).criteria;
    const again = planStandardsSnapshot(once, [pin('voice'), pin('design')]);
    expect(again.added).toEqual([]);
    expect(again.criteria).toEqual(once);
  });

  it('skips a spec the mission selected as its outcome: it is gated as the outcome', () => {
    const outcome: LivingSpecGoalCriterion = { type: 'living_spec', specId: 'voice', specRevisionId: 'x', revision: 3, contentHash: 'h3' };
    const r = planStandardsSnapshot([outcome], [pin('voice'), pin('design')]);
    expect(r.added.map((a) => a.specId)).toEqual(['design']);
  });
});

describe('snapshotMissionStandards: at build start, never retroactive', () => {
  it('snapshots on the first build task\'s first claim', async () => {
    answers = [mission(), [pin('voice')], [build('t1')], [{ n: 1 }]];
    const r = await snapshotMissionStandards('m1', 't1');
    expect(r).toEqual({ kind: 'snapshotted', added: 1 });
    expect(executed).toHaveLength(1);
    expect(executed[0]).toContain('role');
  });

  it('skips when another build task of the mission already started (a mission already building)', async () => {
    answers = [mission(), [pin('voice')], [build('t1'), build('t0')], [{ n: 1 }]];
    expect(await snapshotMissionStandards('m1', 't1')).toEqual({ kind: 'skipped', reason: 'build_already_started' });
    expect(executed).toHaveLength(0);
  });

  it('skips when the starting task itself had an earlier attempt', async () => {
    answers = [mission(), [pin('voice')], [build('t1')], [{ n: 2 }]];
    expect(await snapshotMissionStandards('m1', 't1')).toEqual({ kind: 'skipped', reason: 'build_already_started' });
  });

  it('a non-build claim (a final verification, planning) is not the build starting', async () => {
    answers = [mission(), [pin('voice')], [verification('v1')]];
    expect(await snapshotMissionStandards('m1', 'v1')).toEqual({ kind: 'skipped', reason: 'not_build' });
  });

  it('a started verification task does not count as the build having started', async () => {
    answers = [mission(), [pin('voice')], [build('t1'), verification('v0')], [{ n: 1 }]];
    expect(await snapshotMissionStandards('m1', 't1')).toEqual({ kind: 'snapshotted', added: 1 });
  });

  it('a mission that already carries standards is left alone without reading anything else', async () => {
    answers = [mission(planStandardsSnapshot([], [pin('voice')]).criteria)];
    expect(await snapshotMissionStandards('m1', 't1')).toEqual({ kind: 'skipped', reason: 'already' });
    expect(answers).toEqual([]);
  });

  it('a workspace with no standards stops after one read', async () => {
    answers = [mission(), [], [build('t1')]];
    expect(await snapshotMissionStandards('m1', 't1')).toEqual({ kind: 'skipped', reason: 'no_standards' });
    expect(answers).toHaveLength(1);
  });

  it('an inactive mission is not snapshotted', async () => {
    answers = [mission([], 'paused')];
    expect(await snapshotMissionStandards('m1', 't1')).toEqual({ kind: 'skipped', reason: 'not_active' });
  });

  it('a racing write leaves the criteria to whoever wrote first', async () => {
    answers = [mission(), [pin('voice')], [build('t1')], [{ n: 1 }]];
    executeRows = [];
    expect(await snapshotMissionStandards('m1', 't1')).toEqual({ kind: 'skipped', reason: 'raced' });
  });

  it('scheduleStandardsSnapshots runs after the response, only for mission tasks', async () => {
    scheduleStandardsSnapshots([{ taskId: 't1', missionId: null }]);
    expect(afterRuns).toHaveLength(0);
    answers = [mission([], 'paused')];
    scheduleStandardsSnapshots([{ taskId: 't1', missionId: 'm1' }]);
    expect(afterRuns).toHaveLength(1);
    await afterRuns[0]();
    expect(answers).toEqual([]);
  });
});

describe('standardsHoldOf: shadow vs enforced', () => {
  const standard: LivingSpecGoalCriterion = { type: 'living_spec', specId: 'voice', specRevisionId: 'r', revision: 2, contentHash: 'h', role: 'standard', label: 'Standard "Product voice" revision 2' };
  const criteria: GoalCriterion[] = [{ type: 'no_open_tasks' }, standard];
  const stateWith = (verdict: string) => {
    const s = evaluateGoalCriteria({ id: 'm' }, criteria, { tasks: [], workers: [], artifacts: [], evaluatedBy: 'auto' } as any);
    s.criteria[1] = { ...s.criteria[1], verdict: verdict as any };
    return s;
  };

  it('null when the mission carries no standards', () => {
    expect(standardsHoldOf([{ type: 'no_open_tasks' }], null, true)).toBeNull();
  });

  it('null when every standard passes', () => {
    expect(standardsHoldOf(criteria, stateWith('pass'), true)).toBeNull();
  });

  it('names a standard that is not a pass, and says whether it is enforced', () => {
    expect(standardsHoldOf(criteria, stateWith('fail'), false)).toEqual({ unmet: [{ specId: 'voice', label: 'Standard "Product voice" revision 2', verdict: 'fail' }], enforced: false });
    expect(standardsHoldOf(criteria, stateWith('PENDING'), true)?.enforced).toBe(true);
  });

  it('a standard never evaluated, or judged for another selection, is not a pass', () => {
    expect(standardsHoldOf(criteria, null, true)?.unmet[0].verdict).toBe('NOT_EVALUATED');
    const stale = stateWith('pass');
    stale.criteria[1] = { ...stale.criteria[1], fingerprint: 'living_spec:other' };
    expect(standardsHoldOf(criteria, stale, true)?.unmet[0].verdict).toBe('NOT_EVALUATED');
  });

  it('reads STANDARDS_GATE when not told', () => {
    process.env.STANDARDS_GATE = 'enforce';
    try {
      expect(standardsHoldOf(criteria, stateWith('fail'))?.enforced).toBe(true);
    } finally {
      delete process.env.STANDARDS_GATE;
    }
    expect(standardsHoldOf(criteria, stateWith('fail'))?.enforced).toBe(false);
  });
});

describe('standardsLine: Verify\'s Standards beside CI and code review (Navigation R-17)', () => {
  const standard: LivingSpecGoalCriterion = { type: 'living_spec', specId: 'voice', specRevisionId: 'r', revision: 2, contentHash: 'h', role: 'standard', label: 'Standard "Product voice" revision 2' };
  const criteria: GoalCriterion[] = [{ type: 'no_open_tasks' }, standard];
  const state = (verdict: string) => {
    const s = evaluateGoalCriteria({ id: 'm' }, criteria, { tasks: [], workers: [], artifacts: [], evaluatedBy: 'auto' } as any);
    s.criteria[1] = { ...s.criteria[1], verdict: verdict as any };
    return s;
  };

  it('one line when all met, closed', () => {
    const l = standardsLine({ criteria, state: state('pass'), ci: 'met', codeReview: 'met', titles: { voice: 'Product voice' } });
    expect(l).toMatchObject({ text: 'All met', allMet: true, open: false });
    expect(l.items.map((i) => i.label)).toEqual(['CI', 'Code review', 'Product voice']);
    expect(l.items[2].href).toBe('/app/specs/voice');
  });

  it('opens on its own when one fails, saying how many', () => {
    const l = standardsLine({ criteria, state: state('fail'), ci: 'met', codeReview: 'met' });
    expect(l).toMatchObject({ text: '1 not met', allMet: false, open: true });
  });

  it('counts what is met so far while a check runs', () => {
    const l = standardsLine({ criteria, state: state('PENDING'), ci: 'met', codeReview: null });
    expect(l.text).toBe('1 of 2 met');
    expect(l.items.map((i) => i.status)).toEqual(['met', 'checking']);
  });

  it('never lists the outcome spec or a goal criterion as a standard', () => {
    const outcome: LivingSpecGoalCriterion = { type: 'living_spec', specId: 'o', specRevisionId: 'r', revision: 1, contentHash: 'h' };
    const l = standardsLine({ criteria: [outcome], state: null, ci: null, codeReview: null });
    expect(l).toMatchObject({ text: 'None', allMet: false, items: [] });
  });
});
