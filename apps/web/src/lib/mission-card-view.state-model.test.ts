/**
 * The card's state model after the desktop review: a mission waiting on you is
 * active (F1), one count definition across the caption, the pulse and the
 * summary (F3), and no "0/0" caption on a mission with no work (F7a).
 * Fixtures are illustrative.
 */
import { describe, expect, it } from 'bun:test';
import {
  buildMissionCardView,
  countActiveMissions,
  summarizeMissionForCard,
  type MissionCardRow,
  type MissionCardTaskRow,
} from './mission-card-view';
import { pulseDoneCounts } from './mission-pulse';
import { situationDetail } from './mission-state-view';

const NOW = Date.now();
let clock = Date.UTC(2026, 0, 1);
function task(id: string, over: Partial<MissionCardTaskRow> = {}): MissionCardTaskRow {
  clock += 60_000;
  return { id, title: `Task ${id}`, status: 'pending', taskClass: 'work', createdAt: new Date(clock), workers: [], ...over };
}
function mission(over: Partial<MissionCardRow> = {}): MissionCardRow {
  return { id: 'm1', title: 'Claim loop hardening', status: 'active', isHeld: false, tasks: [], ...over };
}

/** A stored `no open tasks` fail, from an evaluation that ran while work was open. */
const failingNoOpenTasks = {
  goalCriteria: [{ type: 'no_open_tasks', label: 'no open tasks' }],
  goalCriteriaState: {
    overall: 'fail',
    criteria: [{ verdict: 'fail', type: 'no_open_tasks', label: 'no open tasks', evidence: '2 task(s) still open: pending, pending' }],
  },
};

const view = (row: MissionCardRow) => buildMissionCardView(row, { from: 'missions', now: NOW });

describe('F1: waiting on you is active, whatever the health says', () => {
  const doneWork = () => [
    task('a', { status: 'completed' }),
    task('b', { status: 'completed' }),
    task('c', { status: 'cancelled' }),
    task('orch', { status: 'failed', taskClass: 'bookkeeping', title: 'Mission: Claim loop hardening' }),
  ];

  it('a paused (not held) mission AWAITING VERIFICATION groups as attention and counts as active', () => {
    const row = mission({ status: 'paused', tasks: doneWork(), ...failingNoOpenTasks });
    const v = view(row);
    const s = summarizeMissionForCard(row, { now: NOW });
    expect(v.chip.label).toBe('AWAITING VERIFICATION');
    expect(v.group).toBe('attention');
    expect(s.group).toBe('attention');
    expect(countActiveMissions([v.group])).toBe(1);
  });

  it('a mission on a heartbeat schedule that is waiting on you is not SCHEDULED', () => {
    const row = mission({
      tasks: doneWork(),
      ...failingNoOpenTasks,
      schedule: { id: 's1', cronExpression: '0 * * * *', nextRunAt: new Date(NOW + 30 * 60_000), lastRunAt: new Date(NOW - 30 * 60_000) },
    });
    expect(summarizeMissionForCard(row, { now: NOW }).group).toBe('attention');
  });

  it('a held mission with an unmerged PR needs you beyond arming → active', () => {
    const row = mission({
      isHeld: true,
      tasks: [task('a', { status: 'completed', workers: [{ status: 'completed', prUrl: 'https://example.test/pr/5', prNumber: 5 }] })],
    });
    const s = summarizeMissionForCard(row, { now: NOW });
    expect(['attention', 'review']).toContain(s.group);
    expect(countActiveMissions([s.group])).toBe(1);
  });

  it('a held mission whose only ask is arming stays PAUSED / HELD', () => {
    const row = mission({ isHeld: true, tasks: [task('a'), task('b')] });
    expect(summarizeMissionForCard(row, { now: NOW }).group).toBe('paused');
  });

  it('the summary carries the same state the card renders (one derivation)', () => {
    const row = mission({ status: 'paused', tasks: doneWork(), ...failingNoOpenTasks });
    const s = summarizeMissionForCard(row, { now: NOW });
    expect(s.state.chip).toEqual(view(row).chip);
    expect(s.state.situation.headline).toBe(view(row).situation.headline);
  });

  it('the stale verdict reads as stale on the card: nothing is open now', () => {
    const v = view(mission({ status: 'paused', tasks: doneWork(), ...failingNoOpenTasks }));
    expect(v.situation.headline).toContain('no task is open.');
  });
});

describe('F3: one count definition', () => {
  const tasks = () => [
    task('a', { status: 'completed' }),
    task('b', { status: 'completed', workers: [{ status: 'completed', prUrl: 'https://example.test/pr/9', prNumber: 9, mergedAt: new Date(NOW - 1000) }] }),
    task('c'),
    task('d', { status: 'cancelled' }),
    task('e', { status: 'failed' }),
    task('r', { status: 'completed', taskClass: 'attempt', parentTaskId: 'e', title: '[reviewer] Task e' }),
    task('orch', { status: 'completed', taskClass: 'bookkeeping', title: 'Mission: Claim loop hardening' }),
  ];

  it('cancelled tasks are not in N; attempts and bookkeeping are not rows', () => {
    const v = view(mission({ tasks: tasks() }));
    expect(v.total).toBe(4);
    expect(v.done).toBe(2);
    expect(v.caption).toBe('2/4');
  });

  it('the caption, the pulse and the summary agree', () => {
    const row = mission({ tasks: tasks() });
    const v = view(row);
    const s = summarizeMissionForCard(row, { now: NOW });
    expect(pulseDoneCounts(v.segments)).toEqual({ done: v.done, total: v.total });
    expect({ done: s.completedTasks, total: s.totalTasks }).toEqual({ done: v.done, total: v.total });
    expect(s.progress).toBe(50);
  });

  it('a cancelled row is still drawn, as skipped — never as queued', () => {
    const v = view(mission({ tasks: tasks() }));
    expect(v.segments.find(seg => seg.taskId === 'd')?.state).toBe('skipped');
  });
});

describe('F7a: no "0/0" caption', () => {
  it('a mission with no work tasks has an empty caption', () => {
    expect(view(mission({ tasks: [] })).caption).toBe('');
    expect(view(mission({
      tasks: [task('orch', { status: 'completed', taskClass: 'bookkeeping', title: 'Mission: Claim loop hardening' })],
    })).caption).toBe('');
  });

  it('only cancelled work also reads as no work', () => {
    expect(view(mission({ tasks: [task('a', { status: 'cancelled' })] })).caption).toBe('');
  });
});

describe('F1: a paused mission whose open tasks stalled under a failing criterion needs you', () => {
  // Two pending work tasks and no live worker: task health reads STALLED, so
  // the precedence verdict is `blocked` — but the situation still says the
  // failing "no open tasks" is the owner's to clear.
  const stalledRow = () => mission({
    status: 'paused',
    tasks: [task('a', { status: 'completed' }), task('b', { title: 'Wire the claim route' }), task('c', { title: 'Backfill the column' })],
    ...failingNoOpenTasks,
  });

  it('groups as attention, not PAUSED / HELD, and counts as active', () => {
    const s = summarizeMissionForCard(stalledRow(), { now: NOW });
    expect(s.healthState).toBe('STALLED');
    expect(s.state.situation.focus?.kind).toBe('criterion_failing');
    expect(s.group).toBe('attention');
    expect(countActiveMissions([s.group])).toBe(1);
  });

  it('the situation names the blockers through the real derivation', () => {
    const v = view(stalledRow());
    const detail = situationDetail(v.situation, []);
    expect(detail?.kind).toBe('blockers');
    if (detail?.kind !== 'blockers') throw new Error('unreachable');
    expect(detail.items.map(b => b.taskId)).toEqual(['b', 'c']);
    expect(detail.items[0].status).toBe('queued');
  });

  it('a held mission in the same shape stays PAUSED / HELD (arming is a start)', () => {
    expect(summarizeMissionForCard({ ...stalledRow(), status: 'active', isHeld: true }, { now: NOW }).group).toBe('paused');
  });
});

describe('F3: a plan that shipped a PR is the deliverable (orchestrator-only missions)', () => {
  const planRow = () => mission({
    tasks: [task('plan', {
      status: 'completed', taskClass: 'bookkeeping', mode: 'planning', title: 'Plan the rollout',
      workers: [{ status: 'completed', prUrl: 'https://example.test/pr/3', prNumber: 3, mergedAt: new Date(NOW - 1000) }],
    })],
  });

  it('counts as 1/1 and groups as review, like computeMissionProgress', () => {
    const row = planRow();
    const s = summarizeMissionForCard(row, { now: NOW });
    expect({ done: s.completedTasks, total: s.totalTasks, progress: s.progress }).toEqual({ done: 1, total: 1, progress: 100 });
    expect(s.group).toBe('review');
    expect(view(row).caption).toBe('1/1');
  });

  it('a planning task with no PR is still bookkeeping', () => {
    const row = mission({ tasks: [task('plan', { status: 'completed', taskClass: 'bookkeeping', mode: 'planning', title: 'Plan the rollout' })] });
    expect(summarizeMissionForCard(row, { now: NOW }).totalTasks).toBe(0);
  });
});

describe('the situation copy agrees with the grouping while work is in flight', () => {
  it('a running mission with a failing "no open tasks" does not say "waiting on you"', () => {
    const row = mission({
      tasks: [task('a', { status: 'in_progress', workers: [{ status: 'running', startedAt: new Date(NOW - 60_000) }] }), task('b')],
      ...failingNoOpenTasks,
    });
    const s = summarizeMissionForCard(row, { now: NOW });
    expect(s.state.kind).toBe('running');
    expect(s.group).toBe('running');
    expect(s.state.situation.headline).toMatch(/^Running \(1 agent\)/);
    expect(s.state.situation.headline).not.toMatch(/waiting on you/i);
    expect(s.state.situation.headline).toContain('"no open tasks"');
  });
});
