import { describe, it, expect, mock } from 'bun:test';
import { handleBuilddAction, formatWorkerMilestones, type ApiFn, type ActionContext } from '../mcp-tools';

const WS_ID = '00000000-0000-0000-0000-000000000001';
const TASK_ID = '11111111-1111-1111-1111-111111111111';
const T0 = Date.parse('2026-10-10T12:00:00.000Z');

function ctx(): ActionContext {
  return { workspaceId: WS_ID, getWorkspaceId: async () => WS_ID, getLevel: async () => 'worker' };
}

const status = (label: string, minute: number) => ({ type: 'status', label, ts: T0 + minute * 60_000 });

describe('formatWorkerMilestones', () => {
  it('prints one line per milestone, oldest first: ISO time, type, label', () => {
    expect(formatWorkerMilestones([
      status('Worktree ready', 1),
      { type: 'phase', label: 'Reading the task', toolCount: 3, ts: T0 },
      { type: 'checkpoint', event: 'first_commit', ts: T0 + 2 * 60_000 },
      { type: 'action', tool: 'Edit', path: 'apps/x.ts', ts: T0 + 3 * 60_000 },
    ])).toEqual([
      '  Milestones (4):',
      '  - 2026-10-10T12:00:00.000Z phase Reading the task',
      '  - 2026-10-10T12:01:00.000Z status Worktree ready',
      '  - 2026-10-10T12:02:00.000Z checkpoint first_commit',
      '  - 2026-10-10T12:03:00.000Z action Edit apps/x.ts',
    ]);
  });

  it('caps to the newest entries and says how many it left out', () => {
    const many = Array.from({ length: 40 }, (_, i) => status(`step ${i}`, i));
    const out = formatWorkerMilestones(many, 25);
    expect(out[0]).toBe('  Milestones (40):');
    expect(out[1]).toBe('  (15 earlier omitted)');
    expect(out).toHaveLength(27);
    expect(out[out.length - 1]).toContain('step 39');
    expect(out.some(l => l.includes('step 14'))).toBe(false);
  });

  it('always keeps merge-transparency lines (Pre-merge:/Merge:), even beyond the cap', () => {
    const many = [
      status('Pre-merge: base merged by the runner; mergiraf resolved 1: a.ts', 0),
      status('Merge: mergiraf resolved 2 file(s) in an agent merge: b.ts, c.json', 1),
      ...Array.from({ length: 30 }, (_, i) => status(`step ${i}`, 10 + i)),
    ];
    const out = formatWorkerMilestones(many, 25);
    expect(out[1]).toBe('  (5 earlier omitted)');
    expect(out[2]).toContain('Pre-merge: base merged by the runner; mergiraf resolved 1: a.ts');
    expect(out[3]).toContain('Merge: mergiraf resolved 2 file(s)');
    expect(out).toHaveLength(2 + 2 + 25);
  });

  it('truncates long labels and tolerates junk entries', () => {
    const out = formatWorkerMilestones([status('x'.repeat(500), 0), null, 'nope', { type: 'status' }] as unknown[]);
    expect(out[0]).toBe('  Milestones (2):');
    // An entry with no timestamp sorts first and says so.
    expect(out[1]).toBe('  - unknown-time status');
    expect(out[2].length).toBeLessThan(260);
    expect(out[2].endsWith('…')).toBe(true);
  });

  it('says so when a worker has none', () => {
    expect(formatWorkerMilestones([])).toEqual(['  Milestones: none recorded']);
    expect(formatWorkerMilestones(undefined)).toEqual(['  Milestones: none recorded']);
  });
});

describe('get_task include "milestones"', () => {
  const task = {
    id: TASK_ID,
    title: 'fix: something',
    status: 'completed',
    priority: 5,
    workspace: { name: 'buildd', repo: 'buildd-ai/buildd' },
    workers: [{ id: 'w-1', status: 'completed', milestones: [status('Pre-merge: already up to date with the base', 0)] }],
    artifacts: [],
  };

  it('asks the API for milestones and prints them under each worker', async () => {
    const api = mock(async () => task);
    const res = await handleBuilddAction(api as unknown as ApiFn, 'get_task', { taskId: TASK_ID, include: ['workers', 'milestones'] }, ctx());
    const [endpoint] = (api.mock.calls as unknown[][])[0] as [string];
    expect(decodeURIComponent(endpoint)).toContain('include=workers,milestones');
    const out = res.content[0].text;
    expect(out).toContain('Milestones (1):');
    expect(out).toContain('2026-10-10T12:00:00.000Z status Pre-merge: already up to date with the base');
  });

  it('milestones alone still fetches and shows the workers', async () => {
    const api = mock(async () => task);
    const res = await handleBuilddAction(api as unknown as ApiFn, 'get_task', { taskId: TASK_ID, include: ['milestones'] }, ctx());
    const [endpoint] = (api.mock.calls as unknown[][])[0] as [string];
    expect(decodeURIComponent(endpoint)).toContain('include=milestones');
    expect(res.content[0].text).toContain('Pre-merge: already up to date with the base');
  });

  it('is not shown by default, so existing outputs do not grow', async () => {
    const api = mock(async () => task);
    const res = await handleBuilddAction(api as unknown as ApiFn, 'get_task', { taskId: TASK_ID }, ctx());
    expect(res.content[0].text).not.toContain('Milestones');
  });
});
