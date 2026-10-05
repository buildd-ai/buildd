import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { NextRequest } from 'next/server';
import { TOKEN_PRESETS } from '@buildd/core/token-scopes';

const TASK_ID = '11111111-1111-1111-1111-111111111111';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => Promise.resolve(null as any));
const mockTasksFindFirst = mock(() => Promise.resolve(null as any));
const mockWorkersFindFirst = mock(() => Promise.resolve(null as any));
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(null as any));
const mockVerifyAccountWorkspaceAccess = mock(() => Promise.resolve(true));

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
const mockHoldsInWorkspace = mock(async (u: string, w: string, _permission: string) => {
  const access: any = await (mockVerifyWorkspaceAccess as any)(u, w);
  return !!access && (access.role === 'owner' || access.role === 'admin');
});
mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
  // The route asks for a named permission in the workspace's team; mirror the
  // registry default (owner, admin) over this file's access mock.
  holdsInWorkspace: mockHoldsInWorkspace,
  verifyAccountWorkspaceAccess: mockVerifyAccountWorkspaceAccess,
}));
mock.module('@buildd/core/db', () => ({
  db: {
    query: { teams: { findFirst: async () => null },
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
  beforeEach(() => mockWorkersFindFirst.mockClear());

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

  it('returns 404 to a signed-in user outside the task\'s workspace', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockImplementation(() => Promise.resolve(null));
    mockTasksFindFirst.mockResolvedValue({ id: TASK_ID, workspaceId: 'ws-1', workspace: { id: 'ws-1', teamId: 'team-1' } });
    mockWorkersFindFirst.mockResolvedValue({ id: 'worker-1', instructionHistory: [{ type: 'instruction', message: 'stop', timestamp: 1 }] });
    const res = await GET(req(), { params: Promise.resolve({ id: TASK_ID }) });
    expect(res.status).toBe(404);
    expect(mockWorkersFindFirst).not.toHaveBeenCalled();
  });

  it('canSend mirrors the instruct route: a member can read the feed but not send', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockImplementation(((_u: string, _w: string, role?: string) =>
      Promise.resolve(role === 'admin' ? null : { teamId: 'team-1', role: 'member' })) as any);
    mockTasksFindFirst.mockResolvedValue({ id: TASK_ID, workspaceId: 'ws-1', workspace: { id: 'ws-1', teamId: 'team-1' } });
    mockWorkersFindFirst.mockResolvedValue({ id: 'worker-1', instructionHistory: [] });
    const data = await (await GET(req(), { params: Promise.resolve({ id: TASK_ID }) })).json();
    expect(data.canSend).toBe(false);
  });

  it('canSend is true for a workspace admin', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockImplementation(() => Promise.resolve({ teamId: 'team-1', role: 'admin' }));
    mockTasksFindFirst.mockResolvedValue({ id: TASK_ID, workspaceId: 'ws-1', workspace: { id: 'ws-1', teamId: 'team-1' } });
    mockWorkersFindFirst.mockResolvedValue({ id: 'worker-1', instructionHistory: [] });
    const data = await (await GET(req(), { params: Promise.resolve({ id: TASK_ID }) })).json();
    expect(data.canSend).toBe(true);
  });

  it('canSend follows an admin API key\'s team, not just its level', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-1', level: 'admin', teamId: 'team-2' });
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
    mockTasksFindFirst.mockResolvedValue({ id: TASK_ID, workspaceId: 'ws-1', workspace: { id: 'ws-1', teamId: 'team-1' } });
    mockWorkersFindFirst.mockResolvedValue({ id: 'worker-1', instructionHistory: [] });
    const data = await (await GET(req(), { params: Promise.resolve({ id: TASK_ID }) })).json();
    expect(data.canSend).toBe(false);
  });

  for (const preset of ['ci', 'runner'] as const) {
    it(`canSend is false for a scoped ${preset} preset token of the task's team`, async () => {
      mockGetCurrentUser.mockResolvedValue(null);
      mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-1', level: 'admin', teamId: 'team-1', scopes: TOKEN_PRESETS[preset].scopes, workspaceIds: null });
      mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
      mockTasksFindFirst.mockResolvedValue({ id: TASK_ID, workspaceId: 'ws-1', workspace: { id: 'ws-1', teamId: 'team-1' } });
      mockWorkersFindFirst.mockResolvedValue({ id: 'worker-1', instructionHistory: [] });
      const data = await (await GET(req(), { params: Promise.resolve({ id: TASK_ID }) })).json();
      expect(data.canSend).toBe(false);
    });
  }

  it('returns the latest worker\'s messages and id', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockImplementation(() => Promise.resolve({ teamId: 'team-1', role: 'member' }));
    mockTasksFindFirst.mockResolvedValue({ id: TASK_ID, workspaceId: 'ws-1', workspace: { id: 'ws-1' } });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      instructionHistory: [{ type: 'instruction', message: 'stop', timestamp: 1, deliveryState: 'delivered' }],
    });

    const res = await GET(req(), { params: Promise.resolve({ id: TASK_ID }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workerId).toBe('worker-1');
    expect(data.messages).toHaveLength(1);
  });

  it('no worker yet: empty messages, not an error', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockImplementation(() => Promise.resolve({ teamId: 'team-1', role: 'member' }));
    mockTasksFindFirst.mockResolvedValue({ id: TASK_ID, workspaceId: 'ws-1', workspace: { id: 'ws-1' } });
    mockWorkersFindFirst.mockResolvedValue(null);

    const res = await GET(req(), { params: Promise.resolve({ id: TASK_ID }) });
    const data = await res.json();
    expect(data.workerId).toBeNull();
    expect(data.messages).toEqual([]);
  });
  describe('per-task token', () => {
    const SCOPED = { id: 'acct-1', level: 'worker', teamId: 'team-1', scopes: null, taskScope: { taskId: 'task-own', workspaceId: 'ws-1', expiresAt: Date.now() + 60_000 } };

    it("reads a task's messages in its own workspace, and may not send", async () => {
      mockGetCurrentUser.mockResolvedValue(null);
      mockAuthenticateApiKey.mockResolvedValue(SCOPED);
      mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
      mockTasksFindFirst.mockResolvedValue({ id: TASK_ID, workspaceId: 'ws-1', workspace: { id: 'ws-1', teamId: 'team-1' } });
      mockWorkersFindFirst.mockResolvedValue({ id: 'worker-1', instructionHistory: [{ type: 'instruction', message: 'stop', timestamp: 1 }] });
      const res = await GET(req(), { params: Promise.resolve({ id: TASK_ID }) });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.messages).toHaveLength(1);
      expect(data.canSend).toBe(false);
    });

    it('reads a task in another workspace as not found, even one its account can reach', async () => {
      mockGetCurrentUser.mockResolvedValue(null);
      mockAuthenticateApiKey.mockResolvedValue(SCOPED);
      mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
      mockTasksFindFirst.mockResolvedValue({ id: TASK_ID, workspaceId: 'ws-2', workspace: { id: 'ws-2', teamId: 'team-1' } });
      const res = await GET(req(), { params: Promise.resolve({ id: TASK_ID }) });
      expect(res.status).toBe(404);
      expect(mockWorkersFindFirst).not.toHaveBeenCalled();
    });

    it('an account key still reads any workspace it can reach', async () => {
      mockGetCurrentUser.mockResolvedValue(null);
      mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-1', level: 'worker', teamId: 'team-1' });
      mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
      mockTasksFindFirst.mockResolvedValue({ id: TASK_ID, workspaceId: 'ws-2', workspace: { id: 'ws-2', teamId: 'team-1' } });
      mockWorkersFindFirst.mockResolvedValue({ id: 'worker-1', instructionHistory: [] });
      const res = await GET(req(), { params: Promise.resolve({ id: TASK_ID }) });
      expect(res.status).toBe(200);
    });
  });
});
