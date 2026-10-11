import { describe, it, expect, beforeEach, mock } from 'bun:test';
// workers.id is a uuid column; the route 404s a non-UUID id before any lookup.
const WORKER_ID = '11111111-1111-4111-8111-111111111111';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockWorkersFindFirst = mock(() => null as any);
// The scope helper's read of a per-task token's own task.
const mockTasksFindFirst = mock(async () => ({ missionId: 'm-1', workspaceId: 'ws-1', mission: { initiativeId: null } }) as any);
const mockWorkersUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => ({
      returning: mock(() => [{ id: WORKER_ID }]),
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

const mockHoldsInWorkspace = mock(async (u: string, w: string, _permission: string) => {
  const access: any = await (mockVerifyWorkspaceAccess as any)(u, w);
  return !!access && (access.role === 'owner' || access.role === 'admin');
});
mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
  // The route asks for a named permission in the workspace's team; mirror the
  // registry default (owner, admin) over this file's access mock.
  holdsInWorkspace: mockHoldsInWorkspace,
}));

mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  channels: { worker: (id: string) => `private-worker-${id}` },
  events: { WORKER_COMMAND: 'worker:command' },
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: { teams: { findFirst: async () => null },
      workers: { findFirst: mockWorkersFindFirst },
      tasks: { findFirst: mockTasksFindFirst },
    },
    update: () => mockWorkersUpdate(),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
}));

mock.module('@buildd/core/db/schema', () => ({ teams: { id: 'teams.id', permissionOverrides: 'teams.permission_overrides' },
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

const mockParams = Promise.resolve({ id: WORKER_ID });

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
          returning: mock(() => [{ id: WORKER_ID }]),
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
      id: WORKER_ID,
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

  it('allows an admin-level API token from the worker\'s team', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1', teamId: 'team-1', level: 'admin' });
    mockWorkersFindFirst.mockResolvedValue({
      id: WORKER_ID,
      status: 'running',
      workspace: { teamId: 'team-1' },
      instructionHistory: [],
      pendingInstructions: null,
    });

    const req = createMockRequestWithAuth({ message: 'Fix the bug' }, 'bld_admin');
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);
  });

  describe("an orchestration task's admin per-task token", () => {
    const taskScope = { taskId: 'task-own', workspaceId: 'ws-1', expiresAt: Date.now() + 60_000 };
    const workerOn = (over: Record<string, unknown> = {}, task: Record<string, unknown> = {}) => ({
      id: WORKER_ID, status: 'running', workspaceId: 'ws-1', workspace: { teamId: 'team-1' },
      task: { id: 'task-sibling', workspaceId: 'ws-1', missionId: 'm-1', ...task },
      instructionHistory: [], pendingInstructions: null, ...over,
    });
    const send = () => POST(createMockRequestWithAuth({ message: 'Rebase onto main' }, 'bld_key'), { params: mockParams });

    it("instructs the worker of a task on its own task's mission", async () => {
      mockGetCurrentUser.mockResolvedValue(null);
      mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1', teamId: 'team-1', level: 'admin', scopes: null, taskScope });
      mockWorkersFindFirst.mockResolvedValue(workerOn());
      expect((await send()).status).toBe(200);
    });

    it('is refused a worker on another mission, in another workspace, or on a task with no mission, queueing nothing', async () => {
      mockGetCurrentUser.mockResolvedValue(null);
      mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1', teamId: 'team-1', level: 'admin', scopes: null, taskScope });
      for (const w of [workerOn({}, { missionId: 'm-2' }), workerOn({ workspaceId: 'ws-2' }, { workspaceId: 'ws-2' }), workerOn({ workspaceId: 'ws-2' }), workerOn({}, { missionId: null }), workerOn({ task: null })]) {
        mockWorkersFindFirst.mockResolvedValue(w);
        expect((await send()).status).toBe(404);
      }
      expect(mockWorkersUpdate).not.toHaveBeenCalled();
    });

    it('a worker-level task token is refused outright, even on its own mission', async () => {
      mockGetCurrentUser.mockResolvedValue(null);
      mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1', teamId: 'team-1', level: 'worker', scopes: null, taskScope });
      mockWorkersFindFirst.mockResolvedValue(workerOn());
      expect((await send()).status).toBe(401);
      expect(mockWorkersFindFirst).not.toHaveBeenCalled();
    });
  });

  it('returns 404 for an admin-level API token from a different team', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1', teamId: 'team-1', level: 'admin' });
    mockWorkersFindFirst.mockResolvedValue({
      id: WORKER_ID,
      status: 'running',
      workspace: { teamId: 'other-team' },
      instructionHistory: [],
      pendingInstructions: null,
    });

    const req = createMockRequestWithAuth({ message: 'Fix the bug' }, 'bld_admin');
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(404);
  });

  it('requires the admin role in the worker\'s team for session callers', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue(null);
    mockWorkersFindFirst.mockResolvedValue({
      id: WORKER_ID,
      workspaceId: 'ws-1',
      status: 'running',
      workspace: { teamId: 'team-1' },
    });

    const req = createMockRequest({ message: 'Fix the bug' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(404);
    expect(mockHoldsInWorkspace).toHaveBeenCalledWith('user-1', 'ws-1', 'steer_workers');
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
      id: WORKER_ID,
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
      id: WORKER_ID,
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
      id: WORKER_ID,
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
      id: WORKER_ID,
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
      id: WORKER_ID,
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
      id: WORKER_ID,
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
    // Wording must not assert a delivery Pusher cannot confirm.
    expect(data.message).toContain('via Pusher');

    // Verify Pusher was called with correct channel and event
    expect(mockTriggerEvent).toHaveBeenCalledTimes(1);
    expect(mockTriggerEvent).toHaveBeenCalledWith(
      `private-worker-${WORKER_ID}`,
      'worker:command',
      expect.objectContaining({ action: 'message', text: 'Use JWT tokens' })
    );
  });

  it('a queued message wakes the runner with a text-free deliver_pending, whatever the priority', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockWorkersFindFirst.mockResolvedValue({
      id: WORKER_ID,
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
    expect(data.message).toContain('Queued');

    // Delivery no longer waits for the worker to happen to be syncing: the
    // runner is woken to collect from the queue. The text never rides Pusher.
    expect(mockTriggerEvent).toHaveBeenCalledTimes(1);
    const [, event, payload] = (mockTriggerEvent.mock.calls[0] as unknown) as [string, string, any];
    expect(event).toBe('worker:command');
    expect(payload.action).toBe('deliver_pending');
    expect(payload.text).toBeUndefined();
  });

  it('B-5: urgent to an ack-capable runner pushes deliver_pending with no text', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1', teamId: 'team-1', level: 'admin' });
    mockWorkersFindFirst.mockResolvedValue({
      id: WORKER_ID,
      status: 'running',
      workspace: { teamId: 'team-1', dataClass: 'standard' },
      instructionHistory: [],
      pendingInstructions: null,
      supportsInstructionAck: true,
    });

    const res = await POST(createMockRequestWithAuth({ message: 'secret-ish text', priority: 'urgent' }, 'bld_admin'), { params: mockParams });
    expect(res.status).toBe(200);
    expect(mockTriggerEvent).toHaveBeenCalledTimes(1);
    const payload = (mockTriggerEvent.mock.calls[0] as any)[2];
    expect(payload).toMatchObject({ action: 'deliver_pending' });
    expect(JSON.stringify(payload)).not.toContain('secret-ish text');
    const data = await res.json();
    expect(typeof data.messageId).toBe('string');
  });

  it('allows instructing waiting_input workers', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockWorkersFindFirst.mockResolvedValue({
      id: WORKER_ID,
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

  describe('delivery state tracking', () => {
    it('sets deliveryState to "pending" for non-urgent messages', async () => {
      let capturedSet: any = null;
      mockWorkersUpdate.mockReturnValue({
        set: mock((updates: any) => {
          capturedSet = updates;
          return { where: mock(() => ({ returning: mock(() => [{ id: WORKER_ID }]) })) };
        }),
      });
      mockGetCurrentUser.mockResolvedValue(null);
      mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1', teamId: 'team-1', level: 'admin' });
      mockWorkersFindFirst.mockResolvedValue({
        id: WORKER_ID,
        status: 'running',
        workspace: { teamId: 'team-1', dataClass: 'standard' },
        instructionHistory: [],
        pendingInstructions: null,
      });

      const req = createMockRequestWithAuth({ message: 'Check the auth module' }, 'bld_admin');
      const res = await POST(req, { params: mockParams });

      expect(res.status).toBe(200);
      const entry = capturedSet.instructionHistory[0];
      expect(entry.deliveryState).toBe('pending');
      // Non-urgent: message is stored in pendingInstructions
      expect(capturedSet.pendingInstructions).toBe('Check the auth module');
    });

    // The Steer canvas measures "read at turn N" against the worker's turn
    // count *at send time* (messageDeliveryStatus in worker-instructions.ts) —
    // it has to be captured here, not derived later from a history entry that
    // never carried it.
    it('records the worker\'s current turn count as turnAtSend', async () => {
      let capturedSet: any = null;
      mockWorkersUpdate.mockReturnValue({
        set: mock((updates: any) => {
          capturedSet = updates;
          return { where: mock(() => ({ returning: mock(() => [{ id: WORKER_ID }]) })) };
        }),
      });
      mockGetCurrentUser.mockResolvedValue(null);
      mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1', teamId: 'team-1', level: 'admin' });
      mockWorkersFindFirst.mockResolvedValue({
        id: WORKER_ID,
        status: 'running',
        workspace: { teamId: 'team-1', dataClass: 'standard' },
        instructionHistory: [],
        pendingInstructions: null,
        turns: 7,
      });

      const req = createMockRequestWithAuth({ message: 'Check the auth module' }, 'bld_admin');
      const res = await POST(req, { params: mockParams });

      expect(res.status).toBe(200);
      expect(capturedSet.instructionHistory[0].turnAtSend).toBe(7);
    });

    // An urgent message goes out over Pusher, which is fire-and-forget: nothing
    // reports whether a runner was listening. Recording it as delivered at send
    // time meant the UI and get_task_messages asserted a delivery that may never
    // have happened, and the text was not kept anywhere, so it could not be
    // retried or even read back.
    it('keeps an urgent message pending and queued when the runner can confirm delivery', async () => {
      let capturedSet: any = null;
      mockWorkersUpdate.mockReturnValue({
        set: mock((updates: any) => {
          capturedSet = updates;
          return { where: mock(() => ({ returning: mock(() => [{ id: WORKER_ID }]) })) };
        }),
      });
      mockGetCurrentUser.mockResolvedValue(null);
      mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1', teamId: 'team-1', level: 'admin' });
      mockWorkersFindFirst.mockResolvedValue({
        id: WORKER_ID,
        status: 'running',
        workspace: { teamId: 'team-1', dataClass: 'standard' },
        instructionHistory: [],
        pendingInstructions: null,
        supportsInstructionAck: true,
      });

      const req = createMockRequestWithAuth({ message: 'Stop and pivot', priority: 'urgent' }, 'bld_admin');
      const res = await POST(req, { params: mockParams });

      expect(res.status).toBe(200);
      expect(capturedSet.instructionHistory[0].deliveryState).toBe('pending');
      // Queued as a fallback: a Pusher event that reaches nobody is recoverable.
      expect(capturedSet.pendingInstructions).toBe('Stop and pivot');
      expect(mockTriggerEvent).toHaveBeenCalledTimes(1);
      expect((mockTriggerEvent.mock.calls[0] as any)[2].text).toBeUndefined();
    });

    // Runners that predate the confirmation protocol would inject the Pusher copy
    // and then the queued copy. Their behaviour is unchanged: Pusher only.
    it('keeps the old Pusher-only behaviour for a runner that cannot confirm', async () => {
      let capturedSet: any = null;
      mockWorkersUpdate.mockReturnValue({
        set: mock((updates: any) => {
          capturedSet = updates;
          return { where: mock(() => ({ returning: mock(() => [{ id: WORKER_ID }]) })) };
        }),
      });
      mockGetCurrentUser.mockResolvedValue(null);
      mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1', teamId: 'team-1', level: 'admin' });
      mockWorkersFindFirst.mockResolvedValue({
        id: WORKER_ID,
        status: 'running',
        workspace: { teamId: 'team-1', dataClass: 'standard' },
        instructionHistory: [],
        pendingInstructions: null,
        supportsInstructionAck: false,
      });

      const req = createMockRequestWithAuth({ message: 'Stop and pivot', priority: 'urgent' }, 'bld_admin');
      const res = await POST(req, { params: mockParams });

      expect(res.status).toBe(200);
      expect(capturedSet.instructionHistory[0].deliveryState).toBe('delivered');
      expect(capturedSet.pendingInstructions).toBeNull();
    });

    // An interactive (claim_task, runner = 'mcp') worker has no runner listening
    // on Pusher at all: its session only ever reads the queue, through
    // update_progress, which then acknowledges. A Pusher-only urgent message to
    // one that has not called update_progress yet reached nobody and was lost.
    it('queues an urgent message for an interactive worker even before it has checked in', async () => {
      let capturedSet: any = null;
      mockWorkersUpdate.mockReturnValue({
        set: mock((updates: any) => {
          capturedSet = updates;
          return { where: mock(() => ({ returning: mock(() => [{ id: WORKER_ID }]) })) };
        }),
      });
      mockGetCurrentUser.mockResolvedValue(null);
      mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1', teamId: 'team-1', level: 'admin' });
      mockWorkersFindFirst.mockResolvedValue({
        id: WORKER_ID,
        status: 'running',
        runner: 'mcp',
        workspace: { teamId: 'team-1', dataClass: 'standard' },
        instructionHistory: [],
        pendingInstructions: null,
        supportsInstructionAck: false,
      });

      const req = createMockRequestWithAuth({ message: 'Stop and pivot', priority: 'urgent' }, 'bld_admin');
      const res = await POST(req, { params: mockParams });

      expect(res.status).toBe(200);
      expect(capturedSet.pendingInstructions).toBe('Stop and pivot');
      expect(capturedSet.instructionHistory[0].deliveryState).toBe('pending');
    });

    it('appends to the queue instead of overwriting an undelivered instruction', async () => {
      let capturedSet: any = null;
      mockWorkersUpdate.mockReturnValue({
        set: mock((updates: any) => {
          capturedSet = updates;
          return { where: mock(() => ({ returning: mock(() => [{ id: WORKER_ID }]) })) };
        }),
      });
      mockGetCurrentUser.mockResolvedValue(null);
      mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1', teamId: 'team-1', level: 'admin' });
      mockWorkersFindFirst.mockResolvedValue({
        id: WORKER_ID,
        status: 'running',
        workspace: { teamId: 'team-1', dataClass: 'standard' },
        instructionHistory: [],
        pendingInstructions: 'Use the device flow',
      });

      const req = createMockRequestWithAuth({ message: 'And add a test' }, 'bld_admin');
      const res = await POST(req, { params: mockParams });

      expect(res.status).toBe(200);
      expect(capturedSet.pendingInstructions).toBe('Use the device flow\n\nAnd add a test');
    });
  });

  // The check-in route rejects a worker in state 'error' with a 409 long before
  // it reaches the instruction hand-off, so "queued for delivery on next worker
  // check-in" described a check-in that can never happen.
  describe('unreachable worker statuses', () => {
    function errorWorker() {
      mockGetCurrentUser.mockResolvedValue(null);
      mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1', teamId: 'team-1', level: 'admin' });
      mockWorkersFindFirst.mockResolvedValue({
        id: WORKER_ID,
        status: 'error',
        workspace: { teamId: 'team-1', dataClass: 'standard' },
        instructionHistory: [],
        pendingInstructions: null,
        supportsInstructionAck: true,
      });
      mockWorkersUpdate.mockReturnValue({
        set: mock(() => ({ where: mock(() => ({ returning: mock(() => [{ id: WORKER_ID }]) })) })),
      });
    }

    it('refuses to queue for an error worker instead of promising delivery', async () => {
      errorWorker();
      const req = createMockRequestWithAuth({ message: 'Try the other flow' }, 'bld_admin');
      const res = await POST(req, { params: mockParams });

      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.error).toContain('error');
      expect(data.workerStatus).toBe('error');
      expect(data.hint).toContain('urgent');
      expect(mockTriggerEvent).not.toHaveBeenCalled();
    });

    it('still allows an urgent Pusher attempt at an error worker, without queueing it', async () => {
      let capturedSet: any = null;
      errorWorker();
      mockWorkersUpdate.mockReturnValue({
        set: mock((updates: any) => {
          capturedSet = updates;
          return { where: mock(() => ({ returning: mock(() => [{ id: WORKER_ID }]) })) };
        }),
      });

      const req = createMockRequestWithAuth({ message: 'Try the other flow', priority: 'urgent' }, 'bld_admin');
      const res = await POST(req, { params: mockParams });

      expect(res.status).toBe(200);
      expect(mockTriggerEvent).toHaveBeenCalledTimes(1);
      // Nothing queued: the check-in that would collect it is rejected.
      expect(capturedSet.pendingInstructions).toBeNull();
      const data = await res.json();
      expect(data.message).not.toContain('queued for delivery on next worker check-in');
    });
  });

  describe('sensitive workspace — instructionHistory redaction', () => {
    it('stores {type, ts} only in instructionHistory for sensitive workspaces', async () => {
      let capturedSet: any = null;
      mockWorkersUpdate.mockReturnValue({
        set: mock((updates: any) => {
          capturedSet = updates;
          return { where: mock(() => ({ returning: mock(() => [{ id: WORKER_ID }]) })) };
        }),
      });
      mockGetCurrentUser.mockResolvedValue(null);
      mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1', teamId: 'team-1', level: 'admin' });
      mockWorkersFindFirst.mockResolvedValue({
        id: WORKER_ID,
        status: 'running',
        workspace: { teamId: 'team-1', dataClass: 'sensitive' },
        instructionHistory: [],
        pendingInstructions: null,
      });

      const req = createMockRequestWithAuth({ message: 'Here is the secret token: abc123' }, 'bld_admin');
      const res = await POST(req, { params: mockParams });

      expect(res.status).toBe(200);
      expect(capturedSet.instructionHistory).toHaveLength(1);
      const entry = capturedSet.instructionHistory[0];
      expect(entry.type).toBe('instruction');
      expect(entry.timestamp).toBeDefined();
      // Message text must be suppressed
      expect(entry.message).toBeUndefined();
    });

    it('preserves message text in instructionHistory for standard workspaces', async () => {
      let capturedSet: any = null;
      mockWorkersUpdate.mockReturnValue({
        set: mock((updates: any) => {
          capturedSet = updates;
          return { where: mock(() => ({ returning: mock(() => [{ id: WORKER_ID }]) })) };
        }),
      });
      mockGetCurrentUser.mockResolvedValue(null);
      mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1', teamId: 'team-1', level: 'admin' });
      mockWorkersFindFirst.mockResolvedValue({
        id: WORKER_ID,
        status: 'running',
        workspace: { teamId: 'team-1', dataClass: 'standard' },
        instructionHistory: [],
        pendingInstructions: null,
      });

      const req = createMockRequestWithAuth({ message: 'Use JWT tokens' }, 'bld_admin');
      const res = await POST(req, { params: mockParams });

      expect(res.status).toBe(200);
      expect(capturedSet.instructionHistory[0].message).toBe('Use JWT tokens');
    });
  });

  // Not an owner route: steering is a role, and an admin of the worker's team
  // may steer a worker another member's session claimed. The owner rule in
  // lib/worker-owner.ts must not leak in here.
  describe("— role path acts on another member's session-claimed worker", () => {
    const claimedByA = () => ({
      id: WORKER_ID,
      status: 'running',
      accountId: 'account-1',
      claimedByUserId: 'user-a',
      workspaceId: 'ws-1',
      workspace: { teamId: 'team-1', dataClass: 'standard' },
      instructionHistory: [],
      pendingInstructions: null,
    });

    it('an admin-level OAuth session of the team instructs a worker user-a claimed', async () => {
      mockGetCurrentUser.mockResolvedValue(null);
      mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1', teamId: 'team-1', level: 'admin', sessionUserId: 'user-b', scopes: null });
      mockWorkersFindFirst.mockResolvedValue(claimedByA());

      const res = await POST(createMockRequestWithAuth({ message: 'Rebase' }, 'oauth_token'), { params: mockParams });

      expect(res.status).toBe(200);
      expect(mockWorkersUpdate).toHaveBeenCalledTimes(1);
    });

    it('a worker-level OAuth session of the same team is refused, queueing nothing', async () => {
      mockGetCurrentUser.mockResolvedValue(null);
      mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1', teamId: 'team-1', level: 'worker', sessionUserId: 'user-b', scopes: null });
      mockWorkersFindFirst.mockResolvedValue(claimedByA());

      const res = await POST(createMockRequestWithAuth({ message: 'Rebase' }, 'oauth_token'), { params: mockParams });

      expect(res.status).toBe(401);
      expect(mockWorkersUpdate).not.toHaveBeenCalled();
    });
  });
});
