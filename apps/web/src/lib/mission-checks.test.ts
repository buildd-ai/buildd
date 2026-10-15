import { describe, expect, it } from 'bun:test';
import type { GoalCriteriaState, GoalCriterion } from '@buildd/shared';
import { criterionFingerprint } from '@buildd/core/mission-helpers';
import { buildEstimate, criteriaChecks, missionChecks, missionPrCheck, releaseCheck, visualCheck, type MissionChecksInput } from './mission-checks';
import type { MissionVisualReviewState } from './workflow/visual-review-state';
import { planMissions, type PlanTask } from './mission-plan';

function visual(over: Partial<MissionVisualReviewState> = {}): MissionVisualReviewState {
  return {
    status: 'running', blocksCompletion: true, blocksMerge: true, pendingVerification: true, staleEvidence: false,
    nextActor: 'system',
    policy: { mode: 'automatic', origin: 'workspace', waiverAllowed: true, locked: false },
    scope: { screens: 8, uiFiles: 4, source: 'diff', workLanded: true },
    progress: { captured: 6, expected: 8 },
    auditTaskId: 'audit-1',
    branch: { headSha: 'abcdef1234567', base: 'dev', integrationPr: { number: 128, stage: 'open' }, postMergeRecovery: false },
    ...over,
  };
}

const unitTests: GoalCriterion = { type: 'command', command: 'bun run test', label: 'Unit tests pass' };
const prsMerged: GoalCriterion = { type: 'all_prs_merged' };

function criteriaState(entries: GoalCriteriaState['criteria']): GoalCriteriaState {
  return { evaluatedAt: '2026-10-14T00:00:00Z', evaluatedBy: 'auto', overall: 'UNVERIFIED', criteria: entries };
}

function input(over: Partial<MissionChecksInput> = {}): MissionChecksInput {
  return {
    build: { done: 10, total: 10 },
    branch: 'mission-branch',
    target: 'dev',
    mergeTier: 'agent-review',
    visual: visual(),
    criteria: [unitTests],
    criteriaState: null,
    integrationPr: { branch: 'mission/x', state: 'open', prNumber: 128, prUrl: 'https://example.test/pr/128', taskId: 't-pr' },
    release: 'not_configured',
    ...over,
  };
}

describe('missionChecks: only checks that apply (R-15)', () => {
  it('a mission-branch mission shows visual review, the mission PR and each criterion, and no release row when none is configured', () => {
    const c = missionChecks(input());
    expect(c.rows.map(r => r.kind)).toEqual(['visual', 'mission_pr', 'criterion']);
  });

  it('a direct mission has no mission PR row, and no visual row without a review state', () => {
    const c = missionChecks(input({ branch: 'direct', visual: null, integrationPr: null }));
    expect(c.rows.map(r => r.kind)).toEqual(['criterion']);
  });

  it('a configured release adds its row; no criteria means no criterion rows (no fixed checklist)', () => {
    const c = missionChecks(input({ criteria: [], release: 'deploying', releaseLabel: 'Release v0.42.0' }));
    expect(c.rows.map(r => r.kind)).toEqual(['visual', 'mission_pr', 'release']);
    expect(c.rows.at(-1)!.label).toBe('Release v0.42.0');
  });
});

describe('visualCheck (R-17, R-18, AC-7, AC-8)', () => {
  const opts = { mergeTier: 'agent-review' as const };

  it('running shows captured of expected, blocks the merge and names the commit and target', () => {
    const r = visualCheck(visual(), opts);
    expect(r).toMatchObject({ status: 'running', state: 'capturing 6 of 8', chip: 'blocks merge', blocks: true, commit: 'abcdef1', target: 'dev' });
  });

  it('a pass on an older commit is stale, never passed', () => {
    const r = visualCheck(visual({ status: 'passed', staleEvidence: true }), opts);
    expect(r.status).toBe('stale');
  });

  it('no UI change, policy off, waiver and passed each read differently, and none of the first three reads passed', () => {
    const states = [
      visualCheck(visual({ status: 'not_applicable', blocksMerge: false, blocksCompletion: false }), opts),
      visualCheck(visual({ status: 'optional', blocksMerge: false, blocksCompletion: false, policy: { mode: 'off', origin: 'workspace', waiverAllowed: true, locked: false } as MissionVisualReviewState['policy'] }), opts),
      visualCheck(visual({ status: 'waived', waiver: { reason: 'Copy only', actorLabel: 'Owner', at: '2026-10-14T00:00:00Z', supersededBy: null } }), opts),
      visualCheck(visual({ status: 'passed' }), opts),
    ];
    expect(states.map(s => s.status)).toEqual(['not_applicable', 'not_applicable', 'waived', 'passed']);
    expect(new Set(states.map(s => `${s.status}:${s.state}`)).size).toBe(4);
  });

  it('when off or not needed it offers no screens link and says optional once', () => {
    const evidence = [{ label: 'Open screens', href: '/app/missions/m1?visualReview=1' }];
    const off = visualCheck(visual({ status: 'optional', blocksMerge: false, blocksCompletion: false, policy: { mode: 'off', origin: 'workspace', waiverAllowed: true, locked: false } as MissionVisualReviewState['policy'] }), { ...opts, evidence });
    const notNeeded = visualCheck(visual({ status: 'not_applicable', blocksMerge: false, blocksCompletion: false }), { ...opts, evidence });
    for (const r of [off, notNeeded]) {
      expect(r.evidence).toEqual([]);
      expect(r.chip).toBeNull();
    }
    expect(off.state).toBe('optional');
    const running = visualCheck(visual(), { ...opts, evidence });
    expect(running.evidence).toEqual(evidence);
  });

  it('is advisory when it gates neither the merge nor the finish', () => {
    const r = visualCheck(visual({ blocksMerge: false, blocksCompletion: false }), opts);
    expect(r).toMatchObject({ blocks: false, chip: 'advisory' });
  });

  it('a finding is a product problem with its repairs inside the check; a capture failure is a system problem', () => {
    const finding = visualCheck(visual({ status: 'findings', findings: { issues: 1, undecided: 0, fixesOpen: 1, stage: 'fixing', exhausted: false } }), {
      ...opts, repairs: [{ id: 'fix-1', title: 'Filter resets after refresh', done: false }],
    });
    expect(finding).toMatchObject({ status: 'finding', state: '1 finding', problem: 'product' });
    expect(finding.repairs.map(r => r.id)).toEqual(['fix-1']);
    const failed = visualCheck(visual({ status: 'blocked', nextActor: 'system', blocked: { cause: 'app_boot_failed', causeOwner: 'unknown', autoRetriesLeft: 1 } }), opts);
    expect(failed).toMatchObject({ status: 'unable', problem: 'system' });
  });
});

describe('criteriaChecks (R-17, R-19, R-20)', () => {
  const ctx = { branch: 'direct' as const, prMerged: false, target: 'dev' };

  it('UNVERIFIED, PENDING and NOT_EVALUATED never read as passed', () => {
    const rows = criteriaChecks([unitTests, prsMerged, { type: 'no_open_tasks' }], criteriaState([
      { index: 0, type: 'command', verdict: 'UNVERIFIED' },
      { index: 1, type: 'all_prs_merged', verdict: 'PENDING' },
      { index: 2, type: 'no_open_tasks', verdict: 'NOT_EVALUATED' },
    ]), ctx);
    expect(rows.map(r => r.status)).toEqual(['queued', 'running', 'unable']);
  });

  it('on a mission branch an unjudged criterion waits for the merge', () => {
    const [row] = criteriaChecks([unitTests], null, { branch: 'mission-branch', prMerged: false, target: 'dev' });
    expect(row).toMatchObject({ status: 'queued', state: 'after merge' });
    expect(row.detail).toContain('on dev after the mission PR merges');
  });

  it('a verdict stored for a different criterion (fingerprint mismatch) is stale', () => {
    const rows = criteriaChecks([unitTests], criteriaState([{ index: 0, type: 'command', verdict: 'pass', fingerprint: 'someone-else' }]), ctx);
    expect(rows[0].status).toBe('stale');
    const fresh = criteriaChecks([unitTests], criteriaState([{ index: 0, type: 'command', verdict: 'pass', fingerprint: criterionFingerprint(unitTests) }]), ctx);
    expect(fresh[0].status).toBe('passed');
  });

  it('a required check with nothing to run it reads unable to run', () => {
    const waiting = criteriaChecks([unitTests], criteriaState([{ index: 0, type: 'command', verdict: 'PENDING', awaitingRunner: true }]), ctx);
    expect(waiting[0]).toMatchObject({ status: 'unable', state: 'no runner', problem: 'system' });
    const metric = criteriaChecks([{ type: 'metric', query: 'q', operator: 'gt', threshold: 1 }], null, ctx);
    expect(metric[0].status).toBe('unable');
  });

  it('a failed criterion is a finding', () => {
    const rows = criteriaChecks([unitTests], criteriaState([{ index: 0, type: 'command', verdict: 'fail', evidence: '3 tests failed' }]), ctx);
    expect(rows[0]).toMatchObject({ status: 'finding', state: 'not met', detail: '3 tests failed' });
  });
});

describe('criteriaChecks: the outcome spec is one Verify row (R-29)', () => {
  const spec: GoalCriterion = {
    type: 'living_spec', specId: '00000000-0000-4000-8000-000000000001', specRevisionId: '00000000-0000-4000-8000-000000000002',
    revision: 7, contentHash: 'h',
    waived: [{ criterionId: 'R-3', reason: 'not part of this mission', by: 'user:x', at: '2026-10-14T00:00:00Z' }],
  };
  const fp = criterionFingerprint(spec);
  const ctx = { branch: 'mission-branch' as const, prMerged: false, target: 'dev' };
  const state = (verdict: GoalCriteriaState['criteria'][number]['verdict'], standings: Array<[string, 'pass' | 'fail' | 'missing' | 'stale' | 'waived']>, extra = {}) => criteriaState([{
    index: 0, type: 'living_spec', verdict, fingerprint: fp,
    spec: { specId: spec.type === 'living_spec' ? spec.specId : '', revision: 7, targetSha: 'abc1234def', standings: standings.map(([criterionId, standing]) => ({ criterionId, standing, headSha: null })) },
    ...extra,
  }]);

  it('is judged on the integrated branch before the merge, never "after merge"', () => {
    const [row] = criteriaChecks([spec], null, ctx);
    expect(row).toMatchObject({ kind: 'criterion', status: 'queued', state: 'not checked', label: 'Spec revision 7' });
  });

  it('a waived or stale requirement never reads as passed', () => {
    const [row] = criteriaChecks([spec], state('UNVERIFIED', [['R-1', 'pass'], ['R-2', 'stale'], ['R-3', 'pass']]), ctx);
    expect(row.status).toBe('stale');
    expect(row.state).toBe('1 of 3 pass');
    expect(row.detail).toContain('Out of date: R-2');
    expect(row.detail).toContain('Waived: R-3');
    expect(row.commit).toBe('abc1234');
  });

  it('passes only when the evaluator says every in-scope requirement passes', () => {
    const [row] = criteriaChecks([spec], state('pass', [['R-1', 'pass'], ['R-2', 'pass'], ['R-3', 'waived']]), ctx);
    expect(row).toMatchObject({ status: 'passed', actor: 'none' });
  });

  it('a requirement not met is a product finding; a running verification is running', () => {
    expect(criteriaChecks([spec], state('fail', [['R-1', 'fail']]), ctx)[0]).toMatchObject({ status: 'finding', problem: 'product' });
    expect(criteriaChecks([spec], state('PENDING', [['R-1', 'missing']], { workerTaskId: 't-final' }), ctx)[0]).toMatchObject({ status: 'running', state: 'verifying' });
  });

  it('once the build is done it no longer says it waits for the build (633c77c9)', () => {
    const [unjudged] = criteriaChecks([spec], null, { ...ctx, buildComplete: true });
    expect(unjudged.detail).toBe('The build is done. It is checked on the integrated result next.');
    const [open] = criteriaChecks([spec], state('UNVERIFIED', [['R-1', 'missing']]), { ...ctx, buildComplete: true });
    expect(open.detail).toContain('The build is done. The final verification starts on the next check.');
    expect(open.detail).not.toContain('once the build');
    const [building] = criteriaChecks([spec], null, { ...ctx, buildComplete: false });
    expect(building.detail).toBe('Checked on the integrated result once the build work is done.');
  });

  it('a selection changed after judging is stale', () => {
    const [row] = criteriaChecks([spec], state('pass', [['R-1', 'pass']], { fingerprint: 'older' }), ctx);
    expect(row.status).toBe('stale');
  });
});

describe('missionPrCheck (R-21, AC-9)', () => {
  const pr = { branch: 'mission/x', state: 'open' as const, prNumber: 128, prUrl: 'https://example.test/pr/128', taskId: null };
  const ctx = { target: 'dev', buildComplete: true, visualHolds: false };

  it('reviewer merge says the reviewer is deciding and asks nothing of the owner', () => {
    const r = missionPrCheck(pr, { ...ctx, mergeTier: 'agent-review' });
    expect(r).toMatchObject({ status: 'running', state: 'reviewer deciding', actor: 'reviewer' });
  });

  it('human merge is the owner’s decision', () => {
    const r = missionPrCheck(pr, { ...ctx, mergeTier: 'human' });
    expect(r).toMatchObject({ status: 'owner', actor: 'owner', label: 'Mission PR #128 into dev' });
  });

  it('waits on a blocking visual review before anyone merges', () => {
    const r = missionPrCheck(pr, { ...ctx, mergeTier: 'human', visualHolds: true });
    expect(r).toMatchObject({ status: 'queued', actor: 'system' });
  });

  it('merged passes; closed unmerged never reads delivered', () => {
    expect(missionPrCheck({ ...pr, state: 'merged' }, { ...ctx, mergeTier: 'agent-review' }).status).toBe('passed');
    expect(missionPrCheck({ ...pr, state: 'closed' }, { ...ctx, mergeTier: 'agent-review' }).status).toBe('unable');
  });
});

describe('releaseCheck (R-22, P-3)', () => {
  it('only healthy passes; dispatched and deploying are in progress; failed is a hold', () => {
    expect(releaseCheck('not_configured')).toBeNull();
    expect(releaseCheck('healthy')!.status).toBe('passed');
    expect(releaseCheck('deploying')!.status).toBe('running');
    expect(releaseCheck('dispatched')!.status).toBe('running');
    expect(releaseCheck('failed')!).toMatchObject({ status: 'finding', problem: 'system' });
  });
});

describe('the rail (R-11 to R-13, R-22)', () => {
  it('while building, Build is the checkpoint and Verify waits for the build', () => {
    const c = missionChecks(input({ build: { done: 5, total: 10 }, visual: visual({ status: 'needed', progress: undefined }) }));
    expect(c.buildComplete).toBe(false);
    expect(c.checkpoint).toBe('build');
    expect(c.rail.map(s => [s.key, s.state, s.text])).toEqual([
      ['build', 'now', '5 of 10 landed'], ['verify', 'todo', 'after build'], ['deliver', 'todo', 'after visual review'],
    ]);
  });

  it('a visual review already running before the build ends shows in Verify (checks start early)', () => {
    const c = missionChecks(input({ build: { done: 9, total: 10 } }));
    expect(c.rail[1].state).toBe('now');
  });

  it('build done and visual capturing: Verify is the checkpoint', () => {
    const c = missionChecks(input());
    expect(c.buildComplete).toBe(true);
    expect(c.checkpoint).toBe('verify');
    expect(c.rail[1]).toMatchObject({ state: 'now', text: 'capturing 6 of 8' });
  });

  it('mission branch: visual passed, criteria after merge, so Verify is part done and Deliver is the reviewer’s', () => {
    const c = missionChecks(input({ visual: visual({ status: 'passed', branch: { headSha: 'abc', base: 'dev', integrationPr: { number: 128, stage: 'ready' }, postMergeRecovery: false } }) }));
    expect(c.checkpoint).toBe('deliver');
    expect(c.rail[1]).toMatchObject({ state: 'part', text: '1 check after merge' });
    expect(c.rail[2]).toMatchObject({ state: 'now', text: 'reviewer deciding' });
  });

  it('mission branch: merged while criteria are still pending keeps Verify open and shows Deliver done', () => {
    const c = missionChecks(input({
      visual: visual({ status: 'passed', branch: { headSha: 'abc', base: 'dev', integrationPr: { number: 128, stage: 'merged' }, postMergeRecovery: false } }),
      integrationPr: { branch: 'mission/x', state: 'merged', prNumber: 128, prUrl: null, taskId: null },
      criteriaState: criteriaState([{ index: 0, type: 'command', verdict: 'PENDING' }]),
    }));
    expect(c.delivered).toBe(true);
    expect(c.rail[2].state).toBe('done');
    expect(c.rail[1].state).toBe('now');
    expect(c.checkpoint).toBe('verify');
  });

  it('a deploying or failed release is never delivered; healthy is', () => {
    const merged = {
      visual: visual({ status: 'passed', branch: { headSha: 'abc', base: 'dev', integrationPr: { number: 128, stage: 'merged' }, postMergeRecovery: false } }),
      integrationPr: { branch: 'mission/x', state: 'merged' as const, prNumber: 128, prUrl: null, taskId: null },
      criteriaState: criteriaState([{ index: 0, type: 'command', verdict: 'pass' }]),
    };
    expect(missionChecks(input({ ...merged, release: 'deploying' })).delivered).toBe(false);
    const failed = missionChecks(input({ ...merged, release: 'failed' }));
    expect(failed.delivered).toBe(false);
    expect(failed.rail[2]).toMatchObject({ state: 'held', text: 'deploy failed' });
    const healthy = missionChecks(input({ ...merged, release: 'healthy' }));
    expect(healthy.delivered).toBe(true);
    expect(healthy.checkpoint).toBe('done');
    expect(healthy.rail[2].text).toBe('released, healthy');
  });

  it('direct merges: the build being done means merged, and criteria are judged after', () => {
    const c = missionChecks(input({ branch: 'direct', integrationPr: null, visual: null }));
    expect(c.delivered).toBe(true);
    expect(c.checkpoint).toBe('verify');
    expect(c.rail[1]).toMatchObject({ state: 'now', text: 'Unit tests pass: not checked' });
  });

  it('repair tasks never enter the build count (the build input is build tasks only)', () => {
    const c = missionChecks(input({ repairs: [{ id: 'fix-1', title: 'Fix', done: false }] }));
    expect(c.rail[0].text).toBe('10 of 10');
    expect(c.rows[0].repairs).toHaveLength(1);
  });
});

describe('buildEstimate (R-23, R-24, R-25, AC-10)', () => {
  const now = Date.UTC(2026, 9, 14, 12);
  const t = (id: string, over: Partial<PlanTask> = {}): PlanTask => ({ id, status: 'pending', dependsOn: [], startedAt: null, endedAt: null, p50Minutes: 18, p80Minutes: 30, ...over });
  const tasks = [t('a', { status: 'completed', endedAt: now - 60_000 }), t('b'), t('c', { dependsOn: ['b'], p50Minutes: 7, p80Minutes: 12 })];

  it('gives the Plan page\u2019s own p50 and p80 for the same tasks, labelled build only', () => {
    const [plan] = planMissions([{ id: 'm', title: 'M', href: '', workspaceId: null, blocked: null, dependsOnMissionId: null, tasks }], now);
    const e = buildEstimate(tasks, now, false)!;
    expect(e.p50).toBe(plan.p50!);
    expect(e.p80).toBe(plan.p80!);
    expect(e.line).toMatch(/^build only: /);
  });

  it('a hold removes the promise, and tasks with no frozen estimate show none', () => {
    expect(buildEstimate(tasks, now, true)).toBeNull();
    expect(buildEstimate([], now, false)).toBeNull();
    expect(buildEstimate([t('x', { p50Minutes: null, p80Minutes: null })], now, false)).toBeNull();
  });
});
