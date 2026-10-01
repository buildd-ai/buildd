/**
 * Recording an enforce-mode path-collision deferral
 * (docs/design/conflict-aware-orchestration.md §2).
 *
 * The runner found, at a checkpoint, that a path this task already changed is
 * held by another live task, saved a checkpoint and reported `Deferred:`. The
 * route requeues the task; this records why and makes the claim route hold it:
 * the collided path joins the effective manifest (the active-lease backstop
 * then defers the task until the holder releases — no agent waits), the
 * collision is kept next to the declaration snapshot, and a pushed checkpoint
 * becomes the resume branch.
 *
 * drizzle-orm stays real; the UPDATE is rendered with PgDialect, not guessed.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/web/src/lib/path-collision-deferral.test.ts
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';

const setCalls: any[] = [];
const whereCalls: any[] = [];
let returned: any[] = [{ id: 'task-1' }];
const mockUpdate = mock(() => ({
  set: (v: any) => {
    setCalls.push(v);
    return {
      where: (w: any) => {
        whereCalls.push(w);
        return { returning: async () => returned };
      },
    };
  },
}));
mock.module('@buildd/core/db', () => ({ db: { update: mockUpdate } }));

import { PgDialect } from 'drizzle-orm/pg-core';
import { parsePathCollision, recordPathCollisionDeferral } from './path-collision-deferral';

const dialect = new PgDialect();
const render = (v: unknown) => dialect.sqlToQuery(v as any);
const BLOCKER = 'bbbbbbbb-1111-2222-3333-444444444444';

describe('parsePathCollision', () => {
  it('accepts the runner shape and normalizes the path', () => {
    expect(parsePathCollision({
      path: './src/a.ts', blockingTaskId: BLOCKER, blockingTaskTitle: 'Other', blockingPath: 'src/', source: 'pre_push',
      checkpoint: { committed: true, sha: 'a'.repeat(40), pushed: true },
    })).toEqual({
      path: 'src/a.ts', blockingTaskId: BLOCKER, blockingTaskTitle: 'Other', blockingPath: 'src/', source: 'pre_push',
      checkpoint: { committed: true, sha: 'a'.repeat(40), pushed: true },
    });
  });

  it('rejects malformed, wildcard and escaping input', () => {
    expect(parsePathCollision(null)).toBeNull();
    expect(parsePathCollision({ path: 'a.ts' })).toBeNull();
    expect(parsePathCollision({ path: '**', blockingTaskId: BLOCKER })).toBeNull();
    expect(parsePathCollision({ path: '../x', blockingTaskId: BLOCKER })).toBeNull();
    expect(parsePathCollision({ path: '/etc/passwd', blockingTaskId: BLOCKER })).toBeNull();
    expect(parsePathCollision({ path: 'a.ts', blockingTaskId: 'not-a-uuid' })).toBeNull();
  });

  it('an unknown source is coerced, not trusted', () => {
    expect(parsePathCollision({ path: 'a.ts', blockingTaskId: BLOCKER, source: 'whatever' })!.source).toBe('sync');
  });
});

describe('recordPathCollisionDeferral', () => {
  beforeEach(() => {
    setCalls.length = 0;
    whereCalls.length = 0;
    returned = [{ id: 'task-1' }];
    mockUpdate.mockClear();
  });

  const collision = parsePathCollision({
    path: 'src/a.ts', blockingTaskId: BLOCKER, blockingPath: 'src', source: 'sync',
    checkpoint: { committed: true, sha: 'a'.repeat(40), pushed: true },
  })!;

  it('appends the collided path to the manifest, records the collision, sets the resume branch — one statement', async () => {
    const ok = await recordPathCollisionDeferral({ taskId: 'task-1', collision, branch: 'buildd/task-1' });
    expect(ok).toBe(true);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    const set = setCalls[0];

    const manifest = render(set.pathManifest);
    expect(manifest.sql).toContain('@>');
    expect(manifest.params).toContain('src/a.ts');

    const decl = render(set.pathDeclaration);
    expect(decl.sql).toContain("jsonb_set");
    expect(decl.sql).toContain("'declared'");
    expect(decl.params.some((p: unknown) => typeof p === 'string' && p.includes(BLOCKER))).toBe(true);

    const ctx = render(set.context);
    expect(ctx.params.some((p: unknown) => typeof p === 'string' && p.includes('buildd/task-1'))).toBe(true);

    expect(render(set.pathClaimRevision).sql).toContain('+ 1');

    // Never resurrects a cancelled task.
    const where = render(whereCalls[0]);
    expect(where.sql).toContain('"tasks"."id" = $');
    expect(where.sql).toContain('<>');
    expect(where.params).toContain('cancelled');
  });

  it('a checkpoint that was not pushed leaves the resume branch alone', async () => {
    const local = { ...collision, checkpoint: { committed: true, pushed: false } };
    await recordPathCollisionDeferral({ taskId: 'task-1', collision: local, branch: 'buildd/task-1' });
    expect(setCalls[0].context).toBeUndefined();
  });

  it('reports false when the task was cancelled in between (no row updated)', async () => {
    returned = [];
    expect(await recordPathCollisionDeferral({ taskId: 'task-1', collision, branch: 'b' })).toBe(false);
  });

  it('an unusable collision body writes nothing', async () => {
    expect(await recordPathCollisionDeferral({ taskId: 'task-1', collision: { path: '**' }, branch: 'b' })).toBe(false);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('never throws: a failed write is logged and reported false', async () => {
    mockUpdate.mockImplementationOnce(() => { throw new Error('db down'); });
    expect(await recordPathCollisionDeferral({ taskId: 'task-1', collision, branch: 'b' })).toBe(false);
  });
});
