import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockAuthenticateApiKey = mock(() => null as any);
const mockGetCurrentUser = mock(() => null as any);
const mockVerifyWorkspaceAccess = mock(() => null as any);
const mockWorkersFindFirst = mock(() => null as any);
const mockTriggerEvent = mock(() => Promise.resolve());
let workersUpdateSets: any[] = [];
const mockWorkersUpdate = mock(() => ({
  set: mock((vals: any) => {
    workersUpdateSets.push(vals);
    return { where: mock(() => Promise.resolve()) };
  }),
}));

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
}));

mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  channels: {
    worker: (id: string) => `worker-${id}`,
  },
  events: {
    WORKER_COMMAND: 'worker:command',
  },
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
  return new NextRequest('http://localhost:3000/api/workers/worker-1/cmd', init);
}

const mockParams = Promise.resolve({ id: 'worker-1' });

describe('POST /api/workers/[id]/cmd', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockGetCurrentUser.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockWorkersFindFirst.mockReset();
    mockTriggerEvent.mockReset();
    mockWorkersUpdate.mockClear();
    workersUpdateSets = [];
    mockGetCurrentUser.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue(null);
  });

  it('returns 401 when no session and no API key', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockGetCurrentUser.mockResolvedValue(null);

    const req = createMockRequest({ action: 'pause' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(401);
  });

  it('returns 404 when worker not found', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue(null);

    const req = createMockRequest({ action: 'pause' }, 'bld_test');
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(404);
  });

  it('returns 403 when worker belongs to different account', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-2',
    });

    const req = createMockRequest({ action: 'pause' }, 'bld_test');
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(403);
  });

  it('returns 400 for invalid action', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-1',
    });

    const req = createMockRequest({ action: 'invalid' }, 'bld_test');
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('Invalid action');
  });

  it('sends pause command via Pusher', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-1',
    });

    const req = createMockRequest({ action: 'pause' }, 'bld_test');
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.action).toBe('pause');
    expect(mockTriggerEvent).toHaveBeenCalledWith(
      'worker-worker-1',
      'worker:command',
      expect.objectContaining({ action: 'pause' })
    );
  });

  it('sends abort command via Pusher', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-1',
    });

    const req = createMockRequest({ action: 'abort' }, 'bld_test');
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);
    expect(mockTriggerEvent).toHaveBeenCalledWith(
      'worker-worker-1',
      'worker:command',
      expect.objectContaining({ action: 'abort' })
    );
  });

  it('sends message command with text', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-1',
    });

    const req = createMockRequest({ action: 'message', text: 'Hello worker' }, 'bld_test');
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);
    expect(mockTriggerEvent).toHaveBeenCalledWith(
      'worker-worker-1',
      'worker:command',
      expect.objectContaining({ action: 'message', text: 'Hello worker' })
    );
  });

  // The message action is human input to the agent. It used to fire the Pusher
  // event and persist nothing, so the task UI's message list and
  // get_task_messages under-reported every message sent through this route.
  describe('action: message — history', () => {
    it('records the message in instructionHistory', async () => {
      mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
      mockWorkersFindFirst.mockResolvedValue({
        id: 'worker-1',
        accountId: 'account-1',
        workspace: { dataClass: 'standard' },
        instructionHistory: [{ type: 'response', message: 'earlier', timestamp: 1 }],
        supportsInstructionAck: true,
      });

      const req = createMockRequest({ action: 'message', text: 'Try the device flow' }, 'bld_test');
      const res = await POST(req, { params: mockParams });

      expect(res.status).toBe(200);
      expect(workersUpdateSets).toHaveLength(1);
      const history = workersUpdateSets[0].instructionHistory;
      expect(history).toHaveLength(2);
      expect(history[1]).toMatchObject({
        type: 'instruction',
        message: 'Try the device flow',
        deliveryState: 'pending',
      });
    });

    it('redacts the text for sensitive workspaces', async () => {
      mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
      mockWorkersFindFirst.mockResolvedValue({
        id: 'worker-1',
        accountId: 'account-1',
        workspace: { dataClass: 'sensitive' },
        instructionHistory: [],
        supportsInstructionAck: true,
      });

      const req = createMockRequest({ action: 'message', text: 'token abc123' }, 'bld_test');
      await POST(req, { params: mockParams });

      const entry = workersUpdateSets[0].instructionHistory[0];
      expect(entry.type).toBe('instruction');
      expect(entry.message).toBeUndefined();
    });

    it('records delivered for a runner that cannot confirm delivery', async () => {
      mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
      mockWorkersFindFirst.mockResolvedValue({
        id: 'worker-1',
        accountId: 'account-1',
        workspace: { dataClass: 'standard' },
        instructionHistory: [],
        supportsInstructionAck: false,
      });

      const req = createMockRequest({ action: 'message', text: 'hi' }, 'bld_test');
      await POST(req, { params: mockParams });

      expect(workersUpdateSets[0].instructionHistory[0].deliveryState).toBe('delivered');
    });

    it('writes no history for non-message commands', async () => {
      mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
      mockWorkersFindFirst.mockResolvedValue({
        id: 'worker-1',
        accountId: 'account-1',
        workspace: { dataClass: 'standard' },
        instructionHistory: [],
      });

      const req = createMockRequest({ action: 'abort' }, 'bld_test');
      await POST(req, { params: mockParams });

      expect(workersUpdateSets).toHaveLength(0);
    });
  });

  it('accepts resume command', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-1',
    });

    const req = createMockRequest({ action: 'resume' }, 'bld_test');
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.action).toBe('resume');
  });
});
