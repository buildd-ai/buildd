import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';
import { PgDialect } from 'drizzle-orm/pg-core';

// The ingest webhook resolves its target workspace only among the workspaces
// the authenticated account can reach, and issue lifecycle events only touch
// tasks in that workspace.

const mockAuthenticateApiKey = mock(async () => null as any);
const mockResolveWorkspace = mock(async (..._args: unknown[]) => null as any);
const mockAnnounceTaskCreated = mock(async () => undefined);
const updateWheres: unknown[] = [];
let updateReturning: Array<{ id: string }> = [];

mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/workspace-resolver', () => ({ resolveWorkspace: mockResolveWorkspace }));
// The dispatch authority's full surface: mock.module is process-global.
const mockWakeTask = mock(async (_taskId: string, _cause: string, _opts?: unknown) => {});
mock.module('@/lib/dispatch-authority', () => ({
  announceTaskCreated: mockAnnounceTaskCreated,
  wakeTask: mockWakeTask,
  wakeTasks: mock(async () => {}),
  kickDispatch: () => {},
  enqueueTaskDispatch: async () => {},
  drainDispatchOutbox: async () => ({ claimed: 0, delivered: 0, skipped: 0, failed: 0 }),
  deliverTaskDispatch: async () => 'pusher',
  routeForCause: () => ({ event: 'task.created', legacyDefault: true, githubActions: true, legacyUnfilteredRunnerPreference: false }),
  webhookWants: () => false,
  primaryCause: (_causes: string[], fallback: string) => fallback,
  DISPATCH_DUE_QUEUE: 'dispatch',
  DRAIN_BATCH: 25,
  reseedDispatchTimer: async () => {},
}));
mock.module('@buildd/core/db', () => ({
  db: {
    insert: () => ({
      values: () => ({ onConflictDoNothing: () => ({ returning: async () => [{ id: 'task-1' }] }) }),
    }),
    update: () => ({
      set: () => ({
        // Awaitable bare (issue.closed) or with .returning() (issue.reopened).
        where: (w: unknown) => {
          updateWheres.push(w);
          return Object.assign(Promise.resolve(undefined), { returning: async () => updateReturning });
        },
      }),
    }),
  },
}));

import { POST } from './route';

const ACCOUNT = { id: 'acct-1', teamId: 'team-1', name: 'hook', level: 'trigger' };

function req(event: string, repo = 'acme/app') {
  return new NextRequest('http://localhost:3000/api/webhooks/ingest', {
    method: 'POST',
    headers: {
      authorization: 'Bearer bld_hook',
      'x-webhook-event': event,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      issue: { id: 'i-1', title: 'T', body: '', state: 'open', url: 'https://example.com/i/1', labels: [] },
      project: { id: 'p-1', name: 'P', repo },
    }),
  });
}

beforeEach(() => {
  mockAuthenticateApiKey.mockReset();
  mockResolveWorkspace.mockReset();
  mockAnnounceTaskCreated.mockReset();
  mockWakeTask.mockReset();
  updateWheres.length = 0;
  updateReturning = [];
  mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
});

describe('POST /api/webhooks/ingest', () => {
  it('resolves project.repo within the authenticated account scope', async () => {
    mockResolveWorkspace.mockResolvedValue(null);
    const res = await POST(req('issue.created'));
    expect(res.status).toBe(404);
    expect(mockResolveWorkspace).toHaveBeenCalledWith('acme/app', { account: ACCOUNT });
  });

  it('creates the task in the resolved in-scope workspace', async () => {
    mockResolveWorkspace.mockResolvedValue({ id: 'ws-1', teamId: 'team-1', webhookConfig: null });
    const res = await POST(req('issue.created'));
    expect(res.status).toBe(200);
    expect(mockAnnounceTaskCreated).toHaveBeenCalledTimes(1);
    expect(mockWakeTask).toHaveBeenCalledWith((mockAnnounceTaskCreated.mock.calls[0] as any[])[0].id, 'task.created');
  });

  it('limits lifecycle updates to tasks in the resolved workspace', async () => {
    mockResolveWorkspace.mockResolvedValue({ id: 'ws-1', teamId: 'team-1', webhookConfig: null });
    const res = await POST(req('issue.closed'));
    expect(res.status).toBe(200);
    expect(updateWheres.length).toBe(1);
    const q = new PgDialect().sqlToQuery(updateWheres[0] as any);
    expect(q.sql).toContain('"workspace_id"');
    expect(q.params).toContain('ws-1');
  });

  // Reopening makes the task pending again: the trigger records the intent,
  // and the route kicks delivery with the reason.
  it('wakes the reopened task as a requeue', async () => {
    mockResolveWorkspace.mockResolvedValue({ id: 'ws-1', teamId: 'team-1', webhookConfig: null });
    updateReturning = [{ id: 'task-9' }];
    const res = await POST(req('issue.reopened'));
    expect(res.status).toBe(200);
    expect(mockWakeTask).toHaveBeenCalledWith('task-9', 'task.requeued');
    expect(mockAnnounceTaskCreated).not.toHaveBeenCalled();
  });

  it('wakes nothing when no task matched the reopened issue', async () => {
    mockResolveWorkspace.mockResolvedValue({ id: 'ws-1', teamId: 'team-1', webhookConfig: null });
    await POST(req('issue.reopened'));
    expect(mockWakeTask).not.toHaveBeenCalled();
  });
});
