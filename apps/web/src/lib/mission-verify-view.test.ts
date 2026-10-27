import { describe, expect, it } from 'bun:test';
import type { GoalCriteriaState, GoalCriterion, LivingSpecCriterionStanding, LivingSpecGoalCriterion } from '@buildd/shared';
import { criterionFingerprint } from '@buildd/core/mission-helpers';
import { missionVerifyView, specGroup, type VerifyEvidence } from './mission-verify-view';
import type { VerdictEvidence } from './specs/mission-evidence';

const NOW = Date.UTC(2026, 9, 27, 12);
const TASK = '11111111-1111-4111-8111-111111111111';
const REPAIR = '22222222-2222-4222-8222-222222222222';

function spec(id: string, over: Partial<LivingSpecGoalCriterion> = {}): LivingSpecGoalCriterion {
  return { type: 'living_spec', specId: id, specRevisionId: `${id}-r`, revision: 4, contentHash: 'h', ...over };
}

const st = (criterionId: string, standing: LivingSpecCriterionStanding['standing'], over: Partial<LivingSpecCriterionStanding> = {}): LivingSpecCriterionStanding => ({
  criterionId, standing, headSha: 'abc', text: `${criterionId} in words`, ...over,
});

function state(criteria: readonly GoalCriterion[], standings: LivingSpecCriterionStanding[][], verdict: 'pass' | 'fail' | 'UNVERIFIED' = 'fail'): GoalCriteriaState {
  return {
    evaluatedAt: '2026-10-27T00:00:00Z', evaluatedBy: 'auto', overall: verdict,
    criteria: criteria.map((c, index) => ({
      index, type: 'living_spec', verdict, fingerprint: criterionFingerprint(c),
      spec: { specId: (c as LivingSpecGoalCriterion).specId, revision: 4, targetSha: 'abcdef0', standings: standings[index] ?? [] },
    })),
  };
}

function verdict(id: string, over: Partial<VerdictEvidence> = {}): VerdictEvidence {
  return { verdictId: id, result: 'fail', observed: null, refs: [], readIds: [], stdoutExcerpt: null, recordedBy: null, at: '2026-10-27T00:00:00Z', ...over };
}

// AC-11: two selected specs, one with 18 in scope and 15 met, one adding 3, all met.
const big = spec('spec-big');
const small = spec('spec-small', { criteria: ['R-40', 'R-41', 'R-42'], narrowedReason: 'the three this mission adds' });
const bigStandings = [
  ...Array.from({ length: 15 }, (_, i) => st(`R-${i + 1}`, 'pass')),
  st('AC-1', 'fail', { verdictId: 'v-ac1', source: 'test' }),
  st('AC-8', 'inconclusive', { verdictId: 'v-ac8' }),
  st('AC-9', 'inconclusive', { verdictId: 'v-ac9' }),
];
const smallStandings = [st('R-40', 'pass'), st('R-41', 'pass'), st('R-42', 'pass')];
const evidence: VerifyEvidence = {
  verdicts: new Map([
    ['v-ac1', verdict('v-ac1', { stdoutExcerpt: 'expected 1 got 0', recordedBy: `final-verification:${TASK}` })],
    ['v-ac9', verdict('v-ac9', { result: 'inconclusive', refs: [{ kind: 'screenshot', ref: 's1' }, { kind: 'screenshot', ref: 's2' }] })],
  ]),
  repairs: [{
    taskId: REPAIR, title: 'Publish the bundle on release', status: 'in_progress', specId: 'spec-big', criterionId: 'AC-1',
    workerStartedAt: new Date(NOW - 8 * 60_000).toISOString(), pr: null,
  }],
};
const criteria = [big, small];
const titles = { 'spec-big': 'Cloud runner: deploy from Settings', 'spec-small': 'Settings: Runners' };

describe('missionVerifyView: Requirements grouped by spec (Navigation R-17, AC-11)', () => {
  const view = missionVerifyView({ missionId: 'm1', criteria, state: state(criteria, [bigStandings, smallStandings]), titles, evidence, now: NOW });

  it('reads 18 of 21 met across both specs, counting only what is in scope', () => {
    expect(view.summary).toBe('18 of 21 met');
    expect(view.groups.map(g => [g.title, g.count])).toEqual([['Cloud runner: deploy from Settings', '15 of 18'], ['Settings: Runners', '3 of 3']]);
  });

  it('lists only the unmet, each with its result in words', () => {
    const [g] = view.groups;
    expect(g.unmet.map(u => [u.id, u.text, u.result])).toEqual([
      ['AC-1', 'AC-1 in words', 'Not met'], ['AC-8', 'AC-8 in words', "Couldn't tell"], ['AC-9', 'AC-9 in words', "Couldn't tell"],
    ]);
    expect(g.metCount).toBe(15);
    expect(g.met.map(m => m.id)).toHaveLength(15);
  });

  it('links the evidence: test output to the task that ran it, screenshots to the screens', () => {
    const [ac1, ac8, ac9] = view.groups[0].unmet;
    expect(ac1.evidence).toEqual([{ label: 'Test output', href: `/app/tasks/${TASK}` }]);
    expect(ac8.evidence).toEqual([]);
    expect(ac9.evidence).toEqual([{ label: '2 screenshots', href: '/app/missions/m1?visualReview=1' }]);
  });

  it('says what is being done: the repair running, and what rechecks after it merges', () => {
    const [ac1, ac8] = view.groups[0].unmet;
    expect(ac1.action).toMatchObject({ kind: 'fixing', title: 'Publish the bundle on release', href: `/app/tasks/${REPAIR}`, text: 'Fixing: Publish the bundle on release, running 8m' });
    expect(ac8.action?.text).toBe('rechecks after Publish the bundle on release merges');
  });

  it('an all-met group is one line naming what the mission adds', () => {
    const g = view.groups[1];
    expect(g.allMet).toBe(true);
    expect(g.unmet).toEqual([]);
    expect(g.scope).toBe('the 3 this mission adds');
    expect(g.href).toBe('/app/specs/spec-small?revision=4');
  });

  it('standards are not requirements: they are left out of the groups', () => {
    const standard = spec('voice', { role: 'standard' });
    const v = missionVerifyView({ missionId: 'm1', criteria: [big, standard], state: state([big, standard], [bigStandings, []]), titles, evidence: null, now: NOW });
    expect(v.groups.map(g => g.specId)).toEqual(['spec-big']);
  });

  it('legacy hand-written criteria make no group; no spec, no view', () => {
    const legacy: GoalCriterion = { type: 'command', command: 'bun run test' };
    expect(missionVerifyView({ missionId: 'm1', criteria: [legacy], state: null, titles: {}, evidence: null, now: NOW })).toBeNull();
  });
});

describe('specGroup: what a group says before and around a check', () => {
  it('not checked yet before the first check; the narrowed scope still counts', () => {
    expect(specGroup(small, null, { missionId: 'm1', titles, evidence: null, now: NOW })).toMatchObject({ checked: false, count: null, total: 3, metCount: 0 });
    expect(missionVerifyView({ missionId: 'm1', criteria: [big], state: null, titles, evidence: null, now: NOW })!.summary).toBe('Not checked');
  });

  it('a check for an earlier selection is not counted', () => {
    const s = state([big], [bigStandings]);
    s.criteria[0].fingerprint = 'older';
    expect(specGroup(big, s.criteria[0], { missionId: 'm1', titles, evidence: null, now: NOW })).toMatchObject({ checked: false, count: null });
  });

  it('a waived requirement is neither met nor unmet, and never counted', () => {
    const c = spec('w', { waived: [{ criterionId: 'R-2', reason: 'not this mission', by: 'user:x', at: '2026-10-27T00:00:00Z' }] });
    const s = state([c], [[st('R-1', 'pass'), st('R-2', 'fail')]]);
    const g = specGroup(c, s.criteria[0], { missionId: 'm1', titles: {}, evidence: null, now: NOW });
    expect(g).toMatchObject({ count: '1 of 1', allMet: true, waived: 1 });
  });

  it('a repair whose PR is open rechecks after it merges; with no repair there is no action', () => {
    const s = state([big], [[st('AC-1', 'fail')]]);
    const ev: VerifyEvidence = { verdicts: new Map(), repairs: [{ taskId: REPAIR, title: 'Fix it', status: 'completed', specId: 'spec-big', criterionId: 'AC-1', workerStartedAt: null, pr: { number: 9, url: null, state: 'OPEN' } }] };
    expect(specGroup(big, s.criteria[0], { missionId: 'm1', titles, evidence: ev, now: NOW }).unmet[0].action?.text).toBe('rechecks after Fix it merges');
    expect(specGroup(big, s.criteria[0], { missionId: 'm1', titles, evidence: null, now: NOW }).unmet[0].action).toBeNull();
  });

  it('a reviewer note links to the spec criterion when no task recorded it', () => {
    const s = state([big], [[st('AC-1', 'fail', { verdictId: 'v', source: 'review' })]]);
    const ev: VerifyEvidence = { verdicts: new Map([['v', verdict('v', { observed: 'The button is missing.', recordedBy: 'user:abc' })]]), repairs: [] };
    expect(specGroup(big, s.criteria[0], { missionId: 'm1', titles, evidence: ev, now: NOW }).unmet[0].evidence).toEqual([
      { label: 'Reviewer note', href: '/app/specs/spec-big?revision=4#AC-1' },
    ]);
  });

  it('names a spec by its title, else its label, else its revision', () => {
    expect(specGroup(spec('x', { label: 'Spec "X" revision 4' }), null, { missionId: 'm1', titles: {}, evidence: null, now: NOW }).title).toBe('Spec "X" revision 4');
    expect(specGroup(spec('x'), null, { missionId: 'm1', titles: {}, evidence: null, now: NOW }).title).toBe('Spec revision 4');
  });
});
