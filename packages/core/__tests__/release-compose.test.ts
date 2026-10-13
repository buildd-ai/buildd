import { describe, expect, it } from 'bun:test';
import {
  candidateVerdict,
  defaultSelection,
  exclusionNotice,
  flowStep,
  groupComposition,
  missionKey,
  planComposition,
  prKey,
  productionState,
  releaseLede,
  type ComposeMission,
  type ComposePr,
} from '../release-compose';
import { REQUIRED_CANDIDATE_CHECKS as CORE_REQUIRED } from '../release-compose';
// The engine that renders the "Required before merge" list; pinned so the page and the PR body agree.
import { REQUIRED_CANDIDATE_CHECKS as ENGINE_REQUIRED } from '../../../scripts/release-candidate';

const pr = (number: number, missionId: string | null, mergeSha: string | null = `${number}`.padEnd(40, 'a')): ComposePr => ({
  number,
  title: `change ${number}`,
  url: `https://github.com/o/r/pull/${number}`,
  mergeSha,
  missionId,
});

const mission = (id: string, over: Partial<ComposeMission> = {}): ComposeMission => ({
  id,
  title: `Mission ${id}`,
  criteria: { met: 2, total: 3 },
  missionPr: null,
  ...over,
});

const openPr = (number: number, approved: boolean, checks: 'passing' | 'failing' | 'pending' | 'none') => ({
  number,
  title: `Ship mission ${number}`,
  url: `https://github.com/o/r/pull/${number}`,
  state: 'open' as const,
  approved,
  checks,
});

describe('groupComposition', () => {
  const comp = groupComposition({
    shippedPrs: [pr(10, 'm1'), pr(11, null), pr(12, 'm1'), pr(13, 'm2'), pr(14, 'gone')],
    missions: [
      mission('m1'),
      mission('m2'),
      mission('m3', { missionPr: openPr(30, true, 'passing') }),
      mission('m4', { missionPr: openPr(40, true, 'failing') }),
      mission('m5', { missionPr: openPr(50, false, 'passing') }),
      mission('m6', { missionPr: { ...openPr(60, true, 'passing'), state: 'closed' } }),
    ],
  });

  it('groups PRs on dev by mission, keeping their order', () => {
    expect(comp.onDev.map((g) => [g.mission.id, g.prs.map((p) => p.number)])).toEqual([
      ['m1', [10, 12]],
      ['m2', [13]],
    ]);
    expect(comp.onDev.every((g) => g.kind === 'on_dev')).toBe(true);
  });

  it('puts PRs with no known mission under other changes', () => {
    expect(comp.other.map((o) => o.pr.number)).toEqual([11, 14]);
  });

  it('a mission is ready only when its PR is open, approved and green', () => {
    expect(comp.ready.map((g) => g.mission.id)).toEqual(['m3']);
    expect(comp.ready[0].prs[0].number).toBe(30);
    expect(comp.notReady.map((g) => g.mission.id)).toEqual(['m4', 'm5']);
  });

  it('a mission already on dev is never also listed as ready', () => {
    const c = groupComposition({
      shippedPrs: [pr(10, 'm1')],
      missions: [mission('m1', { missionPr: openPr(30, true, 'passing') })],
    });
    expect(c.onDev.map((g) => g.mission.id)).toEqual(['m1']);
    expect(c.ready).toEqual([]);
  });

  it('selects everything on dev and no ready mission by default', () => {
    expect([...defaultSelection(comp)].sort()).toEqual(['mission:m1', 'mission:m2', 'pr:11', 'pr:14']);
  });
});

describe('planComposition', () => {
  const comp = groupComposition({
    shippedPrs: [pr(12, 'm1', 'b'.repeat(40)), pr(10, 'm1', 'a'.repeat(40)), pr(11, null, 'c'.repeat(40))],
    missions: [mission('m1'), mission('m3', { missionPr: openPr(30, true, 'passing') }), mission('m4', { missionPr: openPr(40, false, 'passing') })],
  });

  it('the default selection changes nothing', () => {
    const plan = planComposition(comp, defaultSelection(comp));
    expect(plan.merges).toEqual([]);
    expect(plan.exclusions).toEqual([]);
    expect(plan.missionCount).toBe(1);
    expect(plan.otherCount).toBe(1);
  });

  it('including a ready mission merges its mission PR', () => {
    const plan = planComposition(comp, [...defaultSelection(comp), missionKey('m3')]);
    expect(plan.merges).toEqual([{ missionId: 'm3', title: 'Mission m3', prNumber: 30 }]);
    expect(plan.missionCount).toBe(2);
  });

  it('excluding a mission on dev reverts every one of its merges, newest first', () => {
    const plan = planComposition(comp, [prKey(11)]);
    expect(plan.exclusions).toEqual([{ key: 'mission:m1', label: 'Mission m1', shas: ['b'.repeat(40), 'a'.repeat(40)] }]);
    expect(plan.missionCount).toBe(0);
  });

  it('excluding another change reverts that PR alone', () => {
    const plan = planComposition(comp, [missionKey('m1')]);
    expect(plan.exclusions).toEqual([{ key: 'pr:11', label: '#11 change 11', shas: ['c'.repeat(40)] }]);
  });

  it('refuses keys it cannot select: unknown ones and not-ready missions', () => {
    const plan = planComposition(comp, [...defaultSelection(comp), 'mission:nope', missionKey('m4')]);
    expect(plan.unknown).toEqual(['mission:nope', 'mission:m4']);
    expect(plan.merges).toEqual([]);
  });

  it('flags an on-dev change with no merge commit as unrevertable', () => {
    const c = groupComposition({ shippedPrs: [pr(9, null, null)], missions: [] });
    expect(planComposition(c, []).unrevertable).toEqual(['pr:9']);
  });
});

describe('exclusionNotice', () => {
  const ex = [{ key: 'mission:m1' as const, label: 'Billing', shas: ['a'] }];

  it('says nothing when nothing is excluded', () => {
    expect(exclusionNotice([], 'f'.repeat(40))).toBeNull();
  });

  it('says plainly that an open candidate gets a new SHA and loses its verification', () => {
    const text = exclusionNotice(ex, 'f'.repeat(40))!;
    expect(text).toContain('reverts its merge on the candidate branch');
    expect(text).toContain('new candidate SHA');
    expect(text).toContain('every check and approval on fffffffff is void');
  });

  it('before the cut, says the candidate is amended before anything is verified', () => {
    expect(exclusionNotice(ex, null)).toContain('gets a new SHA before anything is verified');
  });
});

describe('candidateVerdict', () => {
  const SHA = 'c'.repeat(40);
  const OLD = 'o'.repeat(40);
  const required = ['build', 'release candidate verified'];

  it('counts checks on the candidate SHA only; a green on an older SHA is missing', () => {
    const v = candidateVerdict({
      candidateSha: SHA,
      required,
      checks: [
        { name: 'build', sha: OLD, state: 'passing', url: null },
        { name: 'release candidate verified', sha: SHA, state: 'passing', url: 'u' },
      ],
      reviews: [{ author: 'owner', state: 'APPROVED', sha: SHA }],
    });
    expect(v.checks.find((c) => c.name === 'build')!.state).toBe('missing');
    expect(v.allChecksPassed).toBe(false);
    expect(v.readyToRelease).toBe(false);
  });

  it('an approval on a previous candidate SHA does not approve the amended one', () => {
    const v = candidateVerdict({
      candidateSha: SHA,
      required,
      checks: required.map((name) => ({ name, sha: SHA, state: 'passing' as const, url: null })),
      reviews: [{ author: 'owner', state: 'APPROVED', sha: OLD }],
    });
    expect(v.allChecksPassed).toBe(true);
    expect(v.approved).toBe(false);
    expect(v.staleApprovals).toBe(1);
    expect(v.readyToRelease).toBe(false);
  });

  it('ready only with every check passing and an approval on this SHA', () => {
    const v = candidateVerdict({
      candidateSha: SHA,
      required,
      checks: [...required.map((name) => ({ name, sha: SHA, state: 'passing' as const, url: null })), { name: 'lint', sha: SHA, state: 'passing', url: null }],
      reviews: [{ author: 'owner', state: 'APPROVED', sha: SHA }],
    });
    expect(v.readyToRelease).toBe(true);
    expect(v.checks.map((c) => [c.name, c.required])).toEqual([['build', true], ['release candidate verified', true], ['lint', false]]);
  });

  it('changes requested on this SHA blocks an approval', () => {
    const v = candidateVerdict({
      candidateSha: SHA,
      required: [],
      checks: [],
      reviews: [{ author: 'a', state: 'APPROVED', sha: SHA }, { author: 'b', state: 'CHANGES_REQUESTED', sha: SHA }],
    });
    expect(v.approved).toBe(false);
  });

  it('the page requires the same checks the candidate PR body lists', () => {
    expect([...CORE_REQUIRED]).toEqual(ENGINE_REQUIRED);
  });
});

describe('productionState', () => {
  const M = 'm'.repeat(40);

  it('a merged candidate is not released until production runs it', () => {
    expect(productionState({ mergeSha: null, deployedSha: M, deployedContainsMerge: true })).toBe('not_merged');
    expect(productionState({ mergeSha: M, deployedSha: null, deployedContainsMerge: null })).toBe('awaiting_production');
    expect(productionState({ mergeSha: M, deployedSha: 'x'.repeat(40), deployedContainsMerge: false })).toBe('awaiting_production');
    expect(productionState({ mergeSha: M, deployedSha: 'x'.repeat(40), deployedContainsMerge: null })).toBe('awaiting_production');
  });

  it('released when production runs the merge commit or a descendant of it', () => {
    expect(productionState({ mergeSha: M, deployedSha: M, deployedContainsMerge: null })).toBe('released');
    expect(productionState({ mergeSha: M, deployedSha: 'x'.repeat(40), deployedContainsMerge: true })).toBe('released');
  });
});

describe('flowStep and releaseLede', () => {
  it('walks compose → review → release → released', () => {
    expect(flowStep({ hasCandidate: false, production: 'not_merged' })).toBe('compose');
    expect(flowStep({ hasCandidate: true, production: 'not_merged' })).toBe('review');
    expect(flowStep({ hasCandidate: true, production: 'awaiting_production' })).toBe('release');
    expect(flowStep({ hasCandidate: true, production: 'released' })).toBe('released');
  });

  it('leads with the result', () => {
    const passing = { checks: [{ name: 'build', state: 'passing' as const, url: null, required: true }], allChecksPassed: true, approved: true };
    expect(releaseLede({ version: '0.304.0', step: 'review', missions: 3, other: 2, verdict: passing })).toBe(
      'v0.304.0 is ready to release: 3 missions, 2 other changes, all checks passed.',
    );
    expect(
      releaseLede({
        version: 'v0.304.0',
        step: 'review',
        missions: 1,
        other: 0,
        verdict: { checks: [{ name: 'build', state: 'failing', url: null, required: true }], allChecksPassed: false, approved: true },
      }),
    ).toBe('v0.304.0 is not ready: 1 mission, 0 other changes, 1 check failing.');
    expect(releaseLede({ version: '0.304.0', step: 'release', missions: 1, other: 1 })).toBe(
      'v0.304.0 is merged and waiting for production to run it: 1 mission, 1 other change.',
    );
    expect(releaseLede({ version: null, step: 'compose', missions: 2, other: 0 })).toBe('The next release would ship 2 missions, 0 other changes.');
  });
});
