import { describe, it, expect } from 'bun:test';
import { buildStateBecause, buildConflictBecause, deliveryTransitionLink, reviewRoundLink, dispatchWakeLink, withDispatchLink, entitlementHoldLink, taskRecoveryLink, type BaseSideMerge, type ConflictSubject } from './explain-because';
import { rankGatedSubjects, waitingOnRank, type ExplainAnswer } from './explain-types';
import { deriveMissionStateView, type MissionStateInput } from './mission-state-view';

const base: MissionStateInput = {
  status: 'active',
  isHeld: false,
  activeAgents: 0,
  health: 'NOMINAL',
};

describe('buildStateBecause', () => {
  describe('superseded visual audits', () => {
    const view = deriveMissionStateView({ ...base });
    const subject = { missionId: 'm', workspaceId: 'ws' };

    it('says a waived audit was waived by a person, not replaced by a passing audit', () => {
      const chain = buildStateBecause(view, subject, { supersededTasks: [{ id: 'a-1', title: 'Audit X', prNumber: null, waived: true }] });
      const claim = chain.map(l => l.claim).find(c => c.includes('Audit X'));
      expect(claim).toBe('Visual audit "Audit X" stalled on infrastructure, but its review was waived by a person, so it does not count as a mission failure.');
      expect(claim).not.toContain('later audit');
    });

    it('keeps the replaced-audit text', () => {
      const chain = buildStateBecause(view, subject, { supersededTasks: [{ id: 'a-1', title: 'Audit X', prNumber: null, supersedingTaskId: 'a-2', replacedByAudit: true }] });
      expect(chain.map(l => l.claim)).toContain('Visual audit "Audit X" failed, but a later audit ("a-2") completed with passing phone and desktop screenshots of the same routes, so it does not count as a mission failure.');
    });
  });

  describe('a mission blocked on an upstream gate', () => {
    const view = deriveMissionStateView({ ...base, health: 'BLOCKED', dependsOnMissionId: 'up-1' });
    const subject = { missionId: 'm', workspaceId: 'ws' };

    it('names each unmet condition with its task and PR', () => {
      const chain = buildStateBecause(view, subject, {
        dependencyTitle: 'Upstream',
        dependencyGate: { gate: 'merged', met: false, unmet: [{ kind: 'pr_closed_unmerged', taskId: 't-1', title: 'feat: build', prNumber: 12 }] },
      });
      expect(chain[0].claim).toBe('Upstream mission "Upstream" has not met this mission\'s "merged" gate.');
      expect(chain[1].claim).toBe('Still needed: PR #12 for "feat: build" closed without merging, and no replacement PR or abandonment is recorded.');
      expect(chain[1].refs).toMatchObject({ taskId: 't-1', prNumber: 12, missionId: 'up-1' });
    });

    it('says the gate is met when the live state meets it before the stamp', () => {
      const chain = buildStateBecause(view, subject, { dependencyTitle: 'Upstream', dependencyGate: { gate: 'merged', met: true, unmet: [] } });
      expect(chain[0].claim).toContain('has met this mission\'s "merged" gate');
    });

    it('keeps the generic line when the gate was not read', () => {
      const chain = buildStateBecause(view, subject, { dependencyTitle: 'Upstream' });
      expect(chain[0].claim).toBe('Upstream mission "Upstream" has not met this mission\'s gate condition.');
    });
  });

  // A reviewer task is runner-claimable in a local-executor mission (claim gate
  // exempts context.reviewerFor), so explain must not say runners never pick it up.
  it('does not call a runner-claimable reviewer task local-session work', () => {
    const open = { id: 'rev-1', title: 'Review PR #1', status: 'pending', runnerClaimable: true };
    const view = deriveMissionStateView({ ...base, executor: 'local', openTasks: [{ id: 'rev-1', status: 'pending', title: 'Review PR #1' }] });
    const chain = buildStateBecause(view, { missionId: 'm', workspaceId: 'ws' }, { openTasks: [open] });
    expect(chain.map(l => l.claim).join('\n')).not.toContain('Claim it from your session');
    const plain = buildStateBecause(view, { missionId: 'm', workspaceId: 'ws' }, { openTasks: [{ ...open, runnerClaimable: false }] });
    expect(plain.map(l => l.claim).join('\n')).toContain('Claim it from your session');
  });

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
    expect(chain[1].claim).toContain('next in line for a runner');
    for (const l of chain) {
      expect(l.refs.missionId).toBe('mission-1');
      expect(l.derivedFrom).toBeTruthy();
    }
  });

  // Regression: while a mission is running, every open deliverable was named
  // "is in_progress with no live worker" — including the one a worker was
  // actively running. The sentence must be earned per task.
  describe('open-task links and worker liveness', () => {
    const running = [
      { id: 'task-live', title: 'Build the page', status: 'in_progress', live: true },
      { id: 'task-queued', title: 'Write the docs', status: 'pending', live: false },
    ];

    it('never says "no live worker" about a task that has one', () => {
      const view = deriveMissionStateView({
        ...base,
        activeAgents: 1,
        openTasks: running.map(({ id, title, status }) => ({ id, title, status })),
      });
      const chain = buildStateBecause(view, { missionId: 'm' }, { openTasks: running });

      const liveLink = chain.find(l => l.refs.taskId === 'task-live');
      expect(liveLink).toBeDefined();
      expect(liveLink!.claim).not.toMatch(/waiting for a runner|nothing is running it/);
      expect(liveLink!.claim).toBe('"Build the page" is in progress.');
      // The row without a worker is still named as such, and leads the chain —
      // it is the one worth a reader's attention.
      expect(chain[0].refs.taskId).toBe('task-queued');
      expect(chain[0].claim).toBe('"Write the docs" is next in line for a runner.');
    });

    it('names the claim loop hold instead of "waiting for a runner" (spec f7f67f1a R-33)', () => {
      const rows = [{ id: 'task-queued', title: 'Write the docs', status: 'pending', live: false, holdReason: 'budget_paused' }];
      const view = deriveMissionStateView({ ...base, health: 'STALLED', openTasks: rows.map(({ id, title, status, holdReason }) => ({ id, title, status, holdReason })) });
      const chain = buildStateBecause(view, { missionId: 'm' }, { openTasks: rows });
      const row = chain.find(l => l.refs.taskId === 'task-queued');
      expect(row?.claim).toBe('"Write the docs" is queued: runners paused new work until the model budget resets.');
    });

    it('does not claim "no live worker" when per-task liveness is unknown and agents are running', () => {
      const view = deriveMissionStateView({
        ...base,
        activeAgents: 2,
        openTasks: [{ id: 'task-a', status: 'in_progress', title: 'Build the page' }],
      });
      const chain = buildStateBecause(view, { missionId: 'm' }, {
        openTasks: [{ id: 'task-a', title: 'Build the page', status: 'in_progress' }],
      });
      for (const l of chain) expect(l.claim).not.toMatch(/waiting for a runner|nothing is running it/);
    });

    it('still names a genuinely orphaned in_progress task', () => {
      const view = deriveMissionStateView({
        ...base,
        health: 'STALLED',
        openTasks: [{ id: 'task-orphan', status: 'in_progress', title: 'Build the page' }],
      });
      const chain = buildStateBecause(view, { missionId: 'm' }, {
        openTasks: [{ id: 'task-orphan', title: 'Build the page', status: 'in_progress', live: false }],
      });
      expect(chain[0].refs.taskId).toBe('task-orphan');
      expect(chain[0].claim).toBe('"Build the page" was started, but nothing is running it now.');
    });

    it('names the unmet dependency, never "no live worker", for a dependency-blocked row', () => {
      const view = deriveMissionStateView({
        ...base,
        health: 'STALLED',
        openTasks: [
          { id: 'task-dep', status: 'pending', title: 'Second step', waitingOnTaskIds: ['task-first'] },
          { id: 'task-first', status: 'pending', title: 'First step' },
        ],
      });
      const chain = buildStateBecause(view, { missionId: 'm' }, {
        openTasks: [
          { id: 'task-dep', title: 'Second step', status: 'pending', live: false, waitingOn: [{ id: 'task-first', title: 'First step' }] },
          { id: 'task-first', title: 'First step', status: 'pending', live: false },
        ],
      });
      expect(chain[0].refs.taskId).toBe('task-first');
      const depLink = chain.find(l => l.claim.includes('Second step'));
      expect(depLink).toBeDefined();
      expect(depLink!.claim).not.toMatch(/waiting for a runner|nothing is running it/);
      expect(depLink!.claim).toContain('First step');
      expect(depLink!.refs.taskId).toBe('task-first');
    });

    // Spec e28018c2 R-7 / AC-7, AC-8: an upstream in another workspace.
    it('AC-7: a hidden upstream is worded without its title, and refs no task of it', () => {
      const view = deriveMissionStateView({
        ...base,
        health: 'STALLED',
        openTasks: [{ id: 'task-b', status: 'pending', title: 'Write the docs', waitingOnTaskIds: ['task-a'] }],
      });
      const chain = buildStateBecause(view, { taskId: 'task-b' }, {
        openTasks: [{ id: 'task-b', title: 'Write the docs', status: 'pending', live: false, waitingOn: [{ id: 'task-a', title: null, hidden: true }] }],
      });
      const depLink = chain.find(l => l.claim.includes('Write the docs'))!;
      expect(depLink.claim).toBe(`"Write the docs" is waiting on a task in a workspace you can't see.`);
      expect(depLink.derivedFrom).toBe('tasks.dependsOn');
      expect(depLink.refs.taskId).not.toBe('task-a');
      expect(JSON.stringify(chain)).not.toContain('task-a');
    });

    it('AC-8: a visible upstream in another workspace is named with its workspace and keeps its ref', () => {
      const view = deriveMissionStateView({
        ...base,
        health: 'STALLED',
        openTasks: [{ id: 'task-b', status: 'pending', title: 'Write the docs', waitingOnTaskIds: ['task-a'] }],
      });
      const chain = buildStateBecause(view, { taskId: 'task-b' }, {
        openTasks: [{ id: 'task-b', title: 'Write the docs', status: 'pending', live: false, waitingOn: [{ id: 'task-a', title: 'Ship the API', workspaceName: 'App' }] }],
      });
      const depLink = chain.find(l => l.claim.includes('Write the docs'))!;
      expect(depLink.claim).toBe('"Write the docs" is waiting on "Ship the API" in App.');
      expect(depLink.refs.taskId).toBe('task-a');
    });

    it('treats unknown liveness on a stalled mission as orphaned', () => {
      const view = deriveMissionStateView({
        ...base,
        health: 'STALLED',
        openTasks: [{ id: 'task-orphan', status: 'in_progress', title: 'Build the page' }],
      });
      const chain = buildStateBecause(view, { missionId: 'm' }, {
        openTasks: [{ id: 'task-orphan', title: 'Build the page', status: 'in_progress' }],
      });
      expect(chain[0].claim).toContain('nothing is running it now');
    });
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
    expect(chain[0].claim).toBe('No task, PR, check or decision is open.');
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
    gateHistory: [],
    derivedFrom: { state: 'mission.status', waitingOn: null, because: [], history: null, nextAction: null, gateHistory: null },
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

describe('dispatchWakeLink (explain for a pending task)', () => {
  const NOW = Date.parse('2026-10-04T12:00:00.000Z');
  const subject = { taskId: 'task-1', workspaceId: 'ws-1' };
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'outbox-1', status: 'pending', cause: 'task.created', transport: 'dispatch', attempt_count: 0,
    not_before: new Date(NOW - 10 * 60_000).toISOString(), handed_off_at: null, last_error: null, ...over,
  });

  it('a wake due over 5 min and undelivered names the outbox row', () => {
    const l = dispatchWakeLink(row(), subject, NOW)!;
    expect(l.claim).toContain('undelivered');
    expect(l.claim).toContain('2026-10-04T11:50:00.000Z');
    expect(l.refs).toEqual({ taskId: 'task-1', workspaceId: 'ws-1', outboxId: 'outbox-1' });
    expect(l.derivedFrom).toBe('task_dispatch_outbox.status');
  });

  it('handed off to Dispatch past due, with no receipt', () => {
    const l = dispatchWakeLink(row({ status: 'handed_off', handed_off_at: new Date(NOW - 9 * 60_000).toISOString() }), subject, NOW)!;
    expect(l.claim).toContain('handed off to Dispatch');
    expect(l.claim).toContain('no delivery receipt');
  });

  it('failed: attempts and the last error', () => {
    const l = dispatchWakeLink(row({ status: 'failed', attempt_count: 5, last_error: 'http_500' }), subject, NOW)!;
    expect(l.claim).toContain('failed after 5 attempts');
    expect(l.claim).toContain('http_500');
  });

  it('nothing to say: a wake still inside its window, a future wake, a delivered one, no row', () => {
    expect(dispatchWakeLink(row({ not_before: new Date(NOW - 60_000).toISOString() }), subject, NOW)).toBeNull();
    expect(dispatchWakeLink(row({ not_before: new Date(NOW + 3600_000).toISOString() }), subject, NOW)).toBeNull();
    expect(dispatchWakeLink(row({ status: 'delivered' }), subject, NOW)).toBeNull();
    expect(dispatchWakeLink(null, subject, NOW)).toBeNull();
  });

  it('withDispatchLink puts the link before the closing conclusion and renumbers', () => {
    const chain = [
      { order: 1, claim: 'a', derivedFrom: 'tasks.dependsOn' as const, refs: {} },
      { order: 2, claim: 'State is stalled.', derivedFrom: 'tasks.status + workers.status' as const, refs: {} },
    ];
    const l = dispatchWakeLink(row(), subject, NOW)!;
    const out = withDispatchLink(chain, l);
    expect(out.map(x => x.order)).toEqual([1, 2, 3]);
    expect(out[1].refs.outboxId).toBe('outbox-1');
    expect(out[2].claim).toBe('State is stalled.');
    expect(withDispatchLink(chain, null)).toBe(chain);
  });
});

describe('deliveryTransitionLink (§17.5: because[] from the newest kernel transition)', () => {
  const d = {
    state: 'AWAITING_PUSH', headline: 'Waiting for the fix to reach GitHub', detail: 'PR #7 is still at abc1234', prNumber: 7, attemptLine: 'review 1 of 3',
    lastTransition: { command: 'AttemptEnded', fromState: 'FIXING', toState: 'AWAITING_PUSH', createdAt: '2026-01-01T00:00:00.000Z' },
  };
  it('names the transition, the state and its evidence, with hard refs', () => {
    const l = deliveryTransitionLink(d, { taskId: 't1', workspaceId: 'w1' })!;
    expect(l.derivedFrom).toBe('DeliveryView.lastTransition');
    expect(l.refs).toEqual({ taskId: 't1', workspaceId: 'w1', prNumber: 7 });
    expect(l.claim).toContain('AttemptEnded moved it FIXING → AWAITING_PUSH');
    expect(l.claim).toContain('abc1234');
    expect(l.claim).toContain('review 1 of 3');
  });
  it('no delivery or no transition: no link', () => {
    expect(deliveryTransitionLink(null, {})).toBeNull();
    expect(deliveryTransitionLink({ ...d, lastTransition: null }, {})).toBeNull();
  });
  it('goes just before the chain conclusion', () => {
    const chain = withDispatchLink([
      { order: 1, claim: 'a', derivedFrom: 'tasks.dependsOn', refs: {} },
      { order: 2, claim: 'end', derivedFrom: 'tasks.dependsOn', refs: {} },
    ], deliveryTransitionLink(d, {}));
    expect(chain.map(c => c.derivedFrom)).toEqual(['tasks.dependsOn', 'DeliveryView.lastTransition', 'tasks.dependsOn']);
    expect(chain.map(c => c.order)).toEqual([1, 2, 3]);
  });
});

describe('entitlementHoldLink (explain for a task held by a plan limit)', () => {
  const subject = { taskId: 'task-1', workspaceId: 'ws-1' };

  it('a hosted runner hold reads "hosted runner allowance used" with the numbers and the way out', () => {
    const l = entitlementHoldLink({ entitlementBlock: { kind: 'hosted_runner', used: 50, limit: 50, resetsAt: '2026-11-01T00:00:00.000Z' } }, subject)!;
    expect(l.claim).toContain('Hosted runner allowance used: 50 of 50');
    expect(l.claim).toContain('2026-11-01T00:00:00.000Z');
    expect(l.claim).toContain('runner of your own');
    expect(l.derivedFrom).toBe('tasks.context.entitlementBlock');
    expect(l.refs).toEqual({ taskId: 'task-1', workspaceId: 'ws-1' });
  });

  it('no hold, no link', () => {
    expect(entitlementHoldLink({}, subject)).toBeNull();
    expect(entitlementHoldLink(null, subject)).toBeNull();
  });
});

// failure-incident-recovery §18.5/§18.6 (AC-22).
describe('taskRecoveryLink', () => {
  const subject = { taskId: 'task-1', workspaceId: 'ws-1' };

  it('a cancelled task superseded by a PR says so', () => {
    const l = taskRecoveryLink('cancelled', { cancellation: { reason: 'Superseded by PR #3936', supersededBy: { prNumber: 3936 }, actor: 'account:a', at: '2026-10-11T00:00:00.000Z' } }, subject)!;
    expect(l.claim).toBe('Cancelled: superseded by PR #3936.');
    expect(l.derivedFrom).toBe('tasks.context.cancellation');
  });

  it('a cancelled task with a reason says the reason', () => {
    expect(taskRecoveryLink('cancelled', { cancellation: { reason: 'No longer needed', actor: 'user:u', at: 'x' } }, subject)!.claim).toBe('Cancelled: No longer needed');
  });

  it('a pending task held for its credential says what it waits on', () => {
    const hold = { credentialKey: 'account:a', shared: false, label: 'the Claude login on runner "laptop"', since: 'x', firstHeldAt: 'x', attempts: 1, probeAt: '2026-10-11T12:15:00.000Z', exhausted: false };
    const l = taskRecoveryLink('pending', { credentialHold: hold }, subject)!;
    expect(l.claim).toContain('Waiting for a healthy credential');
    expect(l.claim).toContain('12:15 UTC');
    expect(l.derivedFrom).toBe('tasks.context.credentialHold');
  });

  it('nothing recorded, no link', () => {
    expect(taskRecoveryLink('cancelled', {}, subject)).toBeNull();
    expect(taskRecoveryLink('pending', null, subject)).toBeNull();
    expect(taskRecoveryLink('completed', { cancellation: { reason: 'x', actor: 'a', at: 'b' } }, subject)).toBeNull();
  });
});

describe('reviewRoundLink (58c8961e: why the latest review round started)', () => {
  const base = { failureCount: 0, verdict: null, effectiveVerdict: null } as const;
  it('names the trigger and a delta review that carries an approval', () => {
    const l = reviewRoundLink({ prNumber: 7, rounds: [
      { ...base, id: 'r1', round: 1, headSha: 'a'.repeat(40), kind: 'full', status: 'decided', trigger: 'first_pass' },
      { ...base, id: 'r2', round: 2, headSha: 'b'.repeat(40), kind: 'delta', status: 'queued', trigger: 'ci_fix', scope: { deltaApproval: { eligible: true, fromHeadSha: 'a'.repeat(40), reason: 'small delta inside the approved PR' } } },
    ] }, { taskId: 't1' })!;
    expect(l.derivedFrom).toBe('DeliveryView.rounds');
    expect(l.refs).toEqual({ taskId: 't1', prNumber: 7 });
    expect(l.claim).toBe('Review round 2 at bbbbbbb: After a CI fix. A delta review that carries the approval at aaaaaaa.');
  });
  it('says why a round after an approval is a full review, and how a superseded one ended', () => {
    const full = reviewRoundLink({ prNumber: 7, rounds: [
      { ...base, id: 'r2', round: 2, headSha: 'b'.repeat(40), kind: 'full', status: 'superseded', trigger: 'new_commits', endReason: 'superseded_by_push', scope: { deltaApproval: { eligible: false, fromHeadSha: 'a'.repeat(40), reason: 'the delta touches a file outside the PR (src/b.ts)' } } },
    ] }, {})!;
    expect(full.claim).toBe('Review round 2 at bbbbbbb: After new commits. A full review, because the delta touches a file outside the PR (src/b.ts). Ended: replaced by a newer push.');
  });
  it('no rounds, or a round from before triggers: no link', () => {
    expect(reviewRoundLink({ prNumber: 7, rounds: [] }, {})).toBeNull();
    expect(reviewRoundLink(null, {})).toBeNull();
    expect(reviewRoundLink({ prNumber: 7, rounds: [{ ...base, id: 'r1', round: 1, headSha: 'a', kind: 'full', status: 'queued' }] }, {})).toBeNull();
  });
});
