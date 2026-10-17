/**
 * `GET /api/workers?view=top`: what `buildd top` renders, not every stored
 * worker with its full output. The plain `GET /api/workers` stays as it was
 * for the local UI and scripts.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/top-worker-summary.test.ts
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { toTopWorkerSummaries, TOP_RECENT_TERMINAL_WORKERS, TOP_MAX_TERMINAL_WORKERS } from '../../src/top-worker-summary';
import { toPublicWorkers } from '../../src/public-worker';
import { describeToolCall, planOf } from '../../src/top/state';

const big = 'x'.repeat(50_000);

function worker(id: string, status: string, extra: Record<string, unknown> = {}): any {
  return {
    id, taskId: `t-${id}`, taskTitle: `Task ${id}`, taskDescription: big, workspaceId: 'ws', workspaceName: 'repo',
    status, startedAt: 1, lastActivity: 2, currentAction: 'Editing', branch: 'b', milestones: [{ type: 'status', label: 'hi', ts: 3 }],
    output: [big, big], messages: [{ type: 'text', content: big }], commits: [],
    toolCalls: [
      { name: 'Write', timestamp: 10, input: { file_path: '/repo/src/a.ts', content: big } },
      { name: 'Bash', timestamp: 11, input: { command: 'bun run test', description: 'tests' } },
      { name: 'TodoWrite', timestamp: 12, input: { todos: [{ content: 'step one', status: 'in_progress', activeForm: 'x' }] } },
    ],
    serverApiKey: 'secret', mcpSecrets: { a: 'b' },
    ...extra,
  };
}

describe('toTopWorkerSummaries', () => {
  test('keeps what top renders and drops output, transcript, descriptions and tool payloads', () => {
    const [s] = toTopWorkerSummaries([worker('a', 'working', { prUrl: 'https://example.invalid/pr/1', error: null })]) as any[];
    expect(Object.keys(s).sort()).toEqual([
      'currentAction', 'error', 'id', 'lastActivity', 'milestones', 'prUrl', 'startedAt', 'status',
      'taskId', 'taskTitle', 'toolCalls', 'workspaceId', 'workspaceName',
    ]);
    expect(JSON.stringify(s).length).toBeLessThan(2_000);
    expect(JSON.stringify(s)).not.toContain('secret');
    // Every tool call stays (top shows the count), with only the fields it reads.
    expect(s.toolCalls.length).toBe(3);
    expect(s.toolCalls[0].input.content).toBeUndefined();
    expect(describeToolCall(s.toolCalls[0])).toBe('Write a.ts');
    expect(describeToolCall(s.toolCalls[1])).toBe('Bash bun run test');
    expect(planOf(s)).toEqual([{ content: 'step one', status: 'in_progress' }]);
  });

  test('every live worker, plus only the most recent finished ones', () => {
    const live = [worker('w1', 'working'), worker('w2', 'waiting'), worker('w3', 'stale')];
    const done = Array.from({ length: TOP_RECENT_TERMINAL_WORKERS + 20 }, (_, i) =>
      worker(`d${i}`, i % 2 ? 'done' : 'error', { completedAt: 1_000 + i }));
    const out = toTopWorkerSummaries([...done, ...live]);
    expect(out.filter(w => w.status === 'working' || w.status === 'waiting' || w.status === 'stale').length).toBe(3);
    const terminal = out.filter(w => w.status === 'done' || w.status === 'error');
    expect(terminal.length).toBe(TOP_RECENT_TERMINAL_WORKERS);
    // The newest ones.
    expect(terminal.map(w => w.id)).toContain(`d${TOP_RECENT_TERMINAL_WORKERS + 19}`);
    expect(terminal.map(w => w.id)).not.toContain('d0');
  });

  test('a heavy day: every worker that finished today is included, past the recent count', () => {
    const now = new Date(2026, 9, 16, 18, 0, 0).getTime();
    const midnight = new Date(2026, 9, 16, 0, 0, 0).getTime();
    const today = Array.from({ length: TOP_RECENT_TERMINAL_WORKERS + 70 }, (_, i) =>
      worker(`t${i}`, 'done', { completedAt: midnight + 60_000 * (i + 1) }));
    const yesterday = Array.from({ length: 30 }, (_, i) =>
      worker(`y${i}`, 'done', { completedAt: midnight - 60_000 * (i + 1) }));
    const out = toTopWorkerSummaries([...yesterday, ...today], { now });
    const ids = out.map(w => w.id);
    expect(ids.filter(id => id.startsWith('t')).length).toBe(today.length);
    // Yesterday's are not padded in once today already fills the recent count.
    expect(ids.some(id => id.startsWith('y'))).toBe(false);
  });

  test('a quiet day still shows the most recent finished ones from before today', () => {
    const now = new Date(2026, 9, 16, 9, 0, 0).getTime();
    const midnight = new Date(2026, 9, 16, 0, 0, 0).getTime();
    const today = [worker('t0', 'done', { completedAt: midnight + 1000 })];
    const earlier = Array.from({ length: TOP_RECENT_TERMINAL_WORKERS + 10 }, (_, i) =>
      worker(`e${i}`, 'error', { completedAt: midnight - 60_000 * (i + 1) }));
    const out = toTopWorkerSummaries([...earlier, ...today], { now });
    expect(out.length).toBe(TOP_RECENT_TERMINAL_WORKERS);
    expect(out[0].id).toBe('t0');
    expect(out.map(w => w.id)).toContain('e0');
  });

  test('still bounded: today past the ceiling is cut, newest kept', () => {
    const now = new Date(2026, 9, 16, 23, 0, 0).getTime();
    const midnight = new Date(2026, 9, 16, 0, 0, 0).getTime();
    const today = Array.from({ length: TOP_MAX_TERMINAL_WORKERS + 25 }, (_, i) =>
      worker(`t${i}`, 'done', { completedAt: midnight + 1000 * (i + 1) }));
    const out = toTopWorkerSummaries(today, { now });
    expect(out.length).toBe(TOP_MAX_TERMINAL_WORKERS);
    expect(out[0].id).toBe(`t${TOP_MAX_TERMINAL_WORKERS + 24}`);
  });

  test('much smaller than the full projection the plain endpoint serves', () => {
    const many = Array.from({ length: 30 }, (_, i) => worker(`d${i}`, 'done', { completedAt: i }));
    const full = JSON.stringify(toPublicWorkers(many)).length;
    const slim = JSON.stringify(toTopWorkerSummaries(many)).length;
    expect(slim * 100).toBeLessThan(full);
  });

  test('top asks for the slim view; the plain endpoint is unchanged for other callers', () => {
    const run = readFileSync(join(import.meta.dir, '../../src/top/run.ts'), 'utf-8');
    expect(run).toContain("client.get('/api/workers?view=top')");
    const index = readFileSync(join(import.meta.dir, '../../src/index.ts'), 'utf-8');
    expect(index).toContain("url.searchParams.get('view') === 'top'");
    expect(index).toContain('toPublicWorkers(workerManager!.getWorkers())');
  });
});
