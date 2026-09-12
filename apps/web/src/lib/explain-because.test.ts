import { describe, it, expect } from 'bun:test';
import { buildStateBecause, buildConflictBecause, type BaseSideMerge, type ConflictSubject } from './explain-because';
import { rankGatedSubjects, waitingOnRank, type ExplainAnswer } from './explain-types';
import { deriveMissionStateView, type MissionStateInput } from './mission-state-view';

const base: MissionStateInput = {
  status: 'active',
  isHeld: false,
  activeAgents: 0,
  health: 'NOMINAL',
};

describe('buildStateBecause', () => {
  it('ends on the state and carries the mission ref on every link', () => {
    const view = deriveMissionStateView({
      ...base,
      health: 'STALLED',
      openTasks: [{ id: 'task-a', status: 'pending', title: 'Write the migration' }],
    });
    const chain = buildStateBecause(
      view,
      { missionId: 'mission-1', workspaceId: 'ws-1' },
      { openTasks: [{ id: 'task-a', title: 'Write the migration', status: 'pending' }] },
    );

    expect(chain.map(l => l.order)).toEqual([1, 2]);
    expect(chain[0].claim).toContain('Write the migration');
    expect(chain[0].refs.taskId).toBe('task-a');
    expect(chain[0].derivedFrom).toBe('tasks.status + workers.status');
    // Last link is the conclusion.
    expect(chain[1].claim).toContain('State is blocked');
    for (const l of chain) {
      expect(l.refs.missionId).toBe('mission-1');
      expect(l.derivedFrom).toBeTruthy();
    }
  });

  it('names each failing criterion as its own link', () => {
    const items = [
      { verdict: 'fail', label: 'no double-fire' },
      { verdict: 'fail', label: 'schema drift clean' },
    ];
    const view = deriveMissionStateView({
      ...base,
      criteriaGate: { state: 'failing', label: 'Criteria failing', tone: 'warning', detail: null },
      criteriaItems: items,
    });
    const chain = buildStateBecause(view, { missionId: 'mission-1' });

    expect(chain).toHaveLength(3);
    expect(chain[0].refs.criterion).toBe('no double-fire');
    expect(chain[1].refs.criterion).toBe('schema drift clean');
    expect(chain[0].derivedFrom).toBe('missions.goalCriteriaState');
  });

  it('carries the error signature for a failed task', () => {
    const view = deriveMissionStateView({
      ...base,
      health: 'FAILING',
      failedTasks: [{ id: 'task-x', title: 'Wire the route' }],
    });
    const chain = buildStateBecause(view, { missionId: 'm' }, {
      failedTasks: [{ id: 'task-x', title: 'Wire the route', errorSignature: 'ENOSPC: no space left on device' }],
    });
    expect(chain[0].refs.errorSignature).toBe('ENOSPC: no space left on device');
    expect(chain[0].refs.taskId).toBe('task-x');
  });

  it('carries the PR number for an unmerged PR', () => {
    const view = deriveMissionStateView({
      ...base,
      completion: {
        ok: false,
        code: 'awaiting_merge',
        reason: 'unmerged',
        awaitingMerge: 1,
        awaitingMergeDetails: [{ taskId: 't', title: 'Wire the route', prNumber: 77, prUrl: 'u' }],
      },
    });
    const chain = buildStateBecause(view, { missionId: 'm' }, {
      unmergedPrs: [{ taskId: 't', title: 'Wire the route', prNumber: 77, prUrl: 'u' }],
    });
    expect(chain[0].refs.prNumber).toBe(77);
  });

  it('produces a single honest link when nothing is outstanding', () => {
    const view = deriveMissionStateView(base);
    const chain = buildStateBecause(view, { missionId: 'm' });
    expect(chain).toHaveLength(1);
    expect(chain[0].claim).toContain('no source reports anything outstanding');
  });
});

describe('buildConflictBecause — a dirty PR names its cause', () => {
  const subject: ConflictSubject = {
    prNumber: 101,
    taskId: 'task-mine',
    branch: 'buildd/feature-branch',
    baseRef: 'dev',
    lifecycleStatus: 'conflict',
    conflictDetectedAt: '2026-01-02T00:00:00.000Z',
    openedBaseSha: 'abcdef0123456789abcdef',
    openedAt: '2026-01-01T00:00:00.000Z',
    touches: ['apps/web/src/lib/mission-helpers.ts', 'packages/core/db/schema.ts'],
    touchSource: 'observedTouches+pathManifest',
  };

  const baseSide: BaseSideMerge[] = [
    {
      prNumber: 98,
      taskId: 'task-theirs',
      title: 'Collapse the state chips',
      branch: 'buildd/other-branch',
      mergedAt: '2026-01-01T12:00:00.000Z',
      headSha: '0123456789abcdef0123',
      touches: ['apps/web/src/lib/mission-helpers.ts'],
      touchSource: 'observedTouches',
    },
    {
      prNumber: 99,
      taskId: 'task-unrelated',
      title: 'Docs pass',
      branch: 'buildd/docs',
      mergedAt: '2026-01-01T13:00:00.000Z',
      headSha: 'fedcba9876543210fedc',
      touches: ['docs/SPEC.md'],
      touchSource: 'pathManifest',
    },
  ];

  it('reports commits-behind-base, the conflicting paths, and the dev-side PRs that touch them', () => {
    const result = buildConflictBecause(subject, baseSide);

    expect(result.commitsBehindBase).toBe(2);
    expect(result.conflictingPaths).toEqual(['apps/web/src/lib/mission-helpers.ts']);

    const claims = result.links.map(l => l.claim).join('\n');
    expect(claims).toContain('2 PR(s) merged into `dev` after PR #101 opened');
    expect(claims).toContain('apps/web/src/lib/mission-helpers.ts');
    expect(claims).toContain('PR #98');
    // The unrelated merge is counted as base drift but is not named as a cause.
    expect(claims).not.toContain('PR #99');

    // Ordered cause → effect, ending on the observed state.
    expect(result.links.map(l => l.order)).toEqual([1, 2, 3, 4]);
    expect(result.links[result.links.length - 1].claim).toContain('is conflicted');
  });

  it('puts hard refs on the dev-side link: PR number, task, branch, commit SHA and paths', () => {
    const result = buildConflictBecause(subject, baseSide);
    const devSide = result.links.find(l => l.refs.prNumber === 98);
    expect(devSide).toBeDefined();
    expect(devSide!.refs.taskId).toBe('task-theirs');
    expect(devSide!.refs.branch).toBe('buildd/other-branch');
    expect(devSide!.refs.commitSha).toBe('0123456789abcdef0123');
    expect(devSide!.refs.baseRef).toBe('dev');
    expect(devSide!.refs.paths).toEqual(['apps/web/src/lib/mission-helpers.ts']);
  });

  it('labels every link with the rows it was read from', () => {
    const result = buildConflictBecause(subject, baseSide);
    for (const l of result.links) {
      expect(l.derivedFrom).toBeTruthy();
    }
    expect(result.links[0].derivedFrom).toContain('workers.mergedAt');
    // The count is a floor, and says so rather than implying a rev-list.
    expect(result.links[0].derivedFrom).toContain('floor');
    expect(result.links[result.links.length - 1].derivedFrom).toContain('workers.prLifecycleStatus');
  });

  it('carries touchSource as a structured ref, not baked into the label', () => {
    const result = buildConflictBecause(subject, baseSide);

    const subjectTouchLink = result.links.find(l => l.derivedFrom === 'workers.observedTouches ∪ tasks.pathManifest');
    expect(subjectTouchLink).toBeDefined();
    expect(subjectTouchLink!.refs.touchSource).toBe('observedTouches+pathManifest');

    const devSideTouchLink = result.links.find(
      l => l.derivedFrom === 'workers.mergedAt + workers.observedTouches ∪ tasks.pathManifest',
    );
    expect(devSideTouchLink).toBeDefined();
    expect(devSideTouchLink!.refs.touchSource).toBe('observedTouches');
  });

  it('says so when the branch declared no scope, instead of guessing paths', () => {
    const result = buildConflictBecause(
      { ...subject, touches: [], touchSource: 'undeclared' },
      baseSide,
    );
    expect(result.conflictingPaths).toEqual([]);
    expect(result.links.map(l => l.claim).join('\n')).toContain('declared no file scope');
  });

  it('says so when no stored touch set overlaps, rather than inventing one', () => {
    const result = buildConflictBecause(subject, [
      { ...baseSide[1] },
    ]);
    expect(result.conflictingPaths).toEqual([]);
    expect(result.links.map(l => l.claim).join('\n')).toContain('neither side declared');
  });

  it('still reports the conflict when nothing merged into the base', () => {
    const result = buildConflictBecause(subject, []);
    expect(result.commitsBehindBase).toBe(0);
    expect(result.links.map(l => l.claim).join('\n')).toContain('is conflicted');
  });
});

describe('workspace ranking', () => {
  const answer = (label: string, kind: string): ExplainAnswer => ({
    subject: { scope: 'mission', id: label, label, workspaceId: 'ws', missionId: label, taskId: null, prNumber: null },
    state: 'blocked',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    waitingOn: kind === 'none' ? null : ({ kind, tone: 'warning', label: 'x' } as any),
    because: [],
    history: [],
    nextAction: 'x',
    derivedFrom: { state: 'mission.status', waitingOn: null, because: [], history: null, nextAction: null },
  });

  it('drops quiet subjects entirely', () => {
    const ranked = rankGatedSubjects([answer('quiet', 'none'), answer('loud', 'task')]);
    expect(ranked.map(a => a.subject.label)).toEqual(['loud']);
  });

  it('puts what a human must act on above what resolves itself', () => {
    const ranked = rankGatedSubjects([
      answer('a-wait', 'self_resolving_wait'),
      answer('b-unverified', 'criterion_unverified'),
      answer('c-failed', 'task_failed'),
      answer('d-decision', 'human_decision'),
    ]);
    expect(ranked.map(a => a.subject.label)).toEqual(['c-failed', 'd-decision', 'b-unverified', 'a-wait']);
  });

  it('ranks a quiet subject last so it can never outrank a blocker', () => {
    expect(waitingOnRank(null)).toBeGreaterThan(waitingOnRank({ kind: 'self_resolving_wait' } as never));
  });
});
