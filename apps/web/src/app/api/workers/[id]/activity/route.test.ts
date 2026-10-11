import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';
import { TOKEN_PRESETS } from '@buildd/core/token-scopes';

const mockAuthenticateApiKey = mock(() => null as any);
const mockWorkersFindFirst = mock(() => null as any);
const mockWorkersUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => Promise.resolve()),
  })),
}));

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findFirst: mockWorkersFindFirst },
    },
    update: () => mockWorkersUpdate(),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  workers: 'workers',
}));

import { POST } from './route';

function createMockRequest(body?: any, apiKey?: string): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
  const init: RequestInit = {
    method: 'POST',
    headers: new Headers(headers),
  };
  if (body) init.body = JSON.stringify(body);
  return new NextRequest('http://localhost:3000/api/workers/worker-1/activity', init);
}

// workers.id is a uuid column; the route 404s a non-UUID id before any lookup.
const WORKER_ID = '11111111-1111-4111-8111-111111111111';
const mockParams = Promise.resolve({ id: WORKER_ID });

describe('POST /api/workers/[id]/activity', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockWorkersFindFirst.mockReset();
    mockWorkersUpdate.mockReset();

    mockWorkersUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => Promise.resolve()),
      })),
    });
  });

  it('returns 401 when no API key', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);

    const req = createMockRequest({ toolName: 'Read' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(401);
  });

  it('returns 404 when worker not found', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue(null);

    const req = createMockRequest({ toolName: 'Read' }, 'bld_test');
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(404);
  });

  it('returns 404 for an account that neither runs the worker nor administers its team', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-2', teamId: 'team-2', level: 'admin' });
    mockWorkersFindFirst.mockResolvedValue({
      id: WORKER_ID,
      accountId: 'account-1',
      milestones: [],
      workspace: { teamId: 'team-1' },
    });

    const req = createMockRequest({ toolName: 'Read' }, 'bld_other');
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(404);
    expect(mockWorkersUpdate).not.toHaveBeenCalled();
  });

  it('returns 404 for a non-admin account of the same team that does not run the worker', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-3', teamId: 'team-1', level: 'worker' });
    mockWorkersFindFirst.mockResolvedValue({
      id: WORKER_ID,
      accountId: 'account-1',
      milestones: [],
      workspace: { teamId: 'team-1' },
    });

    const req = createMockRequest({ toolName: 'Read' }, 'bld_sameteam');
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(404);
  });

  it('accepts an admin-level account of the worker\'s team', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-9', teamId: 'team-1', level: 'admin' });
    mockWorkersFindFirst.mockResolvedValue({
      id: WORKER_ID,
      accountId: 'account-1',
      milestones: [],
      workspace: { teamId: 'team-1' },
    });

    const req = createMockRequest({ toolName: 'Read' }, 'bld_admin');
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);
  });

  for (const preset of ['ci', 'runner'] as const) {
    it(`returns 404 for a scoped ${preset} preset token of the team that does not run the worker`, async () => {
      mockAuthenticateApiKey.mockResolvedValue({ id: 'account-9', teamId: 'team-1', level: 'admin', scopes: TOKEN_PRESETS[preset].scopes, workspaceIds: null });
      mockWorkersFindFirst.mockResolvedValue({ id: WORKER_ID, accountId: 'account-1', milestones: [], workspace: { teamId: 'team-1' } });
      const res = await POST(createMockRequest({ toolName: 'Read' }, 'bld_scoped'), { params: mockParams });
      expect(res.status).toBe(404);
    });
  }

  it('returns 400 when toolName missing', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: WORKER_ID,
      accountId: 'account-1',
      milestones: [],
    });

    const req = createMockRequest({}, 'bld_test');
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('toolName is required');
  });

  it('records activity milestone for Read tool', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: WORKER_ID,
      accountId: 'account-1',
      milestones: [],
    });

    const req = createMockRequest({
      toolName: 'Read',
      toolInput: { file_path: '/src/lib/api.ts' },
    }, 'bld_test');
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.milestone.label).toBe('Read api.ts');
  });

  it('records activity milestone for Bash tool', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: WORKER_ID,
      accountId: 'account-1',
      milestones: [],
    });

    const req = createMockRequest({
      toolName: 'Bash',
      toolInput: { command: 'git commit -m "fix: bug"' },
    }, 'bld_test');
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.milestone.label).toBe('Git commit');
  });

  it('records activity milestone for Grep tool', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: WORKER_ID,
      accountId: 'account-1',
      milestones: [],
    });

    const req = createMockRequest({
      toolName: 'Grep',
      toolInput: { pattern: 'authenticateApiKey' },
    }, 'bld_test');
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.milestone.label).toBe('Search: authenticateApiKey');
  });

  it('deduplicates identical milestones within 1 second', async () => {
    const now = Date.now();
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: WORKER_ID,
      accountId: 'account-1',
      milestones: [{ label: 'Read api.ts', timestamp: now }],
    });

    const req = createMockRequest({
      toolName: 'Read',
      toolInput: { file_path: '/src/lib/api.ts' },
      timestamp: now + 500, // within 1 second
    }, 'bld_test');
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.deduplicated).toBe(true);
  });
});

// Invariant: an OAuth session resolves to an account its whole team shares, so
// the account id alone does not say who claimed the worker. Only the session
// user recorded as claimedByUserId owns it; the team-admin path is separate.
describe('POST /api/workers/[id]/activity — OAuth session owner check', () => {
  const sessionWorker = {
    id: WORKER_ID,
    accountId: 'account-1',
    taskId: 'task-1',
    workspaceId: 'ws-1',
    claimedByUserId: 'user-a',
    milestones: [],
    workspace: { teamId: 'team-1' },
  };

  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockWorkersFindFirst.mockReset();
    mockWorkersUpdate.mockReset();
    mockWorkersUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => Promise.resolve()),
      })),
    });
    mockWorkersFindFirst.mockResolvedValue(sessionWorker);
  });

  it('allows the OAuth session that claimed the worker', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1', teamId: 'team-1', sessionUserId: 'user-a', level: 'worker' });
    const res = await POST(createMockRequest({ toolName: 'Read' }, 'oauth_a'), { params: mockParams });
    expect(res.status).toBe(200);
    expect(mockWorkersUpdate).toHaveBeenCalled();
  });

  it('refuses another same-team OAuth member on the shared account and writes nothing', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1', teamId: 'team-1', sessionUserId: 'user-b', level: 'worker' });
    const res = await POST(createMockRequest({ toolName: 'Read' }, 'oauth_b'), { params: mockParams });
    expect(res.status).toBe(404);
    expect(mockWorkersUpdate).not.toHaveBeenCalled();
  });

  it('still lets an admin-level member of the worker\'s team write via the team-admin path', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1', teamId: 'team-1', sessionUserId: 'user-b', level: 'admin' });
    const res = await POST(createMockRequest({ toolName: 'Read' }, 'oauth_b_admin'), { params: mockParams });
    expect(res.status).toBe(200);
    expect(mockWorkersUpdate).toHaveBeenCalled();
  });

  it('refuses a session with no team id, even as the claiming user', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1', teamId: null, sessionUserId: 'user-a', level: 'worker' });
    const res = await POST(createMockRequest({ toolName: 'Read' }, 'oauth_noteam'), { params: mockParams });
    expect(res.status).toBe(404);
    expect(mockWorkersUpdate).not.toHaveBeenCalled();
  });
});
