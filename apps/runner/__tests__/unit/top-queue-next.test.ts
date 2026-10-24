/**
 * The Queue's Next line (spec c7410e76 R-59, AC-41) and rows the server marks
 * as waiting on its mission's one task that declares no files
 * (`advisory_manifest`). The Next line is built from the rows' own reasons, so
 * the two never disagree. Titles and ids are made up.
 */
import { describe, expect, test } from 'bun:test';
import type { RunnerQueueResponse, RunnerQueueTask } from '@buildd/shared';
import { createPalette, stripAnsi } from '../../src/terminal-palette';
import { queueNextLine, queueSections } from '../../src/top/queue';
import { renderFrame } from '../../src/top/render';
import { initialState, reduce, type TopState, type TopWorker } from '../../src/top/state';

const NOW = new Date(2026, 2, 10, 15, 0, 0).getTime();
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const plain = createPalette('night', 'none');

const task = (over: Partial<RunnerQueueTask> & { id: string }): RunnerQueueTask => ({
  title: `task ${over.id}`, workspaceId: 'ws-main', workspaceName: 'buildd', missionId: 'm-fast', missionTitle: 'Fast at any size', roleSlug: 'builder', backend: 'claude',
  priority: 8, createdAt: iso(NOW - 3_600_000), dependsOn: [], holds: [], holdUntil: null, holdCause: null, estimateMinutes: null,
  ...over,
});

/** The owner's case: one mission, nine waiting tasks that declare no files; the server starts the first and marks the rest. */
const AC41: RunnerQueueTask[] = [
  task({ id: 'a1' }),
  ...Array.from({ length: 8 }, (_, i) => task({ id: `b${i + 1}`, holds: ['advisory_manifest'], holderTaskId: 'a1' })),
];

function stateWith(slots: number, running: number, queue: RunnerQueueTask[], estimates: Record<string, number> = {}): TopState {
  let s = initialState({ hostname: 'atlas' });
  s = reduce(s, { type: 'runner', pid: 1, version: '0.364.0' });
  s = reduce(s, { type: 'config', maxConcurrent: slots, builddServer: 'https://buildd.dev' });
  s = reduce(s, { type: 'workspaces', workspaces: [{ id: 'ws-main', name: 'buildd', teamId: 'team-b', teamName: 'Buildd' }] });
  const workers: TopWorker[] = Array.from({ length: running }, (_, i) => ({
    id: `w-${i}`, taskId: `run-${i}`, taskTitle: `running work ${i + 1}`, status: 'working', startedAt: NOW - 10 * MIN, currentAction: 'Edit a.ts',
  }));
  s = reduce(s, { type: 'workers', workers });
  s = reduce(s, { type: 'tasks', tasks: workers.map(w => ({ id: w.taskId, title: w.taskTitle!, status: 'in_progress' })) });
  const q: RunnerQueueResponse = { truncated: false, teams: [{ teamId: 'team-b', teamName: 'Buildd', estimatesOn: false, queue, notForRunner: [] }] };
  s = reduce(s, { type: 'queue', queue: q });
  s = reduce(s, { type: 'connection', online: true });
  return { ...s, view: 'queue', estimates: { ...s.estimates, ...estimates } };
}

describe('AC-41: 8 free slots, 9 waiting, 8 deferred for overlapping files', () => {
  const s = stateWith(9, 1, AC41);

  test('only the first row reads "now"; the other 8 name it', () => {
    const rows = queueSections(s, NOW)[0].rows;
    expect(rows[0].starts).toBe('now');
    for (const r of rows.slice(1)) {
      expect(r.starts).toBe('when #1 ends (same files)');
      expect(r.wait).toBe('same_files');
    }
  });

  test('the Next line names the one that starts and counts the 8 that wait', () => {
    expect(queueNextLine(s, NOW)).toBe('Next: #1 starts now · 8 wait for work on the same files');
  });

  test('the frame draws it under the Queue header', () => {
    const lines = renderFrame(s, { cols: 120, rows: 30, now: NOW, palette: plain }).map(l => stripAnsi(l));
    const at = lines.findIndex(l => l.includes('Next: #1 starts now · 8 wait for work on the same files'));
    expect(at).toBeGreaterThan(0);
    expect(lines.findIndex(l => l.includes('next for this runner'))).toBeGreaterThan(at);
    expect(lines.filter(l => /\bnow\s*$/.test(l) && /^\s*›?\s*\d/.test(l))).toHaveLength(1);
  });
});

describe('the Next line (R-59)', () => {
  test('several start together: named, then the waits by kind', () => {
    const s = stateWith(9, 0, [
      task({ id: 'a1' }), task({ id: 'a2', missionId: 'm-2' }),
      task({ id: 'b1', holds: ['advisory_manifest'], holderTaskId: 'a1' }),
      task({ id: 'c1', missionId: null, holds: ['deps_blocked'], dependsOn: ['x'] }),
    ]);
    expect(queueNextLine(s, NOW)).toBe('Next: #1 and #2 start now · 1 waits for work on the same files · 1 waits for its dependency');
  });

  test('nothing can start: every waiting task waits for work on the same files', () => {
    const s = stateWith(9, 1, AC41.slice(1).map(t => ({ ...t, holderTaskId: 'run-0' })));
    expect(queueNextLine(s, NOW)).toBe('Next: nothing can start · every waiting task waits for work on the same files');
  });

  test('every slot busy: the first row and when a slot frees', () => {
    expect(queueNextLine(stateWith(1, 1, [task({ id: 'a1' })], { 'run-0': 22 }), NOW)).toBe('Next: #1, in ~12m when a slot frees');
    expect(queueNextLine(stateWith(1, 1, [task({ id: 'a1' })]), NOW)).toBe('Next: #1, when a slot frees');
  });

  test('no line with nothing queued', () => {
    expect(queueNextLine(stateWith(9, 0, []), NOW)).toBeNull();
  });

  test('a row the server did not mark still starts now (older server)', () => {
    const s = stateWith(9, 0, [task({ id: 'a1' }), task({ id: 'a2' })]);
    expect(queueNextLine(s, NOW)).toBe('Next: #1 and #2 start now');
  });
});

describe('serial lane rows (spec: Overlap scheduling, I-3)', () => {
  test('a lane row says how many go first, and a stalled holder says so', () => {
    const s = stateWith(9, 0, [
      task({ id: 'l1', holds: ['serial_lane'], lane: { lane: 'migration', position: 1, holderTaskId: 'x' } }),
      task({ id: 'l2', holds: ['serial_lane'], lane: { lane: 'migration', position: 2, holderTaskId: 'x', stuckSince: iso(NOW - 30 * 60 * MIN) } }),
    ]);
    const rows = queueSections(s, NOW)[0].rows;
    expect(rows.map(r => r.starts)).toEqual(['in line, 1 ahead', 'in line (2 ahead), holder stalled']);
    expect(rows.every(r => r.wait === 'same_files')).toBe(true);
  });
});

/**
 * Spec "Overlap scheduling", AC-10 / "Health › Queue", AC-9: the terminal
 * Queue gives the server's one reason, the same one explain gives; a row the
 * claim would refuse never reads "now", and "now" needs a slot wait.
 */
describe('the server\'s one wait', () => {
  test('a declared dependency, a lane place and a limit each read as themselves, never "now"', () => {
    const s = stateWith(6, 0, [
      task({ id: 'dep', wait: { kind: 'declared', blockerId: 'x', blockerTitle: '“Rework claim order”', count: 1 } }),
      task({ id: 'lane', wait: { kind: 'lane', lane: 'migration', position: 2, holderTaskId: 'h' } }),
      task({ id: 'lim', wait: { kind: 'limit', limit: 'mission_cap', liftsAt: iso(NOW + 4 * MIN) } }),
      task({ id: 'go', wait: { kind: 'slot', noRunnerReason: null } }),
    ]);
    const rows = queueSections(s, NOW)[0].rows;
    expect(rows.map(r => r.starts)).toEqual(['after “Rework claim order”', 'schema lane, 2nd', 'mission limit, in 4m', 'now']);
    expect(rows.map(r => r.wait ?? null)).toEqual(['dependency', 'same_files', 'limit', null]);
  });

  test('2026-10-22: no stored refusal for this runner, but the server says the lane: not "now"', () => {
    const s = stateWith(6, 0, [task({ id: 'schema', wait: { kind: 'lane', lane: 'migration', position: 5, holderTaskId: 'h' } })]);
    expect(queueSections(s, NOW)[0].rows[0].starts).toBe('schema lane, 5th');
    expect(queueNextLine(s, NOW)).not.toContain('starts now');
  });
});
