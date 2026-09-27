import { describe, it, expect, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const TASK_ID = '11111111-1111-1111-1111-111111111111';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => Promise.resolve(null as any));
const mockTasksFindFirst = mock(() => Promise.resolve(null as any));
const mockWorkersFindFirst = mock(() => Promise.resolve(null as any));
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(null as any));
const mockVerifyAccountWorkspaceAccess = mock(() => Promise.resolve(true));

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
  verifyAccountWorkspaceAccess: mockVerifyAccountWorkspaceAccess,
}));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: { findFirst: mockTasksFindFirst },
      workers: { findFirst: mockWorkersFindFirst },
    },
  },
}));

const { GET } = await import('./route');

function req() {
  return new NextRequest(`https://buildd.test/api/tasks/${TASK_ID}/messages`, { method: 'GET' });
}

describe('GET /api/tasks/[id]/messages', () => {
  it('returns 404 when the task does not exist', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockTasksFindFirst.mockResolvedValue(null);
    const res = await GET(req(), { params: Promise.resolve({ id: TASK_ID }) });
    expect(res.status).toBe(404);
  });

  it('returns 401 with no session and no API key', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue(null);
    const res = await GET(req(), { params: Promise.resolve({ id: TASK_ID }) });
    expect(res.status).toBe(401);
  });

  it('returns the latest worker\'s messages, id, and current turn count — the Steer canvas measures "read" against it', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'member' });
    mockTasksFindFirst.mockResolvedValue({ id: TASK_ID, workspaceId: 'ws-1', workspace: { id: 'ws-1' } });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      turns: 9,
      instructionHistory: [{ type: 'instruction', message: 'stop', timestamp: 1, deliveryState: 'delivered', turnAtSend: 6 }],
    });

    const res = await GET(req(), { params: Promise.resolve({ id: TASK_ID }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workerId).toBe('worker-1');
    expect(data.turns).toBe(9);
    expect(data.messages).toHaveLength(1);
    expect(data.messages[0].turnAtSend).toBe(6);
  });

  it('no worker yet: empty messages and a null turn count, not an error', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'member' });
    mockTasksFindFirst.mockResolvedValue({ id: TASK_ID, workspaceId: 'ws-1', workspace: { id: 'ws-1' } });
    mockWorkersFindFirst.mockResolvedValue(null);

    const res = await GET(req(), { params: Promise.resolve({ id: TASK_ID }) });
    const data = await res.json();
    expect(data.workerId).toBeNull();
    expect(data.turns).toBeNull();
    expect(data.messages).toEqual([]);
  });
});
