import { describe, expect, it } from 'bun:test';
import type { GoalCriteriaState, LivingSpecCriterionStanding, LivingSpecGoalCriterion } from '@buildd/shared';
import { countWord, outcomeSpecView } from './mission-outcome-spec-view';

const SPEC = '00000000-0000-4000-8000-000000000001';
const crit = (extra: Partial<LivingSpecGoalCriterion> = {}): LivingSpecGoalCriterion => ({
  type: 'living_spec', specId: SPEC, specRevisionId: '00000000-0000-4000-8000-000000000002', revision: 7, contentHash: 'h', ...extra,
});
type Entry = GoalCriteriaState['criteria'][number];
const entry = (standings: Array<[string, LivingSpecCriterionStanding['standing']]>, extra: Partial<Entry> = {}): Entry => ({
  index: 0, type: 'living_spec', verdict: 'UNVERIFIED',
  spec: { specId: SPEC, revision: 7, targetSha: 'abc1234def5678', standings: standings.map(([criterionId, standing]) => ({ criterionId, standing, headSha: null })) },
  ...extra,
});

describe('outcomeSpecView', () => {
  it('says coverage in words on the integrated commit', () => {
    const v = outcomeSpecView(crit(), entry([['R-1', 'pass'], ['R-2', 'pass'], ['R-3', 'missing']]));
    expect(v.coverage).toBe('Two of three pass on abc1234.');
    expect(v.short).toBe('2 of 3 pass');
    expect(v.open).toEqual([{ standing: 'missing', label: 'Not checked', criterionIds: ['R-3'] }]);
  });

  it('never counts a waived criterion as passed, even when the stored standing says pass', () => {
    const c = crit({ waived: [{ criterionId: 'R-2', reason: 'out of reach for this mission', by: 'user:x', at: '2026-10-14T00:00:00Z' }] });
    const v = outcomeSpecView(c, entry([['R-1', 'pass'], ['R-2', 'pass']]));
    expect(v.passed).toBe(1);
    expect(v.waived).toEqual([{ criterionId: 'R-2', reason: 'out of reach for this mission' }]);
    expect(v.coverage).toBe('One of two pass on abc1234.');
  });

  it('never counts a stale pass as passed', () => {
    const v = outcomeSpecView(crit(), entry([['R-1', 'stale'], ['AC-1', 'pass']]));
    expect(v.passed).toBe(1);
    expect(v.open.map(o => o.standing)).toEqual(['stale']);
  });

  it('lists open criteria in the order to fix them', () => {
    const v = outcomeSpecView(crit(), entry([['R-1', 'unsupported'], ['R-2', 'inconclusive'], ['R-3', 'stale'], ['R-4', 'missing'], ['R-5', 'fail']]));
    expect(v.open.map(o => o.standing)).toEqual(['fail', 'missing', 'stale', 'inconclusive', 'unsupported']);
    expect(v.next).toMatch(/repair task/);
  });

  it('marks a provisional pin and a narrowed scope', () => {
    const v = outcomeSpecView(crit({ provisional: true, criteria: ['R-1'], narrowedReason: 'only the build half applies here' }), null);
    expect(v.revisionLine).toBe('Revision 7, proposed');
    expect(v.narrowed).toEqual({ criterionIds: ['R-1'], reason: 'only the build half applies here' });
    expect(v.coverage).toBeNull();
    expect(v.short).toBe('not checked');
  });

  it('names the final verification task when one is filed', () => {
    const v = outcomeSpecView(crit(), entry([['R-1', 'missing']], { verdict: 'PENDING', workerTaskId: 'task-final' }));
    expect(v.verificationTaskId).toBe('task-final');
    expect(v.next).toMatch(/final verification/);
  });

  it('says the build is done instead of waiting for it when the build has finished (633c77c9)', () => {
    const done = outcomeSpecView(crit(), entry([['R-1', 'missing']], { spec: { specId: SPEC, revision: 7, targetSha: 'abc1234def5678', standings: [{ criterionId: 'R-1', standing: 'missing', headSha: null }], buildDone: true } }));
    expect(done.next).toBe('The build is done. The final verification starts on the next check.');
    expect(done.next).not.toContain('once the build');
    const pending = outcomeSpecView(crit(), entry([['R-1', 'missing']], { spec: { specId: SPEC, revision: 7, targetSha: 'abc1234def5678', standings: [{ criterionId: 'R-1', standing: 'missing', headSha: null }], buildDone: false } }));
    expect(pending.next).toBe('Checked once the build work is done.');
  });

  it('lets the caller say the build is done when the stored state does not', () => {
    const v = outcomeSpecView(crit(), entry([['R-1', 'missing']]), { buildDone: true });
    expect(v.next).toBe('The build is done. The final verification starts on the next check.');
    const noTarget = outcomeSpecView(crit(), null, { buildDone: true });
    expect(noTarget.next).toBe('The build is done. Checked once the integrated branch is known.');
  });

  it('does not claim the build is unfinished when nothing says so', () => {
    const v = outcomeSpecView(crit(), entry([['R-1', 'missing']]));
    expect(v.next).toBe('The final verification has not started.');
  });

  it('spells counts up to twelve', () => {
    expect(countWord(0)).toBe('zero');
    expect(countWord(12)).toBe('twelve');
    expect(countWord(13)).toBe('13');
  });
});
