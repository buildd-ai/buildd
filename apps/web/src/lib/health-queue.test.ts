/**
 * Health › Queue's read (spec "Health › Queue", R-2, R-14, AC-9, AC-10): one
 * bounded read in claim order, each task's reason from the shared wait read,
 * slots and idle capacity team-wide while the filters narrow everything else.
 */
import { describe, it, expect, mock } from 'bun:test';
import type { QueueWait } from '@buildd/shared';
import type { RunnerQueueRow } from '@/lib/claim-order-queue';
import type { LaneRead } from '@/lib/serial-lanes-store';
import { HEALTH_QUEUE_LIMIT, loadHealthQueue, type HealthQueueDeps } from './health-queue';

const NOW = new Date('2026-10-23T12:00:00Z');

function row(i: number, over: Partial<RunnerQueueRow> = {}): RunnerQueueRow {
  return {
    id: `t-${i}`, title: `Task ${i}`, workspaceId: 'ws-1', workspaceName: 'Repo', teamId: 'team-1', teamName: 'Team',
    missionId: null, missionTitle: null, roleSlug: null, backend: null, priority: 0,
    createdAt: new Date(NOW.getTime() - i * 60_000), startAt: null, dependsOn: [], workspacePausedUntil: null, ...over,
  };
}

function deps(over: Partial<HealthQueueDeps> = {}): HealthQueueDeps {
  return {
    rows: mock(async () => [] as RunnerQueueRow[]),
    waits: mock(async (ids: string[]) => new Map(ids.map(id => [id, { kind: 'slot' } as QueueWait]))),
    lanes: mock(async (): Promise<LaneRead> => ({ lanes: new Map(), releasedTaskIds: new Set() })),
    titles: mock(async () => new Map<string, string>()),
    live: mock(async (ws: string[]) => (ws.length > 1 ? 5 : 2)),
    slots: mock(async () => 6),
    ...over,
  };
}

const base = { teamId: 'team-1', teamWorkspaceIds: ['ws-1', 'ws-2'], workspaceIds: ['ws-1'], filter: 'all' as const, page: 1, now: NOW };

describe('loadHealthQueue', () => {
  it('reads once, bounded, in the workspace scope; slots and idle capacity read the whole team', async () => {
    const d = deps({ rows: mock(async () => [row(1), row(2)]) });
    const v = await loadHealthQueue(base, d);
    expect(d.rows).toHaveBeenCalledTimes(1);
    expect((d.rows as any).mock.calls[0][0]).toEqual({ workspaceIds: ['ws-1'], limit: HEALTH_QUEUE_LIMIT });
    expect((d.waits as any).mock.calls[0][0]).toEqual(['t-1', 't-2']);
    expect((d.slots as any).mock.calls[0].slice(0, 2)).toEqual(['team-1', ['ws-1', 'ws-2']]);
    // Running is the filtered scope (2); slots are the team's (6).
    expect(v.tiles.running).toBe(2);
    expect(v.tiles.slots).toBe(6);
    // Idle = 6 slots − 5 team runs = 1: the first ready task starts now.
    expect(v.ready.map(r => r.note)).toEqual(['Starts now', 'Next free slot']);
  });

  it('the mission filter narrows rows and running; the options stay the workspace’s missions', async () => {
    const d = deps({ rows: mock(async () => [row(1, { missionId: 'm-a', missionTitle: 'Alpha' }), row(2, { missionId: 'm-b', missionTitle: 'Beta' })]) });
    const v = await loadHealthQueue({ ...base, missionId: 'm-a' }, d);
    expect((d.waits as any).mock.calls[0][0]).toEqual(['t-1']);
    expect((d.live as any).mock.calls.find((c: any[]) => c[1] === 'm-a')).toBeTruthy();
    expect(v.tiles.ready).toBe(1);
    expect(v.missions).toEqual([{ id: 'm-a', title: 'Alpha' }, { id: 'm-b', title: 'Beta' }]);
  });

  it('AC-9: each row carries the wait the shared read gave, untouched', async () => {
    const wait: QueueWait = { kind: 'lane', lane: 'migration', position: 2, holderTaskId: 'h' };
    const d = deps({ rows: mock(async () => [row(1)]), waits: mock(async () => new Map([['t-1', wait]])) });
    const v = await loadHealthQueue(base, d);
    expect(v.waiting.rows[0].wait).toEqual(wait);
    expect(v.waiting.rows[0].blockedBy).toBe('Schema lane · 2nd');
  });

  it('AC-10: past the bound the read says it was truncated', async () => {
    const d = deps({ rows: mock(async () => Array.from({ length: HEALTH_QUEUE_LIMIT + 1 }, (_, i) => row(i))) });
    const v = await loadHealthQueue(base, d);
    expect(v.truncated).toBe(true);
    expect(v.tiles.ready).toBe(HEALTH_QUEUE_LIMIT);
  });

  it('a failed reason read labels nothing ready', async () => {
    const d = deps({ rows: mock(async () => [row(1)]), waits: mock(async () => { throw new Error('down'); }) });
    const v = await loadHealthQueue(base, d);
    expect(v.reasonsUnavailable).toBe(true);
    expect(v.tiles.ready).toBe(0);
  });

  it('AC-8: a declared row says who set the edge and why', async () => {
    const dep = (id: string): QueueWait => ({ kind: 'declared', blockerId: id, blockerTitle: 'A', blockerStatus: 'pending', count: 1 });
    const d = deps({
      rows: mock(async () => [row(1, { ownerName: 'Sam Lee' }), row(2), row(3)]),
      waits: mock(async () => new Map([['t-1', dep('a')], ['t-2', dep('b')], ['t-3', dep('c')]])),
      edges: mock(async () => new Map([
        ['t-1', { waitExit: null, inferred: [] }],
        ['t-2', { waitExit: { blockerTaskId: 'b', reason: 'needs the index' }, inferred: [] }],
        ['t-3', { waitExit: null, inferred: ['c'] }],
      ])),
    });
    const v = await loadHealthQueue(base, d);
    const by = Object.fromEntries(v.waiting.rows.map(r => [r.id, [r.setBy, r.why]]));
    expect(by['t-1']).toEqual(['Sam', null]);
    expect(by['t-2']).toEqual(['Its agent', 'needs the index']);
    expect(by['t-3']).toEqual(['Shared files', 'Both change the same files']);
  });

  it('lanes: members in stored order with titles, a stuck holder dated', async () => {
    const quiet = new Date(NOW.getTime() - 30 * 3600_000);
    const read: LaneRead = {
      releasedTaskIds: new Set(),
      lanes: new Map([['ws-1', new Map([['migration', { workspaceId: 'ws-1', lane: 'migration', members: [
        { taskId: 'h', claimableSince: null, priority: 0, createdAt: NOW, heldAt: quiet, holding: true, ready: false, status: 'completed', prNumber: 9, prUrl: 'u', lastActivityAt: quiet },
        { taskId: 'w', claimableSince: quiet, priority: 0, createdAt: NOW, heldAt: null, holding: false, ready: true, status: 'pending', prNumber: null, prUrl: null, lastActivityAt: null },
      ] }]])]]),
    };
    const d = deps({ lanes: mock(async () => read), titles: mock(async () => new Map([['h', 'Add column'], ['w', 'Next']])) });
    const v = await loadHealthQueue(base, d);
    expect(v.lanes[0].holder).toMatchObject({ taskId: 'h', title: 'Add column', state: 'PR open' });
    expect(v.lanes[0].waiters.map(w => w.title)).toEqual(['Next']);
    expect(v.lanes[0].stuckFor).toBe('30h');
    expect(v.alert).toBe('Schema lane stuck 30h');
  });
});
