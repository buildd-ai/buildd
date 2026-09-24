/**
 * The mission card model (docs/design/mission-feed-mobile-continuity.md, W1,
 * S5, AC-14, addendum D2/D7/D8). Fixtures are illustrative.
 */
import { describe, expect, it } from 'bun:test';
import {
  blockedByPRTaskIds,
  buildMissionCardView,
  compactCardLine,
  countActiveMissions,
  countLiveWorkers,
  latestWorker,
  missionCardGroup,
  summarizeMissionForCard,
  type MissionCardRow,
  type MissionCardTaskRow,
} from './mission-card-view';
import { deriveMissionStateView } from './mission-state-view';

// deriveMissionHealth reads the wall clock, so "now" is the real now.
const NOW = Date.now();
let clock = Date.UTC(2026, 0, 1);
function task(id: string, over: Partial<MissionCardTaskRow> = {}): MissionCardTaskRow {
  clock += 60_000;
  return { id, title: `Task ${id}`, status: 'pending', taskClass: 'work', createdAt: new Date(clock), workers: [], ...over };
}
function mission(over: Partial<MissionCardRow> = {}): MissionCardRow {
  return { id: 'm1', title: 'Claim loop hardening', status: 'active', isHeld: false, tasks: [], ...over };
}

describe('countLiveWorkers (AC-14: waiting_input is live)', () => {
  it('counts every LIVE_WORKER_STATUSES worker, including waiting_input', () => {
    const tasks = [
      task('a', { status: 'in_progress', workers: [{ status: 'running' }] }),
      task('b', { status: 'in_progress', workers: [{ status: 'waiting_input' }] }),
      task('c', { status: 'completed', workers: [{ status: 'completed' }] }),
    ];
    expect(countLiveWorkers(tasks)).toBe(2);
  });
});

describe('missionCardGroup (healthToGroup, §1.1)', () => {
  it('an active mission with live agents and progress < 100 is running, not attention', () => {
    const row = mission({
      tasks: [task('a', { status: 'in_progress', workers: [{ status: 'running' }] }), task('b')],
    });
    const s = summarizeMissionForCard(row, { now: NOW });
    expect(s.progress).toBeLessThan(100);
    expect(s.liveWorkers).toBe(1);
    expect(s.group).toBe('running');
  });

  it('a mission waiting on the user is running (live) and so counts as active (D8)', () => {
    const row = mission({ tasks: [task('a', { status: 'in_progress', workers: [{ status: 'waiting_input' }] })] });
    const s = summarizeMissionForCard(row, { now: NOW });
    expect(s.group).toBe('running');
    expect(countActiveMissions([s.group])).toBe(1);
  });

  it('terminal missions are completed whatever their health reads', () => {
    for (const status of ['completed', 'archived', 'cancelled']) {
      expect(missionCardGroup({ status, health: 'idle', progress: 40 })).toBe('completed');
    }
  });

  it('a future start gate is scheduled unless agents are already running', () => {
    const later = new Date(NOW + 3_600_000);
    expect(missionCardGroup({ status: 'active', health: 'idle', progress: 0, startAt: later, now: NOW })).toBe('scheduled');
    expect(missionCardGroup({ status: 'active', health: 'active', progress: 0, startAt: later, now: NOW })).toBe('running');
  });

  it('an idle mission at 100% awaits review; below 100% needs attention', () => {
    expect(missionCardGroup({ status: 'active', health: 'idle', progress: 100 })).toBe('review');
    expect(missionCardGroup({ status: 'active', health: 'idle', progress: 50 })).toBe('attention');
  });
});

describe('countActiveMissions (D8: the header counts what the cards group)', () => {
  it('counts running, attention and review; not scheduled, paused or completed', () => {
    expect(countActiveMissions(['running', 'attention', 'review', 'scheduled', 'paused', 'completed'])).toBe(3);
  });
});

describe('summarizeMissionForCard: schedule timing', () => {
  it('clears a concurrent-cap deferral the schedule is no longer over', () => {
    const row = mission({
      schedule: { id: 's1', lastDeferralReason: 'concurrent_cap', maxConcurrentFromSchedule: 2 },
      tasks: [task('a', { scheduleId: 's1', status: 'pending' })],
    });
    expect(summarizeMissionForCard(row, { now: NOW }).lastDeferralReason).toBeNull();
  });

  it('uses the earliest user-scheduled task start when there is no schedule', () => {
    const at = new Date(NOW + 30 * 60_000);
    const row = mission({ tasks: [task('a', { startAt: at, loopIteration: 0 })] });
    const s = summarizeMissionForCard(row, { now: NOW });
    expect(s.nextRunAt).toBe(at.toISOString());
    expect(s.nextScanMins).toBe(30);
    expect(s.group).toBe('scheduled');
  });
});

describe('latestWorker', () => {
  it('reads the newest worker by start, not array order', () => {
    const w = latestWorker([
      { status: 'failed', startedAt: new Date(1000) },
      { status: 'running', startedAt: new Date(5000) },
      { status: 'completed', startedAt: new Date(3000) },
    ]);
    expect(w?.status).toBe('running');
  });
});

describe('blockedByPRTaskIds', () => {
  it('lists pending tasks whose dependency has an open PR on any worker, once each', () => {
    const dep = task('dep', { status: 'completed', workers: [{ status: 'completed', prNumber: 12 }] });
    const merged = task('merged', { status: 'completed', workers: [{ status: 'completed', prNumber: 13, mergedAt: new Date() }] });
    const tasks = [
      dep,
      merged,
      task('x', { dependsOn: ['dep', 'merged'] }),
      task('y', { dependsOn: ['merged'] }),
      task('z', { status: 'in_progress', dependsOn: ['dep'] }),
    ];
    const index = new Map(tasks.map(t => [t.id, t]));
    expect(blockedByPRTaskIds(tasks, index)).toEqual(['x']);
  });
});

describe('buildMissionCardView', () => {
  const BUILD = { missionPhaseIndex: 1, missionPhaseLabel: 'BUILD' };
  const THINK = { missionPhaseIndex: 0, missionPhaseLabel: 'THINK' };

  it('carries the detail header chip and situation from the same accessor (D2)', () => {
    const row = mission({ tasks: [task('a', { status: 'in_progress', workers: [{ status: 'running' }] })] });
    const view = buildMissionCardView(row, { from: 'home', now: NOW });
    const s = summarizeMissionForCard(row, { now: NOW });
    const detail = deriveMissionStateView({
      status: 'active', isHeld: false, activeAgents: s.liveWorkers, progress: s.progress, health: s.healthState,
      hasPendingDeliverableWork: s.hasPendingDeliverableWork,
      openTasks: [{ id: 'a', status: 'in_progress', title: 'Task a' }],
    });
    expect(view.chip).toEqual(detail.chip);
    expect(view.situation.headline).toBe(detail.situation.headline);
  });

  it('a stalled mission reads STALLED on the card', () => {
    const row = mission({ tasks: [task('a', { status: 'pending' })] });
    const view = buildMissionCardView(row, { from: 'missions', now: NOW });
    expect(view.chip.label).toBe('STALLED');
  });

  it('the pulse is one segment per deliverable in phase order; attempts are not segments', () => {
    const row = mission({
      tasks: [
        task('b1', { ...BUILD, status: 'completed' }),
        task('t1', { ...THINK, status: 'completed' }),
        task('r1', { taskClass: 'attempt', parentTaskId: 'b1', status: 'failed' }),
        task('b2', { ...BUILD }),
      ],
    });
    const view = buildMissionCardView(row, { from: 'home', now: NOW });
    expect(view.segments.map(s => s.taskId)).toEqual(['t1', 'b1', 'b2']);
    expect(view.caption).toBe('2/3');
    expect(view.total).toBe(3);
  });

  it('the caption counts live workers, including one waiting on the user', () => {
    const row = mission({
      tasks: [
        task('a', { status: 'in_progress', workers: [{ status: 'waiting_input' }] }),
        task('b', { status: 'in_progress', workers: [{ status: 'running' }] }),
      ],
    });
    expect(buildMissionCardView(row, { from: 'home', now: NOW }).caption).toBe('0/2 · 2 live');
  });

  it('primary line: the top NEEDS YOU task, opened as the sheet over the mission', () => {
    const row = mission({
      tasks: [
        task('run', { status: 'in_progress', workers: [{ status: 'running', startedAt: new Date(NOW - 60_000) }] }),
        task('ask', { title: 'Lease shadow mode', status: 'in_progress', workers: [{ status: 'waiting_input' }] }),
      ],
    });
    const view = buildMissionCardView(row, { from: 'home', now: NOW });
    expect(view.primary).toEqual({
      kind: 'needs_you', taskId: 'ask', label: 'Answer: Lease shadow mode',
      href: '/app/missions/m1?from=home&task=ask',
    });
  });

  it('primary line: the top MOVING task when nothing needs the user', () => {
    const row = mission({
      tasks: [task('run', { title: 'Heartbeat renew', status: 'in_progress', workers: [{ status: 'running' }] })],
    });
    const view = buildMissionCardView(row, { from: 'missions', now: NOW });
    expect(view.primary?.kind).toBe('moving');
    expect(view.primary?.label).toBe('Heartbeat renew · running');
    expect(view.primary?.href).toBe('/app/missions/m1?from=missions&task=run');
  });

  it('primary line: a cross-mission blocked-on-PR task links to that task, not to Home', () => {
    const dep = task('dep', { status: 'completed', workers: [{ status: 'completed', prNumber: 7 }] });
    const row = mission({ tasks: [task('wait', { dependsOn: ['dep'] })] });
    const index = new Map([[dep.id, dep], ...row.tasks!.map(t => [t.id, t] as const)]);
    const view = buildMissionCardView(row, { from: 'home', now: NOW, taskIndex: index });
    expect(view.primary).toEqual({
      kind: 'blocked_pr', taskId: 'wait', label: 'Blocked on 1 PR', href: '/app/missions/m1?from=home&task=wait',
    });
  });

  it('the card body links to the mission with its origin', () => {
    expect(buildMissionCardView(mission(), { from: 'home', now: NOW }).href).toBe('/app/missions/m1?from=home');
  });

  it('a completed mission is compact with no primary line and no strip (D7)', () => {
    const row = mission({
      status: 'completed', completedAt: new Date(NOW - 86_400_000),
      tasks: [task('a', { status: 'completed' }), task('b', { status: 'completed' })],
    });
    const strip = { bars: [{}], rail: { marks: [] } } as any;
    const view = buildMissionCardView(row, { from: 'missions', now: NOW, flightStrip: strip });
    expect(view.compact).toBe(true);
    expect(view.primary).toBeNull();
    expect(view.flightStrip).toBeNull();
    expect(compactCardLine(view, () => '1d ago')).toBe('Completed 1d ago · 2/2');
  });

  it('keeps the flight strip only when it has something to draw', () => {
    const row = mission({ tasks: [task('a', { status: 'in_progress', workers: [{ status: 'running' }] })] });
    const empty = { bars: [], rail: { marks: [] } } as any;
    const drawn = { bars: [{ taskId: 'a' }], rail: { marks: [] } } as any;
    expect(buildMissionCardView(row, { from: 'home', flightStrip: empty }).flightStrip).toBeNull();
    expect(buildMissionCardView(row, { from: 'home', flightStrip: drawn }).flightStrip).toBe(drawn);
  });

  it('a completed mission never shows a verification neighbour: one chip only (D2)', () => {
    const row = mission({
      status: 'completed', goalCriteria: [{ type: 'x' }], goalCriteriaState: { overall: 'UNVERIFIED', criteria: [] },
      tasks: [task('a', { status: 'completed' })],
    });
    expect(buildMissionCardView(row, { from: 'missions' }).chip.label).toBe('COMPLETE');
  });
});
