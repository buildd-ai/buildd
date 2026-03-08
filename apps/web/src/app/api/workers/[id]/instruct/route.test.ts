import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockWorkersFindFirst = mock(() => null as any);
const mockWorkersUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => ({
      returning: mock(() => [{ id: 'worker-1' }]),
    })),
  })),
}));
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(null as any));
const mockTriggerEvent = mock(() => Promise.resolve());

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
}));

mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  channels: { worker: (id: string) => `private-worker-${id}` },
  events: { WORKER_COMMAND: 'worker:command' },
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

function createMockRequest(body?: any): NextRequest {
  const init: RequestInit = {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
  };
  if (body) {
    init.body = JSON.stringify(body);
  }
  return new NextRequest('http://localhost:3000/api/workers/worker-1/instruct', init);
}

function createMockRequestWithAuth(body?: any, apiKey?: string): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
  const init: RequestInit = {
    method: 'POST',
    headers: new Headers(headers),
  };
  if (body) init.body = JSON.stringify(body);
  return new NextRequest('http://localhost:3000/api/workers/worker-1/instruct', init);
}

const mockParams = Promise.resolve({ id: 'worker-1' });

describe('POST /api/workers/[id]/instruct', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockWorkersFindFirst.mockReset();
    mockWorkersUpdate.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockTriggerEvent.mockReset();

    mockWorkersUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => ({
          returning: mock(() => [{ id: 'worker-1' }]),
        })),
      })),
    });
  });

  it('returns 401 when no session and no admin token', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue(null);

    const req = createMockRequest({ message: 'do something' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toContain('Unauthorized');
  });

  it('returns 401 when API key is non-admin level', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1', level: 'worker' });

    const req = createMockRequestWithAuth({ message: 'do something' }, 'bld_test');
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(401);
  });

  it('allows session auth', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      status: 'running',
      workspace: { teamId: 'team-1' },
      instructionHistory: [],
      pendingInstructions: null,
    });

    const req = createMockRequest({ message: 'Fix the bug' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  it('allows admin-level API token', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1', level: 'admin' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      status: 'running',
      workspace: { teamId: 'other-team' },
      instructionHistory: [],
      pendingInstructions: null,
    });

    const req = createMockRequestWithAuth({ message: 'Fix the bug' }, 'bld_admin');
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);
  });

  it('returns 404 when worker not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockWorkersFindFirst.mockResolvedValue(null);

    const req = createMockRequest({ message: 'Fix the bug' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(404);
  });

  it('returns 404 when session user does not own workspace', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue(null);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      status: 'running',
      workspace: { teamId: 'other-team' },
    });

    const req = createMockRequest({ message: 'Fix the bug' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(404);
  });

  it('returns 400 when worker is completed', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      status: 'completed',
      workspace: { teamId: 'team-1' },
    });

    const req = createMockRequest({ message: 'Fix the bug' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('Cannot instruct completed or failed workers');
  });

  it('returns 400 when worker is failed', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      status: 'failed',
      workspace: { teamId: 'team-1' },
    });

    const req = createMockRequest({ message: 'Fix the bug' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(400);
  });

  it('returns 400 when message is missing', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      status: 'running',
      workspace: { teamId: 'team-1' },
      instructionHistory: [],
    });

    const req = createMockRequest({});
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('Message is required');
  });

  it('returns 400 when message is not a string', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      status: 'running',
      workspace: { teamId: 'team-1' },
      instructionHistory: [],
    });

    const req = createMockRequest({ message: 123 });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(400);
  });

  // Regression tests for waiting_input instruction delivery (PR #307)
  // Bug: instructions sent to waiting workers without priority:'urgent' were never
  // delivered because no Pusher event fired and the worker had no activity to poll.

  it('sends urgent priority via Pusher when priority is urgent', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      status: 'waiting_input',
      workspace: { teamId: 'team-1' },
      instructionHistory: [],
      pendingInstructions: null,
    });

    const req = createMockRequest({ message: 'Use JWT tokens', priority: 'urgent' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.message).toContain('instantly via Pusher');

    // Verify Pusher was called with correct channel and event
    expect(mockTriggerEvent).toHaveBeenCalledTimes(1);
    expect(mockTriggerEvent).toHaveBeenCalledWith(
      `private-worker-worker-1`,
      'worker:command',
      expect.objectContaining({ action: 'message', text: 'Use JWT tokens' })
    );
  });

  it('does not trigger Pusher when no priority is set', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      status: 'waiting_input',
      workspace: { teamId: 'team-1' },
      instructionHistory: [],
      pendingInstructions: null,
    });

    const req = createMockRequest({ message: 'Use JWT tokens' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.message).toContain('queued for delivery');

    // Pusher should NOT be called for non-urgent instructions
    expect(mockTriggerEvent).not.toHaveBeenCalled();
  });

  it('allows instructing waiting_input workers', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      status: 'waiting_input',
      workspace: { teamId: 'team-1' },
      instructionHistory: [],
      pendingInstructions: null,
    });

    const req = createMockRequest({ message: 'Answer to your question' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

});
