import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockAuthenticateApiKey = mock(() => null as any);
const mockWorkersFindFirst = mock(() => null as any);
const mockTriggerEvent = mock(() => Promise.resolve());

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
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
    mockWorkersFindFirst.mockReset();
    mockTriggerEvent.mockReset();
  });

  it('returns 401 when no API key', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);

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
