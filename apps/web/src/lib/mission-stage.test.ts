import { describe, expect, it } from 'bun:test';
import type { GoalCriterion } from '@buildd/shared';
import { missionChecks } from './mission-checks';
import { missionStage, type MissionStageInput, type MissionStageTask } from './mission-stage';

const criterion: GoalCriterion = { type: 'command', command: 'bun run test', label: 'Unit tests pass' };

function task(over: Partial<MissionStageTask> = {}): MissionStageTask {
  return {
    id: over.id ?? `t-${Math.random().toString(36).slice(2, 8)}`,
    title: 'Build a thing', status: 'completed', taskClass: 'work', kind: 'engineering', mode: 'execution',
    category: 'feature', roleSlug: 'builder', context: null, prs: [],
    ...over,
  };
}
const mergedPr = { prUrl: 'https://example.test/pr/1', prNumber: 1, mergedAt: '2026-10-14T10:00:00.000Z', prLifecycleStatus: 'merged' };
const openPr = { prUrl: 'https://example.test/pr/2', prNumber: 2, mergedAt: null, prLifecycleStatus: 'open' };

function input(over: Partial<MissionStageInput> = {}): MissionStageInput {
  return {
    mission: {
      status: 'active', isHeld: false, integrationBranchEnabled: false, workingBranch: null,
      goalCriteria: [criterion], goalCriteriaState: null, releasedAt: null,
    },
    tasks: [task({ prs: [mergedPr] }), task({ prs: [mergedPr] })],
    target: 'dev',
    mergeTier: 'agent-review',
    releaseConfigured: false,
    ...over,
  };
}

describe('AC-7: build done, goal criteria pending', () => {
  it('the rail shows Verify as the current step', () => {
    const c = missionChecks({
      build: { done: 2, total: 2 }, branch: 'direct', target: 'dev', mergeTier: 'agent-review', visual: null,
      criteria: [criterion], criteriaState: null, integrationPr: null, release: 'not_configured',
    });
    expect(c.checkpoint).toBe('verify');
    expect(c.rail.find(s => s.key === 'verify')!.state).toBe('now');
  });

  it('the stage says verifying, with the rail\'s own words for what it waits on', () => {
    const c = missionChecks({
      build: { done: 2, total: 2 }, branch: 'direct', target: 'dev', mergeTier: 'agent-review', visual: null,
      criteria: [criterion], criteriaState: null, integrationPr: null, release: 'not_configured',
    });
    const s = missionStage(input());
    expect(s.step).toBe('verifying');
    expect(s.waitingOn).toBe(c.rail.find(r => r.key === 'verify')!.text);
    expect(s.waitingOn).toBe('Unit tests pass: not checked');
  });
});

describe('visual verification (review of #4778): the list never says delivered past an audit it cannot read', () => {
  const passed = { evaluatedAt: 'x', evaluatedBy: 'auto' as const, overall: 'pass' as const, criteria: [{ index: 0, type: 'command' as const, verdict: 'pass' as const }] };
  const direct = (audit: Partial<MissionStageTask>[], over: Partial<MissionStageInput['mission']> = {}) => missionStage(input({
    mission: { ...input().mission, goalCriteriaState: passed, ...over },
    tasks: [task({ prs: [mergedPr] }), ...audit.map(a => task({ title: '[surface audit] check the screens', roleSlug: 'visual-auditor', ...a }))],
  }));

  it('an audit completed with findings stays verifying (the page shows findings, not delivered)', () => {
    expect(direct([{ status: 'completed' }])).toEqual({ step: 'verifying', waitingOn: 'see the mission page' });
  });

  it('an audit waiting on the owner stays verifying, saying so', () => {
    expect(direct([{ status: 'waiting_input' }])).toEqual({ step: 'verifying', waitingOn: 'a question for you' });
  });

  it('a failed audit stays verifying: unable to run', () => {
    expect(direct([{ status: 'failed' }])).toEqual({ step: 'verifying', waitingOn: 'unable to run' });
  });

  it('a queued audit stays verifying: queued', () => {
    expect(direct([{ status: 'pending' }])).toEqual({ step: 'verifying', waitingOn: 'queued' });
  });

  it('a passed audit is still not delivered from the list: only a completed mission is', () => {
    // A clean pass is shots + verdicts + reviews the list does not load; it says less, never more.
    expect(direct([{ status: 'completed' }]).step).toBe('verifying');
    expect(direct([{ status: 'completed' }], { status: 'completed' })).toEqual({ step: 'delivered', waitingOn: null });
  });

  it('the newest audit decides: a failed round replaced by a later running one reads checking', () => {
    expect(direct([
      { status: 'failed', createdAt: '2026-10-14T09:00:00.000Z' },
      { status: 'in_progress', createdAt: '2026-10-14T10:00:00.000Z' },
    ])).toEqual({ step: 'verifying', waitingOn: 'checking' });
  });

  it('a cancelled audit is not a review: the rest of the rail decides', () => {
    expect(direct([{ status: 'cancelled' }])).toEqual({ step: 'delivered', waitingOn: null });
  });

  it('the build still comes first', () => {
    const s = missionStage(input({
      tasks: [task({ status: 'in_progress' }), task({ title: '[surface audit] check the screens', status: 'failed' })],
    }));
    expect(s.step).toBe('building');
  });
});

describe('missionStage', () => {
  it('is building while build work has not landed, waiting on the rail\'s build count', () => {
    const s = missionStage(input({ tasks: [task({ prs: [mergedPr] }), task({ status: 'in_progress' })] }));
    expect(s).toEqual({ step: 'building', waitingOn: '1 of 2 landed' });
  });

  it('a completed task whose PR has not merged has not landed', () => {
    expect(missionStage(input({ tasks: [task({ prs: [openPr] })] })).step).toBe('building');
  });

  it('only build work counts: an audit, a fix, a bookkeeping row and a cancelled task do not', () => {
    const s = missionStage(input({
      mission: { ...input().mission, goalCriteria: [] },
      tasks: [
        task({ prs: [mergedPr] }),
        task({ title: '[surface fix] padding', status: 'pending' }),
        task({ title: 'Organizer check-in', taskClass: 'bookkeeping', status: 'pending' }),
        task({ title: 'Duplicate', status: 'cancelled' }),
      ],
    }));
    expect(s.step).toBe('delivered');
  });

  it('an open visual audit never reads as a pass: the mission is still verifying', () => {
    const s = missionStage(input({
      mission: { ...input().mission, goalCriteria: [] },
      tasks: [task({ prs: [mergedPr] }), task({ title: '[surface audit] check the screens', status: 'in_progress' })],
    }));
    expect(s).toEqual({ step: 'verifying', waitingOn: 'checking' });
  });

  it('criteria passed and merged with no release configured is delivered', () => {
    const s = missionStage(input({
      mission: { ...input().mission, goalCriteriaState: { evaluatedAt: 'x', evaluatedBy: 'auto', overall: 'pass', criteria: [{ index: 0, type: 'command', verdict: 'pass' }] } },
    }));
    expect(s).toEqual({ step: 'delivered', waitingOn: null });
  });

  it('with a release configured it never claims production is healthy: it stays delivering', () => {
    const s = missionStage(input({
      releaseConfigured: true,
      mission: { ...input().mission, goalCriteria: [] },
    }));
    expect(s.step).toBe('delivering');
    expect(s.waitingOn).toBe('waiting');
  });

  it('a release dispatched after the last merge reads as started, not healthy', () => {
    const s = missionStage(input({
      releaseConfigured: true,
      mission: { ...input().mission, goalCriteria: [], releasedAt: '2026-10-14T11:00:00.000Z' },
    }));
    expect(s).toEqual({ step: 'delivering', waitingOn: 'started' });
  });

  it('a mission-branch mission waits on its mission PR after the build', () => {
    const s = missionStage(input({
      mission: { ...input().mission, integrationBranchEnabled: true, workingBranch: 'mission/x', goalCriteria: [] },
      tasks: [task({ prs: [mergedPr] }), task({ title: 'Ship mission: x', taskClass: 'bookkeeping', status: 'in_progress', prs: [openPr] })],
      mergeTier: 'human',
    }));
    expect(s).toEqual({ step: 'delivering', waitingOn: 'approve the mission PR' });
  });

  it('a completed mission is delivered; a held one is on hold; one with no build work yet is planning', () => {
    expect(missionStage(input({ mission: { ...input().mission, status: 'completed' }, tasks: [] }))).toEqual({ step: 'delivered', waitingOn: null });
    expect(missionStage(input({ mission: { ...input().mission, isHeld: true } }))).toEqual({ step: 'on_hold', waitingOn: null });
    expect(missionStage(input({ mission: { ...input().mission, status: 'paused' } })).step).toBe('on_hold');
    expect(missionStage(input({ tasks: [task({ title: 'Plan', taskClass: 'bookkeeping', mode: 'planning', status: 'in_progress' })] }))).toEqual({ step: 'planning', waitingOn: null });
  });
});
