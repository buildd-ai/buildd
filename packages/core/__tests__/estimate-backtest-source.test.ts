import { describe, it, expect, mock } from 'bun:test';

mock.module('../db/client', () => ({ db: {} }));
const { replayTasks, actualOf } = await import('../estimate-backtest-source');

const T0 = new Date('2026-09-01T00:00:00Z').getTime();
const hr = (h: number) => new Date(T0 + h * 3_600_000);
const mk = (id: string, createdH: number, completedH: number | null = createdH + 1) =>
  ({ id, workspaceId: 'ws', title: id, description: null, createdAt: hr(createdH), completedAt: completedH === null ? null : hr(completedH) });
const sess = (taskId: string, startH: number, minutes: number, files = 3) =>
  ({ taskId, filesChanged: files, startedAt: hr(startH), completedAt: new Date(hr(startH).getTime() + minutes * 60_000), inputTokens: 100, outputTokens: 50 });

describe('actualOf', () => {
  it('sums worker spans and tokens', () => {
    expect(actualOf([sess('a', 0, 10), sess('a', 1, 20)])).toEqual({ minutes: 30, tokens: 300 });
  });
});

describe('replayTasks', () => {
  const past = ['p1', 'p2', 'p3', 'p4', 'p5'].map((id, i) => mk(id, i));
  const pastSessions = past.map((t, i) => sess(t.id, i, 10 * (i + 1)));

  it('estimates from neighbours that predate the task', async () => {
    const target = mk('t', 100);
    const rows = await replayTasks([...past, target], [...pastSessions, sess('t', 100, 30)], { findNeighbours: async () => past.map(p => p.id) });
    const r = rows.find(x => x.taskId === 't')!;
    expect(r.source).toBe('neighbours');
    expect(r.p50).toBe(30); // median of 10..50
    expect(r.actual).toBe(30);
    expect(r.priorCompleted).toBe(5);
  });

  it('never lets a task created after the cutoff contribute', async () => {
    const target = mk('t', 3.5);
    const future = ['f1', 'f2', 'f3', 'f4', 'f5'].map((id, i) => mk(id, 50 + i));
    const all = [...past.slice(0, 3), target, ...future];
    const sessions = [...pastSessions.slice(0, 3), sess('t', 3.5, 30), ...future.map((f, i) => sess(f.id, 50 + i, 999))];
    const rows = await replayTasks(all, sessions, { findNeighbours: async () => [...future.map(f => f.id), ...past.slice(0, 3).map(p => p.id)] });
    const r = rows.find(x => x.taskId === 't')!;
    // 3 past neighbours < k=5 once the future ones are dropped.
    expect(r.source).toBe('bucket');
  });

  it('only scores the sampled tasks but keeps every task as history and neighbour', async () => {
    const target = mk('t', 100);
    const rows = await replayTasks([...past, target], [...pastSessions, sess('t', 100, 30)], {
      findNeighbours: async () => past.map(p => p.id), only: new Set(['t']),
    });
    expect(rows.map(r => r.taskId)).toEqual(['t']);
    expect(rows[0].source).toBe('neighbours');
    expect(rows[0].priorCompleted).toBe(5);
  });

  it('held-out mode ignores history and uses the bucket', async () => {
    const rows = await replayTasks([...past, mk('t', 100)], [...pastSessions, sess('t', 100, 30)], {
      heldOut: true, findNeighbours: async () => { throw new Error('should not be called'); },
    });
    expect(rows.every(r => r.source === 'bucket' && r.priorCompleted === 0)).toBe(true);
  });

  it('skips tasks with no measurable actual; source none without bucket fallback', async () => {
    const rows = await replayTasks([mk('x', 0), mk('y', 1)], [sess('y', 1, 5)], { findNeighbours: async () => [], bucketFallback: false });
    expect(rows.map(r => [r.taskId, r.source])).toEqual([['y', 'none']]);
  });
});
