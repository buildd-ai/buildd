import { describe, expect, it } from 'bun:test';
import { dagBoard, dagId, DAG_SPECS, overviewWavesBoard, overviewWavesInput } from '@/app/app/dev/fixtures/mission-task-strip-fixtures';
import { buildMissionBoard, lastEventOf } from './mission-board';
import { stripOrder } from './mission-task-strip';
import { formatCountdown, overviewStatus, overviewStatusText, retryText, RETRY_NOW } from './mission-overview';
import { finishSettingTaskId, overviewCells, overviewWaitLine, overviewCounts, overviewDefaultSelection, overviewLayout, overviewLegend, overviewProgress, overviewSelection, overviewWaitCause } from './mission-overview';

const spec = DAG_SPECS.linear; // A landed, B running, C blocked, D/E queued
const model = dagBoard(spec);
const order = stripOrder(model);

describe('finishSettingTaskId', () => {
  it('is the first task in flight, not the first task', () => {
    expect(finishSettingTaskId(model)).toBe(dagId(spec, 'B'));
    expect(finishSettingTaskId(model)).not.toBe(order[0]);
  });

  it('falls to the first held task when nothing is in flight, and the last when all landed', () => {
    const fanIn = dagBoard(DAG_SPECS['fan-in']);
    expect(finishSettingTaskId(fanIn)).toBeTruthy();
    expect(finishSettingTaskId({ phases: [], tasks: {} })).toBeNull();
  });
});

describe('overviewCells', () => {
  it('is one cell per task in strip order, ticked by position', () => {
    const cells = overviewCells(model);
    expect(cells.map(c => c.id)).toEqual(order);
    expect(cells.map(c => c.tick)).toEqual(['01', '02', '03', '04', '05']);
    expect(cells.map(c => c.state)).toEqual(['landed', 'running', 'blocked', 'queued', 'queued']);
  });
});

describe('overviewProgress', () => {
  // buildd top's progress row (spec c7410e76 R-29): the page's own cells and groups, nothing re-derived.
  it('is the Overview strip: its cells in its order, each tagged with its group', () => {
    const layout = overviewLayout(model);
    const cells = overviewCells(model, layout.order);
    const progress = overviewProgress(model);
    expect(progress.map(c => c.state)).toEqual(cells.map(c => c.state));
    expect(progress.map(c => c.group)).toEqual(layout.groups.flatMap(g => g.ids.map(() => g.key)));
    expect(progress).toEqual([
      { state: 'landed', group: 'done' },
      { state: 'running', group: 'active' },
      { state: 'blocked', group: 'waiting' },
      { state: 'queued', group: 'waiting' },
      { state: 'queued', group: 'waiting' },
    ]);
  });

  it('is empty for a mission with no tasks', () => {
    expect(overviewProgress({ phases: [], tasks: {} })).toEqual([]);
  });
});

describe('overviewSelection', () => {
  it('a running task marks and names what it unblocks', () => {
    const s = overviewSelection(model, order, dagId(spec, 'B'));
    expect(s.marks.get(dagId(spec, 'C'))).toBe('direct');
    expect(s.reason).toEqual({ lead: 'Unblocks', text: '03 (+2 downstream).' });
  });

  it('a held task names what it waits behind, frontier first', () => {
    const s = overviewSelection(model, order, dagId(spec, 'E'));
    expect(s.reason?.lead).toBe('After');
    expect(s.reason?.text).toBe('04 D (+2 upstream).');
  });

  it('a landed task marks nothing', () => {
    const s = overviewSelection(model, order, dagId(spec, 'A'));
    expect(s.marks.size).toBe(0);
    expect(s.reason).toBeNull();
  });
});

describe('overviewCounts', () => {
  // "Landed" counts every finished task, PR or not; the PRs merged criterion
  // counts only PR-bearing tasks. Calling both "merged" put two different
  // merged counts on one screen (task fc1f5a94).
  it('prints landed (not merged), then criteria when there are any', () => {
    expect(overviewCounts({ landed: { done: 2, total: 7 }, criteria: [], criteriaPassed: 0 } as never)).toBe('2 of 7 done');
    expect(overviewCounts({ landed: { done: 2, total: 7 }, criteria: [{}, {}, {}, {}], criteriaPassed: 1 } as never)).toBe('2 of 7 done · 1 of 4 criteria');
    expect(overviewCounts({ landed: { done: 2, total: 7 }, criteria: [{}, {}, {}, {}], criteriaPassed: 1 } as never, { criteria: false })).toBe('2 of 7 done');
    expect(overviewCounts({ landed: { done: 0, total: 0 }, criteria: [], criteriaPassed: 0 } as never)).toBe('No tasks');
  });
});

// Spec f7f67f1a R-1, R-5, R-6, R-9 (revision 6).
describe('overviewLayout', () => {
  const ten = overviewWavesBoard(10);
  const layout = overviewLayout(ten);
  const groupOf = (id: string) => layout.groups.find(g => g.ids.includes(id))?.key;

  it('puts Done, In progress and Waiting in that order, then checks', () => {
    expect(layout.groups.map(g => g.key)).toEqual(['done', 'active', 'waiting', 'checks']);
    expect(layout.order).toEqual(layout.groups.flatMap(g => g.ids));
  });

  it('keeps strip order inside each group', () => {
    const strip = stripOrder(ten);
    for (const g of layout.groups) {
      const positions = g.ids.map(id => strip.indexOf(id));
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    }
  });

  it('keeps audit, fix and refresh rows out of the build groups', () => {
    const audit = Object.values(ten.tasks).find(t => t.deliverableRole !== 'build')!;
    expect(groupOf(audit.id)).toBe('checks');
    const build = layout.groups.filter(g => g.key !== 'checks').flatMap(g => g.ids);
    expect(build.every(id => ten.tasks[id].deliverableRole === 'build')).toBe(true);
  });

  it('moves a task to Done when it lands; nothing else changes group', () => {
    const { tasks, gateFacts } = overviewWavesInput(10);
    const running = layout.groups.find(g => g.key === 'active')!.ids[0];
    const merged = { status: 'completed', prNumber: 900, prUrl: 'https://github.com/example/app/pull/900', prLifecycleStatus: 'merged' };
    const landedTasks = tasks.map(t => (t.id === running
      ? { ...t, status: 'completed', workers: [{ ...t.workers![0], ...merged, mergedAt: Date.now() }], worker: { ...t.worker!, ...merged, mergedAt: new Date() } }
      : t));
    const after = overviewLayout(buildMissionBoard({ now: ten.now, missionCreatedAt: 0, missionStatus: 'active', tasks: landedTasks as never, gateFacts }));
    expect(after.groups.find(g => g.key === 'done')!.ids).toContain(running);
    expect(after.groups.find(g => g.key === 'active')!.ids).not.toContain(running);
  });

  it('leaves out an empty group', () => {
    const two = overviewLayout(overviewWavesBoard(2));
    expect(two.groups.map(g => g.key)).toEqual(['done', 'active']);
  });
});

describe('overviewWaitCause', () => {
  const { kinds } = overviewWavesInput(20);
  const ten = overviewWavesBoard(20);

  it('tells waiting on tasks, next in line, held and unknown apart', () => {
    for (const [id, kind] of Object.entries(kinds)) {
      const expected = { dep: 'tasks', slot: 'slot', hold: 'hold', unknown: 'unknown' }[kind];
      expect(overviewWaitCause(ten, id)).toBe(expected);
    }
  });

  it('never calls an unknown cause an unmet dependency', () => {
    const unknown = Object.entries(kinds).filter(([, k]) => k === 'unknown').map(([id]) => id);
    expect(unknown.length).toBeGreaterThan(0);
    for (const id of unknown) expect(overviewWaitCause(ten, id)).not.toBe('tasks');
  });

  it('is null for work that is not waiting', () => {
    const active = Object.values(ten.tasks).filter(t => t.status === 'running' || t.status === 'merged' || t.status === 'done');
    for (const t of active) expect(overviewWaitCause(ten, t.id)).toBeNull();
  });

  it('falls back on the strip when no waiting facts were loaded', () => {
    const bare = buildMissionBoard({ now: ten.now, missionCreatedAt: 0, missionStatus: 'active', tasks: overviewWavesInput(20).tasks });
    const dep = Object.entries(kinds).find(([, k]) => k === 'dep')![0];
    expect(overviewWaitCause(bare, dep)).toBe('tasks');
    const free = Object.entries(kinds).find(([, k]) => k === 'hold')![0];
    expect(overviewWaitCause(bare, free)).toBe('slot');
  });
});

describe('overviewLegend', () => {
  it('says each group in words, waiting split by cause', () => {
    const ten = overviewWavesBoard(20);
    expect(overviewLegend(ten, overviewLayout(ten)).map(e => e.text)).toEqual(['10 done', '2 in progress', '4 waiting on tasks', '2 next in line', '1 blocked', '1 not started', '1 check']);
  });

  it('drops a cause nothing has', () => {
    const two = overviewWavesBoard(2);
    expect(overviewLegend(two, overviewLayout(two)).map(e => e.text)).toEqual(['1 done', '1 in progress']);
  });
});

describe('overviewCells', () => {
  it('names a waiting cell by its cause', () => {
    const ten = overviewWavesBoard(20);
    const layout = overviewLayout(ten);
    const cells = overviewCells(ten, layout.order);
    const held = cells.find(c => c.wait === 'hold')!;
    // A hold names its cause from the terms catalog (here a mission budget), never "Held".
    expect(held.word).toBe('Budget reached');
    expect(cells.find(c => c.wait === 'tasks')!.word).toBe('Waiting on tasks');
    expect(cells.find(c => c.wait === 'slot')!.word).toBe('Next in line');
    expect(cells.find(c => c.wait === 'unknown')!.word).toBe('Waiting');
    expect(cells.filter(c => !c.wait).every(c => c.word === undefined)).toBe(true);
  });
});

describe('overviewDefaultSelection', () => {
  const ten = overviewWavesBoard(10);
  const layout = overviewLayout(ten);

  it('keeps the chosen task through a regroup', () => {
    const chosen = layout.order[layout.order.length - 1];
    expect(overviewDefaultSelection(ten, layout.order, chosen, null)).toBe(chosen);
  });

  it('opens on the task a hold names, before the task in flight', () => {
    const held = layout.groups.find(g => g.key === 'waiting')!.ids[0];
    expect(overviewDefaultSelection(ten, layout.order, null, held)).toBe(held);
  });

  it('otherwise opens on the first task in flight', () => {
    expect(overviewDefaultSelection(ten, layout.order, null, null)).toBe(layout.groups.find(g => g.key === 'active')!.ids[0]);
  });

  it('ignores a chosen or held id that is not on the strip', () => {
    expect(overviewDefaultSelection(ten, layout.order, 'gone', 'gone')).toBe(layout.groups.find(g => g.key === 'active')!.ids[0]);
  });
});

// R-2: the kernel's tone map files a closed, unmerged delivery as finished (S17);
// the Overview never puts it in Done.
describe('a kernel-owned PR closed without merging', () => {
  const { tasks, gateFacts } = overviewWavesInput(10);
  const closedId = tasks[0].id;
  const closed = tasks.map(t => (t.id === closedId
    ? { ...t, delivery: { stage: 'closed', state: 'CLOSED_UNMERGED', headline: 'Closed', owner: 'system' } }
    : t));
  const superseded = tasks.map(t => (t.id === closedId
    ? { ...t, delivery: { stage: 'superseded', state: 'SUPERSEDED', headline: 'Shipped elsewhere', owner: 'system' } }
    : t));
  const board = (rows: unknown[]) => buildMissionBoard({ now: 0, missionCreatedAt: 0, missionStatus: 'active', tasks: rows as never, gateFacts });

  it('sits in Waiting, says it closed without merging, and is not green', () => {
    const m = board(closed);
    expect(m.tasks[closedId].status).toBe('done');
    const layout = overviewLayout(m);
    expect(layout.groups.find(g => g.key === 'done')!.ids).not.toContain(closedId);
    expect(layout.groups.find(g => g.key === 'waiting')!.ids).toContain(closedId);
    expect(overviewWaitCause(m, closedId)).toBe('closed');
    const cell = overviewCells(m, layout.order).find(c => c.id === closedId)!;
    expect(cell.state).toBe('not_landed');
    expect(cell.word).toBe('Closed without merging');
    expect(overviewLegend(m, layout).map(e => e.text)).toContain('1 closed without merging');
  });

  it('a replacement someone named reads Closed → #N on its cell, linked from the task', () => {
    const named = closed.map(t => (t.id === closedId
      ? { ...t, workers: [{ ...t.workers![0], prNumber: 401, namedReplacementPrNumber: 812, namedReplacementPrUrl: 'https://github.com/example/app/pull/812' }] }
      : t));
    const m = board(named);
    expect(overviewCells(m, overviewLayout(m).order).find(c => c.id === closedId)!.word).toBe('Closed → #812');
    const st = overviewStatus(m, closedId);
    expect(st).toMatchObject({ word: 'Closed', tone: 'q' });
    expect(st.closed?.replacement).toEqual({ number: 812, url: 'https://github.com/example/app/pull/812' });
    expect(m.tasks[closedId].prWorkerId).toBe(m.tasks[closedId].workerId);
  });

  it('a delivery that shipped under another PR stays Done', () => {
    const m = board(superseded);
    expect(overviewLayout(m).groups.find(g => g.key === 'done')!.ids).toContain(closedId);
    expect(overviewCells(m, overviewLayout(m).order).find(c => c.id === closedId)!.state).toBe('landed');
  });
});

describe('overviewWaitLine', () => {
  const { kinds } = overviewWavesInput(20);
  const m = overviewWavesBoard(20);
  const idOf = (k: string) => Object.entries(kinds).find(([, v]) => v === k)![0];

  it('names the hold and what lifts it', () => {
    expect(overviewWaitLine(m, idOf('hold'))).toBe('Mission budget. Starts when the mission budget is raised.');
    expect(overviewWaitLine(m, idOf('slot'))).toBe('Workspace concurrency limit. Starts when a workspace task finishes.');
  });

  it('leaves waiting on tasks to the strip reason, and says plainly when no reason is recorded', () => {
    expect(overviewWaitLine(m, idOf('dep'))).toBeNull();
    expect(overviewWaitLine(m, idOf('unknown'))).toBe('Not started, and no reason is recorded.');
  });

  it('a task whose subject PR closed says so plainly, never "starts when never"', () => {
    const id = idOf('hold');
    const dead = { ...m, tasks: { ...m.tasks, [id]: { ...m.tasks[id], waitingKind: 'subject_dead' as const } } };
    const line = overviewWaitLine(dead, id)!;
    expect(line).toBe('The PR it was filed for was closed, so it will not start on its own.');
    expect(line).not.toContain('Starts when never');
  });
});

// Spec d25d923d R-14, R-20; strip R-8a: the true state wins over a retry backoff.
describe('overviewStatus', () => {
  const NOW = Date.UTC(2026, 0, 1, 14, 0, 0);
  const { tasks, gateFacts, kinds } = overviewWavesInput(10);
  const pendingId = Object.entries(kinds).find(([, k]) => k === 'slot')![0];
  const BACKOFF = (3 * 60 + 52) * 60_000;
  const redPr = (state: 'ci_failed' | 'conflict') => tasks.map(t => {
    if (t.id !== pendingId) return t;
    const w = { id: 'w-red', status: 'completed', runner: 'alpha', startedAt: NOW - 3_600_000, completedAt: NOW - 3_000_000, updatedAt: NOW - 3_000_000, mergedAt: null, prNumber: 777, prUrl: 'https://github.com/example/app/pull/777', prLifecycleStatus: state, currentAction: null, waitingFor: null, milestones: [], linesAdded: null, linesRemoved: null };
    return { ...t, startAt: NOW + BACKOFF, workers: [w], worker: { status: 'completed', startedAt: new Date(w.startedAt), updatedAt: new Date(w.updatedAt), prNumber: 777, prUrl: w.prUrl, prLifecycleStatus: state, mergedAt: null } };
  });
  const board = (rows: unknown[]) => buildMissionBoard({ now: NOW, missionCreatedAt: 0, missionStatus: 'active', tasks: rows as never, gateFacts });

  it('a re-queued task with red CI in a retry backoff reads Fixing · CI failed and Retry in 3h 52m, never Queued', () => {
    const m = board(redPr('ci_failed'));
    expect(m.tasks[pendingId].status).toBe('fixing');
    const st = overviewStatus(m, pendingId);
    expect(st).toMatchObject({ word: 'Fixing', cause: 'CI failed', tone: 'act', retryAt: NOW + BACKOFF });
    expect(overviewStatusText(st)).toBe('Fixing · CI failed');
    expect(retryText(st, NOW)).toBe('Retry in 3h 52m');
    expect(RETRY_NOW).toBe('Retry now');
    expect(retryText(st, NOW + BACKOFF + 1)).toBeNull();
    const cell = overviewCells(m, overviewLayout(m).order).find(c => c.id === pendingId)!;
    expect(cell.state).toBe('fixing');
    expect(cell.word).toBe('Fixing · CI failed');
    expect(overviewWaitCause(m, pendingId)).toBeNull();
    expect(m.tasks[pendingId].waitingKind).toBeUndefined();
  });

  it('a merge conflict names its cause', () => {
    expect(overviewStatusText(overviewStatus(board(redPr('conflict')), pendingId))).toBe('Fixing · Merge conflict');
  });

  it('a task the loop holds for its checks until a future start reads Fixing; once the start passes it is Queued again', () => {
    const held = (startAt: number) => tasks.map(t => (t.id === pendingId ? { ...t, startAt, loopWebhookWait: true } : t));
    expect(board(held(NOW + BACKOFF)).tasks[pendingId].status).toBe('fixing');
    expect(overviewStatus(board(held(NOW + BACKOFF)), pendingId)).toMatchObject({ word: 'Fixing', retryAt: NOW + BACKOFF });
    expect(board(held(NOW - 1)).tasks[pendingId].status).toBe('ready');
    // A plain scheduled start with no red PR and no loop wait stays Queued.
    expect(board(tasks.map(t => (t.id === pendingId ? { ...t, startAt: NOW + BACKOFF } : t))).tasks[pendingId].status).toBe('ready');
  });

  it('a running task ticks from its start and names its latest milestone and last event', () => {
    const runId = tasks.find(t => t.status === 'in_progress')!.id;
    const rows = tasks.map(t => (t.id === runId
      ? { ...t, workers: [{ ...t.workers![0], startedAt: NOW - 724_000, updatedAt: NOW - 60_000, milestones: [{ ts: NOW - 120_000, label: 'Cloned repo' }, { ts: NOW - 14_000, label: 'Running unit tests' }] }] }
      : t));
    expect(overviewStatus(board(rows), runId)).toMatchObject({ word: 'Running', cause: 'Running unit tests', since: NOW - 724_000, lastEventAt: NOW - 14_000, retryAt: null, tone: 'act' });
  });

  it('a waiting task reads Queued and names its cause; a merged one reads Merged', () => {
    const m = board(tasks);
    expect(overviewStatus(m, pendingId)).toMatchObject({ word: 'Queued', cause: 'Next in line', tone: 'q' });
    expect(overviewStatus(m, tasks[0].id).word).toBe('Merged');
  });
});

describe('lastEventOf', () => {
  it('is the later of the newest write and the newest milestone', () => {
    expect(lastEventOf({ updatedAt: 100, milestones: [{ ts: 50, label: 'a' }] })).toBe(100);
    expect(lastEventOf({ updatedAt: 100, milestones: [{ ts: 150, label: 'a' }] })).toBe(150);
    expect(lastEventOf({ updatedAt: null, milestones: [] })).toBeNull();
  });
});

describe('formatCountdown', () => {
  it('3h 52m, 12m, under 1m', () => {
    expect(formatCountdown((3 * 60 + 52) * 60_000)).toBe('3h 52m');
    expect(formatCountdown(12 * 60_000)).toBe('12m');
    expect(formatCountdown(10_000)).toBe('1m');
    expect(formatCountdown(0)).toBe('under 1m');
  });
});
