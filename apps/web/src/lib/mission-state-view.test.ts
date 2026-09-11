import { describe, it, expect } from 'bun:test';
import {
  deriveMissionStateView,
  isGated,
  nextActionFor,
  type MissionStateInput,
  type MissionStateView,
  type WaitingOnDescriptor,
} from './mission-state-view';
import { deriveCriteriaGatePresentation } from '@buildd/core/mission-helpers';
import { deriveTaskHealthSignal } from './mission-helpers';

const base: MissionStateInput = {
  status: 'active',
  isHeld: false,
  activeAgents: 0,
  health: 'NOMINAL',
};

/**
 * Narrow to the gated variant, failing the test (rather than the type-check) if
 * the view came back quiet. Every assertion below that reads `waitingOn` goes
 * through here, so a regression that renders a blocker as idle fails loudly.
 */
function gated(view: MissionStateView): WaitingOnDescriptor {
  expect(isGated(view)).toBe(true);
  if (!isGated(view)) throw new Error('expected a gated view');
  return view.waitingOn;
}

describe('deriveMissionStateView — blocked by task', () => {
  it('reports the open tasks when nothing is live on them', () => {
    const view = deriveMissionStateView({
      ...base,
      health: 'STALLED',
      openTasks: [
        { id: 'task-a', status: 'pending', title: 'Write the migration' },
        { id: 'task-b', status: 'assigned', title: 'Wire the route' },
      ],
    });

    expect(view.kind).toBe('blocked');
    const waiting = gated(view);
    expect(waiting.kind).toBe('task');
    if (waiting.kind !== 'task') throw new Error('unreachable');
    expect(waiting.count).toBe(2);
    expect(waiting.taskIds).toEqual(['task-a', 'task-b']);
    expect(waiting.byStatus).toEqual({ pending: 1, assigned: 1 });
    expect(view.displayState).toBe('stalled');
    expect(view.derivedFrom.kind).toBe('deriveTaskHealthSignal');
  });

  it("takes canCompleteMission's breakdown when the predicate was run", () => {
    const view = deriveMissionStateView({
      ...base,
      health: 'NOMINAL',
      completion: {
        ok: false,
        code: 'pending_deliverables',
        reason: '2 task(s) still open (2 pending)',
        pendingDeliverables: 2,
        pendingByStatus: { pending: 2 },
      },
    });

    expect(view.kind).toBe('blocked');
    expect(view.derivedFrom.kind).toBe('canCompleteMission');
    const waiting = gated(view);
    if (waiting.kind !== 'task') throw new Error('unreachable');
    expect(waiting.count).toBe(2);
    expect(waiting.label).toContain('2 pending');
  });

  it('consumes deriveTaskHealthSignal, not a reimplementation of it', () => {
    // Same inputs the real page passes: one open task, no live worker.
    const health = deriveTaskHealthSignal({}, [
      { status: 'pending', taskClass: 'work', workers: [] } as never,
    ]);
    expect(health).toBe('STALLED');

    const view = deriveMissionStateView({ ...base, health, openTasks: [{ id: 't1', status: 'pending' }] });
    expect(view.kind).toBe('blocked');
  });
});

describe('deriveMissionStateView — blocked by a failing criterion', () => {
  const items = [
    { verdict: 'fail', label: 'no double-fire' },
    { verdict: 'pass', label: 'all PRs merged' },
  ];

  it('names the criterion and never reports it as blocked', () => {
    const gate = deriveCriteriaGatePresentation({ criteriaCount: 2, overall: 'fail', items: items as never });
    const view = deriveMissionStateView({ ...base, criteriaGate: gate, criteriaItems: items, progress: 100 });

    // Ruling 1: a criteria refusal is never `blocked`. `deriveCriteriaGatePresentation`
    // reserves that word for work-stopping states.
    expect(view.kind).toBe('awaiting_verification');
    expect(view.kind).not.toBe('blocked');

    const waiting = gated(view);
    expect(waiting.kind).toBe('criterion_failing');
    if (waiting.kind !== 'criterion_failing') throw new Error('unreachable');
    expect(waiting.criteria).toEqual(['no double-fire']);
    expect(waiting.label).toBe('Criterion failing: no double-fire');
    expect(waiting.tone).toBe('warning');
    expect(view.criteriaBlockingReason).toBe('Criterion failing: no double-fire');
    expect(view.derivedFrom.kind).toBe('deriveCriteriaGatePresentation');
  });

  it('escalates the tone to error once completion was actually attempted', () => {
    const gate = deriveCriteriaGatePresentation({
      criteriaCount: 2,
      overall: 'fail',
      items: items as never,
      completionAttempted: true,
    });
    expect(gate?.state).toBe('refused');

    const view = deriveMissionStateView({ ...base, criteriaGate: gate, criteriaItems: items });
    const waiting = gated(view);
    if (waiting.kind !== 'criterion_failing') throw new Error('unreachable');
    expect(waiting.tone).toBe('error');
    expect(waiting.refused).toBe(true);
  });

  it('still answers when only canCompleteMission was run', () => {
    const view = deriveMissionStateView({
      ...base,
      completion: { ok: false, code: 'criteria_failed', reason: 'Goal criteria failed — [fail] no double-fire' },
    });
    expect(view.kind).toBe('awaiting_verification');
    expect(gated(view).kind).toBe('criterion_failing');
    expect(view.derivedFrom.kind).toBe('canCompleteMission');
  });
});

describe('deriveMissionStateView — blocked by an unverified criterion', () => {
  const items = [{ verdict: 'UNVERIFIED', label: 'design doc exists' }];

  it('does not read as an alarm', () => {
    const gate = deriveCriteriaGatePresentation({ criteriaCount: 1, overall: null, items: items as never });
    expect(gate?.state).toBe('unverified');

    const view = deriveMissionStateView({ ...base, criteriaGate: gate, criteriaItems: items });

    expect(view.kind).toBe('awaiting_verification');
    const waiting = gated(view);
    expect(waiting.kind).toBe('criterion_unverified');
    // The whole point: neutral, not warning, not error.
    expect(waiting.tone).toBe('neutral');
    expect(waiting.label).toBe('1 criterion not yet verified — run verification');
    expect(view.nextAction).toBe('Run goal-criteria verification to produce a verdict.');
  });

  it('becomes newsworthy only once completion was refused over it', () => {
    const gate = deriveCriteriaGatePresentation({
      criteriaCount: 1,
      overall: 'UNVERIFIED',
      items: items as never,
      completionAttempted: true,
    });
    expect(gate?.state).toBe('refused');

    const view = deriveMissionStateView({ ...base, criteriaGate: gate, criteriaItems: items });
    const waiting = gated(view);
    if (waiting.kind !== 'criterion_unverified') throw new Error('unreachable');
    expect(waiting.tone).toBe('warning');
  });

  it('is quiet when the gate is clear', () => {
    const gate = deriveCriteriaGatePresentation({ criteriaCount: 1, overall: 'pass' });
    const view = deriveMissionStateView({ ...base, criteriaGate: gate });
    expect(view.kind).toBe('idle');
    expect(view.waitingOn).toBeNull();
    expect(view.criteriaBlockingReason).toBeNull();
  });
});

describe('deriveMissionStateView — awaiting merge', () => {
  it('reports a completed task whose PR has not merged, with the PR number', () => {
    const view = deriveMissionStateView({
      ...base,
      progress: 100,
      completion: {
        ok: false,
        code: 'awaiting_merge',
        reason: '1 deliverable task(s) completed but not merged',
        awaitingMerge: 1,
        awaitingMergeDetails: [
          { taskId: 'task-c', title: 'Wire the route', prNumber: 4242, prUrl: 'https://example.invalid/pr/4242' },
        ],
      },
    });

    expect(view.kind).toBe('awaiting_merge');
    const waiting = gated(view);
    expect(waiting.kind).toBe('merge');
    if (waiting.kind !== 'merge') throw new Error('unreachable');
    expect(waiting.prNumbers).toEqual([4242]);
    expect(waiting.taskIds).toEqual(['task-c']);
    expect(waiting.missionPr).toBe(false);
    expect(view.derivedFrom.kind).toBe('canCompleteMission');
  });

  it('distinguishes the mission integration PR from a task PR', () => {
    const view = deriveMissionStateView({
      ...base,
      completion: {
        ok: false,
        code: 'awaiting_mission_pr',
        reason: 'Mission PR is open and unmerged',
        awaitingMerge: 1,
        awaitingMergeDetails: [{ taskId: 'task-pr', title: 'Mission PR', prNumber: 99, prUrl: null }],
      },
    });
    const waiting = gated(view);
    if (waiting.kind !== 'merge') throw new Error('unreachable');
    expect(waiting.missionPr).toBe(true);
    expect(view.nextAction).toContain('mission PR');
  });

  it('falls back to evaluateMissionWorkState when only that was run', () => {
    const view = deriveMissionStateView({
      ...base,
      workState: { complete: false, reason: 'prs_unmerged', unfinishedTaskCount: 0, unmergedPrCount: 3 },
    });
    expect(view.kind).toBe('awaiting_merge');
    expect(view.derivedFrom.kind).toBe('evaluateMissionWorkState');
    const waiting = gated(view);
    if (waiting.kind !== 'merge') throw new Error('unreachable');
    expect(waiting.count).toBe(3);
  });
});

describe('deriveMissionStateView — self-resolving wait', () => {
  const waitUntil = new Date('2026-01-01T12:00:00.000Z');

  it('carries the reason and the wait-until, and does not read as a stall', () => {
    const view = deriveMissionStateView({
      ...base,
      // deriveTaskHealthSignal would call this STALLED on its own.
      health: 'STALLED',
      openTasks: [{ id: 'task-d', status: 'pending' }],
      wait: { reason: 'reviewer/retry task queued', waitUntil },
    });

    // Ruling 2: the explained wait outranks the stall.
    expect(view.kind).toBe('waiting');
    expect(view.kind).not.toBe('blocked');
    const waiting = gated(view);
    expect(waiting.kind).toBe('self_resolving_wait');
    if (waiting.kind !== 'self_resolving_wait') throw new Error('unreachable');
    expect(waiting.reason).toBe('reviewer/retry task queued');
    expect(waiting.waitUntil).toBe('2026-01-01T12:00:00.000Z');
    expect(waiting.tone).toBe('neutral');
    expect(view.derivedFrom.kind).toBe('classifyMissionWait');
    expect(view.nextAction).toContain('resumes on its own');
  });

  it('reports a heartbeat wait with no known resume time as waiting, not blocked', () => {
    // deriveTaskHealthSignal folds an in-flight heartbeatWaitingUntil into BLOCKED.
    const health = deriveTaskHealthSignal({ heartbeatWaitingUntil: new Date(Date.now() + 60_000) }, []);
    expect(health).toBe('BLOCKED');

    const view = deriveMissionStateView({ ...base, health });
    expect(view.kind).toBe('waiting');
    const waiting = gated(view);
    if (waiting.kind !== 'self_resolving_wait') throw new Error('unreachable');
    expect(waiting.waitUntil).toBeNull();
  });
});

describe('deriveMissionStateView — genuinely idle', () => {
  it('reports idle only when every source had nothing to say', () => {
    const view = deriveMissionStateView({
      ...base,
      criteriaGate: deriveCriteriaGatePresentation({ criteriaCount: 0, overall: null }),
      completion: { ok: true, code: 'ok', reason: 'All deliverables terminal; mission states no goal criteria' },
      wait: null,
      workState: { complete: true, reason: 'complete', unfinishedTaskCount: 0, unmergedPrCount: 0 },
    });

    expect(view.kind).toBe('idle');
    expect(view.waitingOn).toBeNull();
    expect(view.nextAction).toBeNull();
    expect(isGated(view)).toBe(false);
    expect(view.derivedFrom.waitingOn).toBeNull();
  });

  it('keeps the manual chip for a disarmed mission with nothing to do', () => {
    const view = deriveMissionStateView({ ...base, orchestrationMode: 'manual' });
    expect(view.kind).toBe('idle');
    expect(view.displayState).toBe('manual');
  });

  it('does not report idle merely because a source was omitted', () => {
    // No completion, no gate, no wait — but health still says a task is stuck.
    const view = deriveMissionStateView({ ...base, health: 'STALLED' });
    expect(view.kind).not.toBe('idle');
  });
});

describe('deriveMissionStateView — precedence chain', () => {
  it('terminal status outranks every stale blocker', () => {
    const view = deriveMissionStateView({
      ...base,
      status: 'completed',
      health: 'FAILING',
      completion: { ok: false, code: 'criteria_failed', reason: 'x' },
      wait: { reason: 'y', waitUntil: new Date() },
    });
    expect(view.kind).toBe('complete');
    expect(view.waitingOn).toBeNull();
  });

  it('an unmet dependency outranks live agents', () => {
    const view = deriveMissionStateView({
      ...base,
      health: 'BLOCKED',
      dependsOnMissionId: 'mission-upstream',
      activeAgents: 3,
    });
    expect(view.kind).toBe('blocked');
    expect(view.displayState).toBe('blocked');
    const waiting = gated(view);
    if (waiting.kind !== 'dependency') throw new Error('unreachable');
    expect(waiting.missionId).toBe('mission-upstream');
  });

  it('a live agent outranks a failing task and an unverified criterion', () => {
    const view = deriveMissionStateView({
      ...base,
      activeAgents: 1,
      health: 'FAILING',
      criteriaGate: deriveCriteriaGatePresentation({ criteriaCount: 1, overall: null, items: [] }),
    });
    expect(view.kind).toBe('running');
    expect(view.waitingOn).toBeNull();
  });

  it('an escalated gate with no work left outranks a live-agent read of running', () => {
    const view = deriveMissionStateView({
      ...base,
      criteriaEscalatedAt: new Date(),
      hasPendingDeliverableWork: false,
      escalationDetail: 'the criterion is unmeasurable as written',
    });
    expect(view.kind).toBe('awaiting_decision');
    const waiting = gated(view);
    if (waiting.kind !== 'human_decision') throw new Error('unreachable');
    expect(waiting.detail).toBe('the criterion is unmeasurable as written');
    expect(view.derivedFrom.kind).toBe('mission.criteriaEscalatedAt');
  });

  it('does not escalate while deliverable work is still moving', () => {
    const view = deriveMissionStateView({
      ...base,
      criteriaEscalatedAt: new Date(),
      hasPendingDeliverableWork: true,
      health: 'STALLED',
      openTasks: [{ id: 'task-e', status: 'pending' }],
    });
    expect(view.kind).toBe('blocked');
  });

  it('held outranks everything but a closed row', () => {
    const view = deriveMissionStateView({ ...base, isHeld: true, activeAgents: 2, health: 'FAILING' });
    expect(view.kind).toBe('held');
    expect(view.displayState).toBe('held');
  });

  it('infra-stalled failures are reported as such', () => {
    const view = deriveMissionStateView({
      ...base,
      completion: {
        ok: false,
        code: 'infra_stalled',
        reason: '1 deliverable task(s) failed on infrastructure',
        infraStalledTitles: ['Wire the route'],
      },
      failedTasks: [{ id: 'task-f', title: 'Wire the route', infra: true }],
    });
    expect(view.kind).toBe('failing');
    const waiting = gated(view);
    if (waiting.kind !== 'task_failed') throw new Error('unreachable');
    expect(waiting.infra).toBe(true);
    expect(waiting.taskIds).toEqual(['task-f']);
    expect(view.nextAction).toContain('retries are already exhausted');
  });
});

describe('MissionStateView is unforgeable', () => {
  it('rejects a hand-built state object', () => {
    // The brand is not exported, so no call site can satisfy it. If this ever
    // stops being an error, the "one owner" guarantee is gone and tsc says so —
    // @ts-expect-error fails the type-check when the expression compiles.
    // @ts-expect-error — MissionStateView is constructible only by deriveMissionStateView
    const forged: MissionStateView = {
      kind: 'idle',
      waitingOn: null,
      nextAction: null,
      chip: { label: 'AUTO', cls: '' },
      displayState: 'active',
      criteriaBlockingReason: null,
      derivedFrom: { kind: 'mission.status', waitingOn: null, nextAction: null },
    };
    expect(forged.kind).toBe('idle');
  });

  it('will not let a blocked mission claim waitingOn is null', () => {
    const view = deriveMissionStateView({ ...base, health: 'STALLED', openTasks: [{ id: 't', status: 'pending' }] });
    // Narrowing on kind proves the compiler knows a gated variant carries a
    // blocker: this branch cannot be reached with waitingOn === null.
    if (view.kind === 'idle' || view.kind === 'complete' || view.kind === 'running') {
      throw new Error('a stalled mission must not narrow to a quiet variant');
    }
    expect(view.waitingOn.kind).toBe('task');
  });
});

describe('MissionStateView invariants', () => {
  const cases: Array<[string, MissionStateInput]> = [
    ['complete', { ...base, status: 'completed' }],
    ['idle', base],
    ['running', { ...base, activeAgents: 1 }],
    ['held', { ...base, isHeld: true }],
    ['blocked-dependency', { ...base, health: 'BLOCKED', dependsOnMissionId: 'm' }],
    ['blocked-task', { ...base, health: 'STALLED', openTasks: [{ id: 't', status: 'pending' }] }],
    ['waiting', { ...base, wait: { reason: 'r', waitUntil: new Date() } }],
    ['awaiting_merge', { ...base, workState: { complete: false, reason: 'prs_unmerged', unfinishedTaskCount: 0, unmergedPrCount: 1 } }],
    ['awaiting_verification', { ...base, completion: { ok: false, code: 'criteria_unverified', reason: 'r' } }],
    ['awaiting_decision', { ...base, criteriaEscalatedAt: new Date(), hasPendingDeliverableWork: false }],
    ['failing', { ...base, health: 'FAILING', failedTasks: [{ id: 't', title: 'x' }] }],
  ];

  it('gives every gated state a non-null blocker and a non-null next action', () => {
    for (const [name, input] of cases) {
      const view = deriveMissionStateView(input);
      const quiet = view.kind === 'complete' || view.kind === 'idle' || view.kind === 'running';
      if (quiet) {
        expect(view.waitingOn).toBeNull();
      } else {
        expect(view.waitingOn, `${name} must carry a blocker`).not.toBeNull();
        expect(view.nextAction, `${name} must say what would unblock it`).toBeTruthy();
      }
    }
  });

  it('labels the source of every answer it gives', () => {
    for (const [name, input] of cases) {
      const view = deriveMissionStateView(input);
      expect(view.derivedFrom.kind, `${name} must name its source`).toBeTruthy();
      expect(view.derivedFrom.waitingOn === null).toBe(view.waitingOn === null);
      expect(view.derivedFrom.nextAction === null).toBe(view.nextAction === null);
    }
  });

  it('always renders a chip', () => {
    for (const [name, input] of cases) {
      const view = deriveMissionStateView(input);
      expect(view.chip.label, `${name} must have a chip label`).toBeTruthy();
      expect(view.chip.cls, `${name} must have chip classes`).toBeTruthy();
    }
  });

  it('produces a next action for every descriptor kind', () => {
    const descriptors: WaitingOnDescriptor[] = [
      { kind: 'dependency', tone: 'warning', label: 'l', missionId: 'm' },
      { kind: 'task', tone: 'warning', label: 'l', count: 1, taskIds: [], byStatus: {} },
      { kind: 'task_failed', tone: 'error', label: 'l', infra: false, taskIds: [], titles: [] },
      { kind: 'merge', tone: 'warning', label: 'l', count: 1, prNumbers: [], taskIds: [], missionPr: false },
      { kind: 'criterion_failing', tone: 'warning', label: 'l', count: 1, criteria: [], refused: false },
      { kind: 'criterion_unverified', tone: 'neutral', label: 'l', count: 1, criteria: [] },
      { kind: 'human_decision', tone: 'warning', label: 'l', detail: null },
      { kind: 'self_resolving_wait', tone: 'neutral', label: 'l', reason: 'r', waitUntil: null },
    ];
    for (const d of descriptors) {
      expect(nextActionFor(d), `${d.kind} must have a next action`).toBeTruthy();
    }
  });
});
