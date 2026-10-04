import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

type Row = Record<string, unknown>;

// Stands in for the stamp: the claim UPDATE returns a row once, then nothing,
// exactly as the real `deferredDispatchedFor` guard does across ticks.
let dueRows: Row[] = [];
const executed: unknown[] = [];
const mockExecute = mock(async (query: unknown) => {
  executed.push(query);
  const rows = dueRows;
  dueRows = [];
  return { rows };
});
const WEBHOOK_WS = { id: 'ws-hook', name: 'Hooked', repo: 'o/r', webhookConfig: { enabled: true, url: 'https://x.test/hook', token: 't' } };
const PLAIN_WS = { id: 'ws-plain', name: 'Plain', repo: null, webhookConfig: null };
const SCHEDULED_WS = {
  id: 'ws-sched', name: 'Sched', repo: 'o/r',
  webhookConfig: { enabled: true, url: 'https://x.test/hook', token: 't', events: ['task.retry', 'task.scheduled'] },
};

mock.module('@buildd/core/db', () => ({
  db: {
    execute: mockExecute,
    query: { workspaces: { findMany: mock(async () => [WEBHOOK_WS, PLAIN_WS, SCHEDULED_WS]) } },
  },
}));

const mockDispatch = mock((..._args: unknown[]) => Promise.resolve());
mock.module('@/lib/task-dispatch', () => ({ dispatchRetriedTask: mockDispatch }));

import { sweepDeferredDispatch, claimDueDeferredTasksQuery } from './deferred-dispatch-sweep';
import { notHeldOrLocal } from '@/app/api/workers/claim/held-gate';
import { depsGate } from '@/app/api/workers/claim/deps-gate';

const dialect = new PgDialect();
const render = (q: Parameters<PgDialect['sqlToQuery']>[0]) =>
  dialect.sqlToQuery(q).sql.replace(/\$\d+/g, '$?').replace(/\s+/g, ' ');

const row = (id: string, workspaceId: string): Row => ({
  id, title: `Task ${id}`, description: null, workspaceId, mode: 'execution', priority: 0,
  missionId: null, backend: 'claude', roleSlug: null, runnerPreference: 'any',
});

beforeEach(() => {
  dueRows = [];
  executed.length = 0;
  mockExecute.mockClear();
  mockDispatch.mockReset();
  mockDispatch.mockResolvedValue(undefined);
});

describe('sweepDeferredDispatch', () => {
  it('dispatches a task whose startAt has passed through dispatchRetriedTask with its workspace', async () => {
    dueRows = [row('t1', 'ws-hook'), row('t2', 'ws-plain')];
    const result = await sweepDeferredDispatch();

    expect(result).toEqual({ dispatched: 2, failed: 0 });
    expect(mockDispatch).toHaveBeenCalledTimes(2);
    const [task, workspace] = mockDispatch.mock.calls[0] as [{ id: string; startAt?: unknown }, { id: string }];
    expect(task.id).toBe('t1');
    // No startAt: dispatchRetriedTask must not read the task as still deferred.
    expect(task.startAt).toBeUndefined();
    expect(workspace.id).toBe('ws-hook');
    expect((mockDispatch.mock.calls[1] as [unknown, { id: string }])[1].id).toBe('ws-plain');
  });

  it('dispatches exactly once across ticks: the second tick claims nothing', async () => {
    dueRows = [row('t1', 'ws-hook')];
    const first = await sweepDeferredDispatch();
    const second = await sweepDeferredDispatch();

    expect(first.dispatched).toBe(1);
    expect(second).toEqual({ dispatched: 0, failed: 0 });
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it('stays the backstop for a webhook that schedules its own wake: a due task is still dispatched', async () => {
    // A workspace whose webhook lists task.scheduled got the dispatch when the
    // task was deferred; the sweep sends it again when due regardless, and the
    // consumer treats a dispatch for a live or already-woken run as a no-op.
    dueRows = [row('t1', 'ws-sched')];
    const result = await sweepDeferredDispatch();
    expect(result).toEqual({ dispatched: 1, failed: 0 });
    const [task, workspace] = mockDispatch.mock.calls[0] as [{ id: string; startAt?: unknown }, { id: string }];
    expect(task.startAt).toBeUndefined();
    expect(workspace.id).toBe('ws-sched');
  });

  it('does nothing when no task is due', async () => {
    expect(await sweepDeferredDispatch()).toEqual({ dispatched: 0, failed: 0 });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('releases the stamp of a task whose dispatch threw so the next tick retries it', async () => {
    dueRows = [row('t1', 'ws-hook'), row('t2', 'ws-plain')];
    mockDispatch.mockRejectedValueOnce(new Error('pusher down'));
    const result = await sweepDeferredDispatch();

    expect(result).toEqual({ dispatched: 1, failed: 1 });
    // claim + one stamp release
    expect(executed).toHaveLength(2);
    const release = dialect.sqlToQuery(executed[1] as Parameters<PgDialect['sqlToQuery']>[0]);
    expect(release.sql).toContain('context" - ');
    expect(release.params).toContain('t1');
  });
});

describe('claimDueDeferredTasksQuery', () => {
  const text = render(claimDueDeferredTasksQuery(50));

  it('only takes pending tasks whose startAt has passed', () => {
    expect(text).toContain(`"tasks"."status" = 'pending'`);
    expect(text).toContain('"tasks"."start_at" <= now()');
  });

  it('skips held, local-executor and single-held tasks, and unresolved dependencies, via the claim gates', () => {
    expect(text).toContain(render(notHeldOrLocal()));
    expect(text).toContain(render(depsGate()));
  });

  it('stamps the dispatched startAt in the same UPDATE that selects the row, and guards on it twice', () => {
    expect(text).toContain('UPDATE "tasks" SET context =');
    expect(text).toContain('jsonb_build_object(');
    // Inner select and outer UPDATE both carry the not-yet-stamped guard.
    expect(text.split('IS DISTINCT FROM').length - 1).toBe(2);
    expect(text).toContain('RETURNING');
  });
});
