import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';
import { PgDialect } from 'drizzle-orm/pg-core';

// The ingest webhook resolves its target workspace only among the workspaces
// the authenticated account can reach, and issue lifecycle events only touch
// tasks in that workspace.

const mockAuthenticateApiKey = mock(async () => null as any);
const mockResolveWorkspace = mock(async (..._args: unknown[]) => null as any);
const mockDispatchNewTask = mock(async () => undefined);
const updateWheres: unknown[] = [];

mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/workspace-resolver', () => ({ resolveWorkspace: mockResolveWorkspace }));
mock.module('@/lib/task-dispatch', () => ({ dispatchNewTask: mockDispatchNewTask }));
mock.module('@buildd/core/db', () => ({
  db: {
    insert: () => ({
      values: () => ({ onConflictDoNothing: () => ({ returning: async () => [{ id: 'task-1' }] }) }),
    }),
    update: () => ({
      set: () => ({
        where: async (w: unknown) => {
          updateWheres.push(w);
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
  mockDispatchNewTask.mockReset();
  updateWheres.length = 0;
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
    expect(mockDispatchNewTask).toHaveBeenCalledTimes(1);
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
});
