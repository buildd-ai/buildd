import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * Expected task size from completed neighbours (jev-scheduling §3). The pure
 * median is tested directly; the source is driven with a fake store and a
 * stubbed client, and its predicate is rendered with the real PgDialect so
 * workspace scoping and the leakage cutoff are observable.
 */

const fake = { rows: [] as any[], selects: [] as any[] };

mock.module('../db/client', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (where: any) => { fake.selects.push(where); return Promise.resolve(fake.rows); },
      }),
    }),
  },
}));

const size = await import('../task-size-estimate');

const dialect = new PgDialect();
const render = (fragment: any) => {
  const q = dialect.sqlToQuery(fragment);
  return { sql: q.sql.replace(/\s+/g, ' ').trim().toLowerCase(), params: q.params };
};

const WS = '00000000-0000-4000-8000-0000000000aa';
const TASK = '00000000-0000-4000-8000-000000000001';
const CUTOFF = new Date('2026-09-10T00:00:00Z');
const id = (n: number) => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`;
const at = (h: number) => new Date(CUTOFF.getTime() - h * 3_600_000);

/** A session that started `startH` hours before the cutoff and ran `minutes`. */
const session = (taskId: string, files: number | null, startH: number, minutes: number) => ({
  taskId,
  filesChanged: files,
  startedAt: at(startH),
  completedAt: new Date(at(startH).getTime() + minutes * 60_000),
});

beforeEach(() => { fake.rows = []; fake.selects = []; });

describe('estimateTaskSizeFromSessions (pure)', () => {
  it('medians files and minutes over the k nearest neighbours that have a size', () => {
    const ids = [1, 2, 3, 4, 5, 6].map(id);
    const sessions = [
      session(ids[0], 2, 50, 10),
      session(ids[1], 4, 50, 30),
      session(ids[2], 6, 50, 20),
      // The 4th nearest has no size: skipped, the 5th takes its place.
      { taskId: ids[3], filesChanged: null, startedAt: at(50), completedAt: at(49) },
      session(ids[4], 8, 50, 40),
      // Beyond k: never read.
      session(ids[5], 100, 50, 1000),
    ];
    const r = size.estimateTaskSizeFromSessions(ids, sessions, { k: 4, cutoff: CUTOFF });
    expect(r).toEqual({ files: 5, minutes: 25, source: 'neighbours', k: 4, n: 4 });
  });

  it('fewer than k neighbours with a size is null (no bucket fallback here)', () => {
    const ids = [1, 2].map(id);
    const r = size.estimateTaskSizeFromSessions(ids, [session(ids[0], 2, 50, 10), session(ids[1], 4, 50, 30)], { k: 3, cutoff: CUTOFF });
    expect(r).toBeNull();
  });

  it('no neighbours is null', () => {
    expect(size.estimateTaskSizeFromSessions([], [], { k: 1, cutoff: CUTOFF })).toBeNull();
  });

  it('a session that ended at or after the cutoff is future evidence and is ignored', () => {
    const ids = [id(1)];
    const future = { taskId: ids[0], filesChanged: 3, startedAt: at(1), completedAt: new Date(CUTOFF.getTime() + 60_000) };
    expect(size.estimateTaskSizeFromSessions(ids, [future], { k: 1, cutoff: CUTOFF })).toBeNull();
  });

  it('a neighbour is sized by its first completed session, not a later retry', () => {
    const ids = [id(1)];
    const r = size.estimateTaskSizeFromSessions(ids, [session(ids[0], 9, 10, 90), session(ids[0], 3, 40, 12)], { k: 1, cutoff: CUTOFF });
    expect(r).toEqual({ files: 3, minutes: 12, source: 'neighbours', k: 1, n: 1 });
  });

  it('a session with no start or a negative duration has no size', () => {
    const ids = [id(1), id(2)];
    const r = size.estimateTaskSizeFromSessions(ids, [
      { taskId: ids[0], filesChanged: 3, startedAt: null, completedAt: at(1) },
      { taskId: ids[1], filesChanged: 3, startedAt: at(1), completedAt: at(2) },
    ], { k: 1, cutoff: CUTOFF });
    expect(r).toBeNull();
  });
});

describe('neighbourSessionsWhere', () => {
  it('reads completed sessions of the neighbours, workspace-scoped, before the cutoff', () => {
    const w = render(size.neighbourSessionsWhere({ workspaceId: WS, taskIds: [id(1), id(2)], cutoff: CUTOFF }));
    expect(w.sql).toContain('"workers"."workspace_id" = $1');
    expect(w.sql).toContain('"workers"."task_id" in ($2, $3)');
    expect(w.sql).toContain('"workers"."status" = $4');
    expect(w.sql).toContain('"workers"."started_at" is not null');
    expect(w.sql).toContain('"workers"."completed_at" < $5');
    expect(w.params).toEqual([WS, id(1), id(2), 'completed', CUTOFF.toISOString()]);
  });
});

describe('estimateTaskSize (source)', () => {
  const store = (ids: string[]) => ({
    query: mock(async () => [
      { id: `task:${TASK}`, metadata: { taskId: TASK }, score: 0.99 },
      ...ids.map((t, i) => ({ id: `task:${t}`, metadata: { taskId: t }, score: 0.9 - i / 100 })),
    ]),
  });

  it('with k neighbours: reuses the task-corpus neighbours and medians their sessions', async () => {
    const ids = [1, 2, 3].map(id);
    fake.rows = [session(ids[0], 1, 30, 10), session(ids[1], 3, 30, 20), session(ids[2], 5, 30, 60)];
    const s = store(ids);
    const r = await size.estimateTaskSize({ workspaceId: WS, taskId: TASK, seedText: 'fix the claim route', cutoff: CUTOFF, k: 3 }, { store: s as any });
    expect(r).toEqual({ files: 3, minutes: 20, source: 'neighbours', k: 3, n: 3 });
    expect((s.query.mock.calls[0] as any)[0]).toBe(`${WS}:task`);
    expect(fake.selects).toHaveLength(1);
  });

  it('without enough neighbours: null', async () => {
    const ids = [1].map(id);
    fake.rows = [session(ids[0], 1, 30, 10)];
    const r = await size.estimateTaskSize({ workspaceId: WS, taskId: TASK, seedText: 'x', cutoff: CUTOFF, k: 3 }, { store: store(ids) as any });
    expect(r).toBeNull();
  });

  it('given neighbour ids, does no retrieval of its own', async () => {
    const ids = [1].map(id);
    fake.rows = [session(ids[0], 2, 30, 15)];
    const s = store([]);
    const r = await size.estimateTaskSize({ workspaceId: WS, taskId: TASK, seedText: 'x', cutoff: CUTOFF, k: 1, neighbourTaskIds: ids }, { store: s as any });
    expect(r).toEqual({ files: 2, minutes: 15, source: 'neighbours', k: 1, n: 1 });
    expect(s.query).not.toHaveBeenCalled();
  });

  it('no neighbours found: no session read, null', async () => {
    const r = await size.estimateTaskSize({ workspaceId: WS, taskId: TASK, seedText: 'x', cutoff: CUTOFF, k: 1 }, { store: store([]) as any });
    expect(r).toBeNull();
    expect(fake.selects).toHaveLength(0);
  });
});
