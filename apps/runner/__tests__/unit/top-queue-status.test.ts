/**
 * The Queue's one status word per row (spec 0dc7c6de R-12..R-17, AC-6..AC-8):
 * Running, Queued or Blocked, the claim's own words after Blocked, "Taken by"
 * when another runner won, running agents above the queue, and the accent for
 * Running only. Made-up titles and ids.
 */
import { describe, expect, test } from 'bun:test';
import type { RunnerQueueResponse, RunnerQueueTask } from '@buildd/shared';
import { createPalette, stripAnsi } from '../../src/terminal-palette';
import { queueNextLine, queueSections } from '../../src/top/queue';
import { renderFrame } from '../../src/top/render';
import { initialState, queueRowReason, reduce, type TopState, type TopWorker } from '../../src/top/state';

const NOW = new Date(2026, 2, 10, 15, 0, 0).getTime();
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

const task = (over: Partial<RunnerQueueTask> & { id: string; title: string }): RunnerQueueTask => ({
  workspaceId: 'ws-main', workspaceName: 'buildd', missionId: null, missionTitle: null, roleSlug: 'builder', backend: 'claude',
  priority: 8, createdAt: iso(NOW - 3_600_000), dependsOn: [], holds: [], holdUntil: null, holdCause: null, estimateMinutes: null,
  ...over,
});

const queue = (tasks: RunnerQueueTask[]): RunnerQueueResponse => ({
  truncated: false,
  teams: [{ teamId: 'team-b', teamName: 'Buildd', estimatesOn: false, queue: tasks, notForRunner: [] }],
});

const T = ['t-1', 't-2', 't-3', 't-4'].map((id, i) => task({ id, title: `task number ${i + 1}` }));

function stateWith(slots: number, running: number, tasks: RunnerQueueTask[] = T): TopState {
  let s = initialState({ hostname: 'atlas' });
  s = reduce(s, { type: 'runner', pid: 1, version: '0.358.1' });
  s = reduce(s, { type: 'config', maxConcurrent: slots, builddServer: 'https://buildd.dev' });
  s = reduce(s, { type: 'workspaces', workspaces: [{ id: 'ws-main', name: 'buildd', teamId: 'team-b', teamName: 'Buildd' }] });
  const workers: TopWorker[] = Array.from({ length: running }, (_, i) => ({
    id: `w-${i}`, taskId: `run-${i}`, taskTitle: `running work ${i + 1}`, workspaceId: 'ws-main', status: 'working', startedAt: NOW - 10 * MIN, currentAction: 'Edit a.ts',
  }));
  s = reduce(s, { type: 'workers', workers });
  s = reduce(s, { type: 'tasks', tasks: workers.map(w => ({ id: w.taskId, title: w.taskTitle!, status: 'in_progress', workspaceId: 'ws-main' })) });
  s = reduce(s, { type: 'queue', queue: queue(tasks) });
  s = reduce(s, { type: 'connection', online: true });
  return { ...s, view: 'queue' };
}

const rows = (s: TopState) => queueSections(s, NOW)[0].rows;
const words = (s: TopState) => rows(s).map(r => r.starts);

describe('one status word per row (R-12)', () => {
  test('running agents are Running rows above the queued rows; free slots make Queued rows', () => {
    const s = stateWith(5, 1);
    expect(words(s)).toEqual(['Running', 'Queued', 'Queued', 'Queued', 'Queued']);
    expect(rows(s)[0].title).toBe('running work 1');
    expect(rows(s).slice(1).map(r => r.position)).toEqual([1, 2, 3, 4]);
  });

  test('slots full: still Queued, never "now" or "next to try"', () => {
    expect(words(stateWith(1, 1)).slice(1)).toEqual(['Queued', 'Queued', 'Queued', 'Queued']);
  });
});

describe('Blocked says what the claim said (R-13, R-14, AC-6)', () => {
  test('AC-6: a task the broad claim refused for role_env_unsatisfied is Blocked and not counted as starting', () => {
    let s = stateWith(10, 0);
    s = reduce(s, { type: 'claim_outcome', outcome: { at: NOW - 5_000, reason: 'all_candidates_deferred', deferrals: { role_env_unsatisfied: 1 }, deferredTasks: [{ taskId: 't-1', code: 'role_env_unsatisfied' }] } });
    expect(words(s)[0]).toBe('Blocked · needs settings this runner lacks');
    expect(queueNextLine(s, NOW)).toMatch(/^Next: #2, #3 and #4 take a free slot/);
    expect(queueNextLine(s, NOW)).not.toContain('#1');
  });

  test('an overlap names the row it waits for: Blocked · after #1', () => {
    let s = stateWith(10, 0);
    s = reduce(s, { type: 'claim_outcome', taskId: 't-3', outcome: { at: NOW - 5_000, reason: 'all_candidates_deferred', exclusion: 'soft_overlap', holderTaskId: 't-1', detail: 'overlaps' } });
    expect(words(s)[2]).toBe('Blocked · after #1');
  });

  test('a limit that lifts at a time: Blocked · until <time>', () => {
    let s = stateWith(10, 0);
    s = reduce(s, { type: 'claim_outcome', taskId: 't-1', outcome: { at: NOW - 5_000, reason: 'budget_exhausted', walls: [{ kind: 'account_seat', backend: 'claude', resetsAt: iso(new Date(2026, 2, 10, 17, 7).getTime()) }] } });
    expect(words(s)[0]).toBe('Blocked · until 17:07');
  });

  test('a row nothing refused is never Blocked on a guess', () => {
    expect(words(stateWith(10, 0)).every(w => w === 'Queued')).toBe(true);
  });
});

describe('Taken by (R-17, AC-7)', () => {
  test('another runner took a listed task: the row says Taken by <runner> and takes no slot', () => {
    let s = stateWith(10, 0);
    s = reduce(s, { type: 'tasks', tasks: [{ id: 't-2', title: 'task number 2', status: 'in_progress', workspaceId: 'ws-main', claimedByName: 'orion' }] });
    expect(words(s)[1]).toBe('Taken by orion');
    expect(rows(s)[1].position).toBe(2);
    expect(queueNextLine(s, NOW)).not.toContain('#2');
  });

  test('without a name for the runner it still says Taken by another runner', () => {
    let s = stateWith(10, 0);
    s = reduce(s, { type: 'tasks', tasks: [{ id: 't-2', title: 'task number 2', status: 'assigned', workspaceId: 'ws-main' }] });
    expect(words(s)[1]).toBe('Taken by another runner');
  });
});

describe('the Next line counts Queued rows that take a free slot', () => {
  test('two free slots: only the first two Queued rows', () => {
    expect(queueNextLine(stateWith(2, 0), NOW)).toMatch(/^Next: #1 and #2 take a free slot/);
  });

  test('the mission cap holds rows already counted', () => {
    const capped = ['t-1', 't-2', 't-3'].map(id => task({ id, title: id, missionId: 'm-1', missionTitle: 'M', missionCap: 2 }));
    const s = stateWith(10, 0, [...capped, task({ id: 't-4', title: 't-4' })]);
    expect(queueNextLine(s, NOW)).toMatch(/^Next: #1, #2 and #4 take a free slot/);
    expect(words(s)[2]).toBe('Blocked · mission is at its task limit');
  });
});

describe('colour and words (R-16, AC-8)', () => {
  const frame = (s: TopState, palette = createPalette('night', 'none')) => renderFrame(s, { cols: 120, rows: 30, now: NOW, palette });

  test('AC-8: the rendered Queue never says "now" or "next to try"', () => {
    let s = stateWith(5, 1);
    s = reduce(s, { type: 'claim_outcome', taskId: 't-2', outcome: { at: NOW - 5_000, reason: 'budget_exhausted', walls: [{ kind: 'account_seat', backend: 'claude', resetsAt: iso(NOW + 3_600_000) }] } });
    const t = frame(s).map(stripAnsi).join('\n');
    expect(t).toContain('Running');
    expect(t).toContain('Queued');
    expect(t).toContain('Blocked');
    expect(t).not.toMatch(/\bnow\b/);
    expect(t).not.toContain('next to try');
  });

  test('only Running uses the accent colour in the status column', () => {
    const palette = createPalette('night', 'truecolor');
    const open = palette.fg('accent', 'X').split('X')[0];
    let s = stateWith(5, 1);
    s = reduce(s, { type: 'claim_outcome', taskId: 't-2', outcome: { at: NOW - 5_000, reason: 'budget_exhausted', walls: [{ kind: 'account_seat', backend: 'claude', resetsAt: iso(NOW + 3_600_000) }] } });
    const raw = frame({ ...s, queueCursor: 2 }, palette).join('\n');
    expect(raw).toContain(open + 'Running');
    expect(raw).not.toContain(open + 'Queued');
    expect(raw).not.toContain(open + 'Blocked');
  });
});

describe('the Missions view reason for a queued row', () => {
  test('reads from the status, with no "now"', () => {
    const [, first] = rows(stateWith(5, 1));
    expect(queueRowReason(first)).toBe('#1 in queue · starts on the next claim');
  });
});
