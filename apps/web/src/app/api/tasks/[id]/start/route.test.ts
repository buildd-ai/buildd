import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Mock functions
const mockGetCurrentUser = mock(() => null as any);
const mockTasksFindFirst = mock(() => null as any);
const mockWorkersFindMany = mock(() => [] as any[]);
const mockMissionsFindFirst = mock(() => null as any);
const mockWorkspaceSkillsFindMany = mock(() => [] as any[]);
const mockConnectorsFindMany = mock(() => [] as any[]);
const mockConnectorSharesFindMany = mock(() => [] as any[]);
const mockConnectorWorkspacesFindMany = mock(() => [] as any[]);
const mockTasksUpdate = mock(() => Promise.resolve());
const mockTriggerEvent = mock(() => Promise.resolve());
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(null as any));
const mockVerifyAccountWorkspaceAccess = mock(() => Promise.resolve(true));

// Mock auth-helpers
mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

// Mock api-auth
mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: async () => null,
  hashApiKey: (key: string) => `hashed_${key}`,
  extractApiKeyPrefix: (key: string) => key.substring(0, 12),
}));

// Mock team-access
mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
  verifyAccountWorkspaceAccess: mockVerifyAccountWorkspaceAccess,
}));

// Mock pusher
mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  channels: {
    workspace: (id: string) => `workspace-${id}`,
    task: (id: string) => `task-${id}`,
    worker: (id: string) => `worker-${id}`,
  },
  events: {
    TASK_CREATED: 'task:created',
    TASK_ASSIGNED: 'task:assigned',
    TASK_CLAIMED: 'task:claimed',
    TASK_COMPLETED: 'task:completed',
    TASK_FAILED: 'task:failed',
    WORKER_STARTED: 'worker:started',
    WORKER_PROGRESS: 'worker:progress',
    WORKER_COMPLETED: 'worker:completed',
    WORKER_FAILED: 'worker:failed',
  },
}));

// Mock database
const mockDbUpdate = {
  set: mock(() => ({ where: mock(() => Promise.resolve()) })),
};
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: { findFirst: mockTasksFindFirst },
      workers: { findMany: mockWorkersFindMany },
      missions: { findFirst: mockMissionsFindFirst },
      workspaceSkills: { findMany: mockWorkspaceSkillsFindMany },
      connectors: { findMany: mockConnectorsFindMany },
      connectorShares: { findMany: mockConnectorSharesFindMany },
      connectorWorkspaces: { findMany: mockConnectorWorkspacesFindMany },
    },
    update: mock(() => mockDbUpdate),
  },
}));

// Mock drizzle-orm
mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => ({ type: 'and', args }),
  or: (...args: any[]) => ({ type: 'or', args }),
  isNull: (field: any) => ({ field, type: 'isNull' }),
  isNotNull: (field: any) => ({ field, type: 'isNotNull' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
}));

// Mock schema
mock.module('@buildd/core/db/schema', () => ({
  tasks: { id: 'id', workspaceId: 'workspaceId', status: 'status', context: 'context', dependsOn: 'dependsOn', updatedAt: 'updatedAt', missionId: 'missionId', roleSlug: 'roleSlug', startAt: 'startAt' },
  workers: { taskId: 'taskId', prUrl: 'prUrl', mergedAt: 'mergedAt', workspaceId: 'workspaceId', status: 'status' },
  missions: { id: 'id', isHeld: 'isHeld' },
  workspaceSkills: { slug: 'slug', isRole: 'isRole', enabled: 'enabled', teamId: 'teamId', workspaceId: 'workspaceId', connectorRefs: 'connectorRefs' },
  connectors: { id: 'id', teamId: 'teamId', name: 'name' },
  connectorShares: { connectorId: 'connectorId', sharedWithTeamId: 'sharedWithTeamId' },
  connectorWorkspaces: { connectorId: 'connectorId', workspaceId: 'workspaceId', enabled: 'enabled' },
  accountWorkspaces: {},
  workspaces: {},
}));

// Import handler AFTER mocks
import { POST } from './route';

// Helper to create mock NextRequest
function createMockRequest(options: {
  body?: any;
} = {}): NextRequest {
  const { body } = options;

  const url = 'http://localhost:3000/api/tasks/task-123/start';
  const init: RequestInit = {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
  };

  if (body) {
    init.body = JSON.stringify(body);
  }

  return new NextRequest(url, init);
}

// Helper to call route handler with params
async function callHandler(request: NextRequest, id: string) {
  return POST(request, { params: Promise.resolve({ id }) });
}

describe('POST /api/tasks/[id]/start', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockTasksFindFirst.mockReset();
    mockWorkersFindMany.mockReset();
    mockMissionsFindFirst.mockReset();
    mockWorkspaceSkillsFindMany.mockReset();
    mockConnectorsFindMany.mockReset();
    mockConnectorSharesFindMany.mockReset();
    mockConnectorWorkspacesFindMany.mockReset();
    mockTriggerEvent.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();

    // Default: grant access, no blocking dep workers, no connectors, no held mission, no active workers
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
    mockWorkersFindMany.mockResolvedValue([]);
    mockMissionsFindFirst.mockResolvedValue(null);
    mockWorkspaceSkillsFindMany.mockResolvedValue([]);
    mockConnectorsFindMany.mockResolvedValue([]);
    mockConnectorSharesFindMany.mockResolvedValue([]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([]);
  });

  it('returns 401 when no session auth (API key not supported)', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    const request = createMockRequest();
    const response = await callHandler(request, 'task-123');

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 404 when task not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(null);

    const request = createMockRequest();
    const response = await callHandler(request, 'nonexistent-task');

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Task not found');
  });

  it('returns 404 when user does not own workspace', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'pending',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);
    mockVerifyWorkspaceAccess.mockResolvedValue(null);

    const request = createMockRequest();
    const response = await callHandler(request, 'task-123');

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Task not found');
  });

  it('starts pending task and broadcasts TASK_ASSIGNED event', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'pending',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1', name: 'Test Workspace', repo: 'test/repo' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const request = createMockRequest();
    const response = await callHandler(request, 'task-123');

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.started).toBe(true);
    expect(data.taskId).toBe('task-123');
    expect(data.targetLocalUiUrl).toBeNull();

    // Should trigger TASK_ASSIGNED event with minimal payload
    expect(mockTriggerEvent).toHaveBeenCalledWith(
      'workspace-ws-1',
      'task:assigned',
      {
        task: {
          id: 'task-123',
          title: 'Test Task',
          description: undefined,
          workspaceId: 'ws-1',
          status: 'pending',
          mode: undefined,
          priority: undefined,
          workspace: {
            name: 'Test Workspace',
            repo: 'test/repo',
          },
        },
        targetLocalUiUrl: null,
      }
    );
  });

  it('includes targetLocalUiUrl in TASK_ASSIGNED event when provided', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'pending',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1', name: 'Test Workspace', repo: 'test/repo' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const request = createMockRequest({
      body: { targetLocalUiUrl: 'http://localhost:3456' },
    });
    const response = await callHandler(request, 'task-123');

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.started).toBe(true);
    expect(data.targetLocalUiUrl).toBe('http://localhost:3456');

    // Should trigger TASK_ASSIGNED with the targetLocalUiUrl and minimal payload
    expect(mockTriggerEvent).toHaveBeenCalledWith(
      'workspace-ws-1',
      'task:assigned',
      {
        task: {
          id: 'task-123',
          title: 'Test Task',
          description: undefined,
          workspaceId: 'ws-1',
          status: 'pending',
          mode: undefined,
          priority: undefined,
          workspace: {
            name: 'Test Workspace',
            repo: 'test/repo',
          },
        },
        targetLocalUiUrl: 'http://localhost:3456',
      }
    );
  });

  it('returns 400 when task status is not pending', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'assigned',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const request = createMockRequest();
    const response = await callHandler(request, 'task-123');

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('Cannot start task with status: assigned');
    expect(data.status).toBe('assigned');
  });

  it('returns 400 when task is running', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'running',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const request = createMockRequest();
    const response = await callHandler(request, 'task-123');

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('Cannot start task with status: running');
  });

  it('returns 400 when task is completed', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'completed',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const request = createMockRequest();
    const response = await callHandler(request, 'task-123');

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('Cannot start task with status: completed');
  });

  it('handles empty body gracefully', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'pending',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    // Create request without body
    const request = new NextRequest('http://localhost:3000/api/tasks/task-123/start', {
      method: 'POST',
    });
    const response = await callHandler(request, 'task-123');

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.started).toBe(true);
    expect(data.targetLocalUiUrl).toBeNull();
  });

  it('requires confirmation before manually starting a deferred task', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue({
      id: 'task-123',
      title: 'Later task',
      status: 'pending',
      workspaceId: 'ws-1',
      startAt: new Date(Date.now() + 60 * 60 * 1000),
      context: {},
      workspace: { id: 'ws-1', teamId: 'team-1' },
    });

    const response = await callHandler(createMockRequest(), 'task-123');
    expect(response.status).toBe(422);
    const data = await response.json();
    expect(data.gateReason).toBe('deferred_start');
    expect(data.canForce).toBe(true);
    expect(mockTriggerEvent).not.toHaveBeenCalled();
  });

  it('starts a deferred task when the human confirms the override', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue({
      id: 'task-123',
      title: 'Later task',
      description: null,
      status: 'pending',
      mode: 'execution',
      priority: 0,
      workspaceId: 'ws-1',
      startAt: new Date(Date.now() + 60 * 60 * 1000),
      context: {},
      workspace: { id: 'ws-1', teamId: 'team-1' },
    });

    const response = await callHandler(createMockRequest({ body: { forceOverride: true } }), 'task-123');
    expect(response.status).toBe(200);
    expect(mockTriggerEvent).toHaveBeenCalled();
    expect(mockDbUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      startAt: null,
      context: expect.objectContaining({ bypassStartGate: true }),
    }));
  });

  it('returns 422 when a completed dependency has an unmerged PR', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'pending',
      workspaceId: 'ws-1',
      dependsOn: ['dep-task-1'],
      context: {},
      workspace: { id: 'ws-1', teamId: 'team-1', name: 'Test Workspace', repo: 'test/repo' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);
    // Simulate a worker with open PR on the completed dep task
    mockWorkersFindMany.mockResolvedValue([
      {
        id: 'worker-1',
        taskId: 'dep-task-1',
        prUrl: 'https://github.com/org/repo/pull/94',
        prNumber: 94,
        task: { id: 'dep-task-1', title: 'Spec task', status: 'completed' },
      },
    ]);

    const request = createMockRequest();
    const response = await callHandler(request, 'task-123');

    expect(response.status).toBe(422);
    const data = await response.json();
    expect(data.gateReason).toBe('unmerged_dep_pr');
    expect(data.canForce).toBe(true);
    expect(data.blockingDeps).toHaveLength(1);
    expect(data.blockingDeps[0].prUrl).toBe('https://github.com/org/repo/pull/94');
    expect(data.blockingDeps[0].prNumber).toBe(94);
    // Should NOT have broadcast Pusher
    expect(mockTriggerEvent).not.toHaveBeenCalled();
  });

  it('does not gate when dep worker is not completed (status check handles it)', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'pending',
      workspaceId: 'ws-1',
      dependsOn: ['dep-task-1'],
      context: {},
      workspace: { id: 'ws-1', teamId: 'team-1', name: 'Test Workspace', repo: 'test/repo' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);
    // Worker has open PR but dep task is not yet completed — not a PR gate issue
    mockWorkersFindMany.mockResolvedValue([
      {
        id: 'worker-1',
        taskId: 'dep-task-1',
        prUrl: 'https://github.com/org/repo/pull/90',
        prNumber: 90,
        task: { id: 'dep-task-1', title: 'Still running task', status: 'in_progress' },
      },
    ]);

    const request = createMockRequest();
    const response = await callHandler(request, 'task-123');

    // No PR gate — should proceed to broadcast (dep status check is at claim time)
    expect(response.status).toBe(200);
    expect(mockTriggerEvent).toHaveBeenCalled();
  });

  it('bypasses gate and broadcasts when forceOverride is true', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'pending',
      workspaceId: 'ws-1',
      dependsOn: ['dep-task-1'],
      context: {},
      workspace: { id: 'ws-1', teamId: 'team-1', name: 'Test Workspace', repo: 'test/repo' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);
    // Has a blocking dep PR, but user sends forceOverride
    mockWorkersFindMany.mockResolvedValue([
      {
        id: 'worker-1',
        taskId: 'dep-task-1',
        prUrl: 'https://github.com/org/repo/pull/94',
        prNumber: 94,
        task: { id: 'dep-task-1', title: 'Spec task', status: 'completed' },
      },
    ]);

    const request = createMockRequest({ body: { forceOverride: true } });
    const response = await callHandler(request, 'task-123');

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.started).toBe(true);
    // Should have broadcast Pusher
    expect(mockTriggerEvent).toHaveBeenCalled();
  });

  // ── New gate tests ─────────────────────────────────────────────────────────

  it('returns 422 connector_routing_mismatch when role requires connectors not available in workspace', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Email Task',
      status: 'pending',
      workspaceId: 'ws-1',
      roleSlug: 'email-agent',
      dependsOn: null,
      missionId: null,
      context: null,
      workspace: { id: 'ws-1', teamId: 'team-1', name: 'WS', repo: null, maxConcurrentTasks: 3 },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);
    // Role declares a connector ref
    mockWorkspaceSkillsFindMany.mockResolvedValue([
      { slug: 'email-agent', workspaceId: null, connectorRefs: ['connector-1'] },
    ]);
    // Connector is not visible in this team (not found)
    mockConnectorsFindMany.mockResolvedValue([]);

    const response = await callHandler(createMockRequest(), 'task-123');
    expect(response.status).toBe(422);
    const data = await response.json();
    expect(data.gateReason).toBe('connector_routing_mismatch');
    expect(data.missingConnectors).toEqual(['connector-1']);
    expect(mockTriggerEvent).not.toHaveBeenCalled();
  });

  it('returns 422 connector_routing_mismatch when connector exists but belongs to a different team and is not shared', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Email Task',
      status: 'pending',
      workspaceId: 'ws-1',
      roleSlug: 'email-agent',
      dependsOn: null,
      missionId: null,
      context: null,
      workspace: { id: 'ws-1', teamId: 'team-1', name: 'WS', repo: null, maxConcurrentTasks: 3 },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);
    mockWorkspaceSkillsFindMany.mockResolvedValue([
      { slug: 'email-agent', workspaceId: null, connectorRefs: ['connector-1'] },
    ]);
    // Connector exists but owned by a different team
    mockConnectorsFindMany.mockResolvedValue([
      { id: 'connector-1', teamId: 'other-team', name: 'Email' },
    ]);
    // Not shared to team-1
    mockConnectorSharesFindMany.mockResolvedValue([]);

    const response = await callHandler(createMockRequest(), 'task-123');
    expect(response.status).toBe(422);
    const data = await response.json();
    expect(data.gateReason).toBe('connector_routing_mismatch');
    expect(data.missingConnectors).toEqual(['Email']);
    expect(mockTriggerEvent).not.toHaveBeenCalled();
  });

  it('passes connector gate when connector is owned by same team', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Email Task',
      description: null,
      status: 'pending',
      workspaceId: 'ws-1',
      roleSlug: 'email-agent',
      dependsOn: null,
      missionId: null,
      context: null,
      mode: null,
      priority: null,
      workspace: { id: 'ws-1', teamId: 'team-1', name: 'WS', repo: null, maxConcurrentTasks: 3 },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);
    mockWorkspaceSkillsFindMany.mockResolvedValue([
      { slug: 'email-agent', workspaceId: null, connectorRefs: ['connector-1'] },
    ]);
    // Connector owned by same team
    mockConnectorsFindMany.mockResolvedValue([
      { id: 'connector-1', teamId: 'team-1', name: 'Email' },
    ]);

    const response = await callHandler(createMockRequest(), 'task-123');
    expect(response.status).toBe(200);
    expect(mockTriggerEvent).toHaveBeenCalledTimes(1);
  });

  it('returns 422 mission_held when task belongs to a held mission', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Held Task',
      status: 'pending',
      workspaceId: 'ws-1',
      missionId: 'mission-1',
      dependsOn: null,
      roleSlug: null,
      context: null,
      workspace: { id: 'ws-1', teamId: 'team-1', repo: null, maxConcurrentTasks: 3 },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);
    // Mission is held
    mockMissionsFindFirst.mockResolvedValue({ id: 'mission-1' });

    const response = await callHandler(createMockRequest(), 'task-123');
    expect(response.status).toBe(422);
    const data = await response.json();
    expect(data.gateReason).toBe('mission_held');
    expect(data.missionId).toBe('mission-1');
    expect(data.canForce).toBe(true);
    expect(mockTriggerEvent).not.toHaveBeenCalled();
  });

  it('force-starts a held-mission task with forceOverride=true and writes bypassHeldGate to context', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Held Task',
      description: null,
      status: 'pending',
      workspaceId: 'ws-1',
      missionId: 'mission-1',
      dependsOn: null,
      roleSlug: null,
      context: {},
      mode: null,
      priority: null,
      startAt: null,
      workspace: { id: 'ws-1', teamId: 'team-1', name: 'WS', repo: null, maxConcurrentTasks: 3 },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);
    // Mission is held but forceOverride bypasses it
    mockMissionsFindFirst.mockResolvedValue({ id: 'mission-1' });

    const response = await callHandler(createMockRequest({ body: { forceOverride: true } }), 'task-123');
    expect(response.status).toBe(200);
    expect(mockTriggerEvent).toHaveBeenCalledTimes(1);
    // bypassHeldGate must be written to context
    expect(mockDbUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ bypassHeldGate: true }),
    }));
  });

  it('skips mission_held gate when context.bypassHeldGate is already set', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Held Task',
      description: null,
      status: 'pending',
      workspaceId: 'ws-1',
      missionId: 'mission-1',
      dependsOn: null,
      roleSlug: null,
      context: { bypassHeldGate: true },
      mode: null,
      priority: null,
      startAt: null,
      workspace: { id: 'ws-1', teamId: 'team-1', name: 'WS', repo: null, maxConcurrentTasks: 3 },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const response = await callHandler(createMockRequest(), 'task-123');
    // Gate already bypassed — should pass straight through
    expect(response.status).toBe(200);
    // missions.findFirst should NOT be queried at all
    expect(mockMissionsFindFirst).not.toHaveBeenCalled();
    expect(mockTriggerEvent).toHaveBeenCalledTimes(1);
  });

  it('returns 422 workspace_cap_reached when workspace is at its concurrency limit', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'New Task',
      status: 'pending',
      workspaceId: 'ws-1',
      dependsOn: null,
      missionId: null,
      roleSlug: null,
      context: null,
      workspace: { id: 'ws-1', teamId: 'team-1', repo: 'org/repo', maxConcurrentTasks: 3 },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);
    // 3 active workers — at the cap
    mockWorkersFindMany.mockResolvedValue([{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }]);

    const response = await callHandler(createMockRequest(), 'task-123');
    expect(response.status).toBe(422);
    const data = await response.json();
    expect(data.gateReason).toBe('workspace_cap_reached');
    expect(data.active).toBe(3);
    expect(data.cap).toBe(3);
    expect(mockTriggerEvent).not.toHaveBeenCalled();
  });

  it('does not apply workspace_cap gate for repo-less workspaces', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Coordination Task',
      description: null,
      status: 'pending',
      workspaceId: 'ws-1',
      dependsOn: null,
      missionId: null,
      roleSlug: null,
      context: null,
      mode: null,
      priority: null,
      workspace: { id: 'ws-1', teamId: 'team-1', repo: null, maxConcurrentTasks: 3, name: 'WS' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);
    // Even with "full" worker list, no cap applies without a repo
    mockWorkersFindMany.mockResolvedValue([{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }]);

    const response = await callHandler(createMockRequest(), 'task-123');
    expect(response.status).toBe(200);
    expect(mockTriggerEvent).toHaveBeenCalledTimes(1);
  });

  it('clean pending task returns 200 with exactly one TASK_ASSIGNED event (regression guard)', async () => {
    const mockTask = {
      id: 'task-clean',
      title: 'Clean Task',
      description: null,
      status: 'pending',
      workspaceId: 'ws-1',
      dependsOn: null,
      missionId: null,
      roleSlug: null,
      context: null,
      mode: null,
      priority: null,
      workspace: { id: 'ws-1', teamId: 'team-1', name: 'Clean WS', repo: null, maxConcurrentTasks: 3 },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const response = await callHandler(createMockRequest(), 'task-clean');
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.started).toBe(true);
    // Exactly one Pusher event — guards against duplicate broadcasts
    expect(mockTriggerEvent).toHaveBeenCalledTimes(1);
    expect(mockTriggerEvent).toHaveBeenCalledWith(
      'workspace-ws-1',
      'task:assigned',
      expect.objectContaining({ task: expect.objectContaining({ id: 'task-clean' }) }),
    );
  });
});
