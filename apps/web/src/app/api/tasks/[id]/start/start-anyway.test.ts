import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Mock functions
const mockGetCurrentUser = mock(() => null as any);
const mockTasksFindFirst = mock(() => null as any);
const mockTasksFindMany = mock(() => [] as any[]);
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
const mockAuthenticateApiKey = mock(async (..._args: unknown[]) => null as any);
// Mock auth-helpers
mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

// Mock api-auth
mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: (...args: unknown[]) => mockAuthenticateApiKey(...args),
  hashApiKey: (key: string) => `hashed_${key}`,
  extractApiKeyPrefix: (key: string) => key.substring(0, 12),
}));

// Mock team-access
mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
  verifyAccountWorkspaceAccess: mockVerifyAccountWorkspaceAccess,
}));

const mockWakeTask = mock(async (_id: string, _cause: string, _opts?: unknown) => {});
mock.module('@/lib/dispatch-authority', () => ({
  wakeTask: mockWakeTask,
  wakeTasks: async () => {},
  announceTaskCreated: async () => {},
  kickDispatch: () => {},
  enqueueTaskDispatch: async () => {},
  drainDispatchOutbox: async () => ({}),
  deliverTaskDispatch: async () => 'skipped:test',
  routeForCause: () => ({}),
  webhookWants: () => false,
  primaryCause: (_c: readonly string[], fallback: string) => fallback,
  reseedDispatchTimer: async () => {},
  DISPATCH_DUE_QUEUE: 'dispatch',
  DRAIN_BATCH: 25,
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
      tasks: { findFirst: mockTasksFindFirst, findMany: mockTasksFindMany },
      workers: { findMany: mockWorkersFindMany },
      missions: { findFirst: mockMissionsFindFirst },
      workspaceSkills: { findMany: mockWorkspaceSkillsFindMany },
      connectors: { findMany: mockConnectorsFindMany },
      connectorShares: { findMany: mockConnectorSharesFindMany },
      connectorWorkspaces: { findMany: mockConnectorWorkspacesFindMany },
      // No team blocks a catalog entry here (blocked_by_policy: connector-gate.test.ts).
      connectorCatalogTeamPolicies: { findMany: async () => [] },
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
  ne: (field: any, value: any) => ({ field, value, type: 'ne' }),
}));

// Mock schema
mock.module('@buildd/core/db/schema', () => ({
  tasks: { id: 'id', workspaceId: 'workspaceId', status: 'status', context: 'context', dependsOn: 'dependsOn', updatedAt: 'updatedAt', missionId: 'missionId', roleSlug: 'roleSlug', startAt: 'startAt' },
  workers: { taskId: 'taskId', prUrl: 'prUrl', mergedAt: 'mergedAt', workspaceId: 'workspaceId', status: 'status' },
  missions: { id: 'id', isHeld: 'isHeld', executor: 'executor' },
  workspaceSkills: { slug: 'slug', isRole: 'isRole', enabled: 'enabled', teamId: 'teamId', workspaceId: 'workspaceId', connectorRefs: 'connectorRefs' },
  connectors: { id: 'id', teamId: 'teamId', name: 'name' },
  connectorShares: { connectorId: 'connectorId', sharedWithTeamId: 'sharedWithTeamId' },
  connectorWorkspaces: { connectorId: 'connectorId', workspaceId: 'workspaceId', enabled: 'enabled' },
  connectorCatalogTeamPolicies: { teamId: 'teamId', policy: 'policy' },
  accountWorkspaces: {},
  workspaces: {},
}));

const mockCheckEntitlement = mock(async (_teamId: string) => null as any);
mock.module('@/lib/entitlements/managed-runner', () => ({
  checkManagedRunnerEntitlement: mockCheckEntitlement,
}));
const mockCheckHosted = mock(async (_teamId: string) => null as any);
mock.module('@/lib/hosted-runner-usage-store', () => ({
  checkHostedRunnerAllowance: mockCheckHosted,
}));

// The coordination probe is stubbed per test with the claim route's REAL
// predicates (evaluateCoordinationGates) over a fixture snapshot, so these
// tests exercise the same gate logic the next claim applies.
const mockProbe = mock(async (_task: any, _now?: Date) => [] as any[] | null);
mock.module('@/lib/coordination-probe', () => ({ probeCoordination: mockProbe }));

const mockFireGateEvent = mock((_input: any) => 'sig');
mock.module('@/lib/gate-ledger', () => ({
  fireGateEvent: mockFireGateEvent,
  GATE_SLUGS: { CLAIM_LOOP_DEFERRAL: 'claim_loop_deferral' },
}));
const mockRecordDecision = mock(async (_row: any) => {});
mock.module('@buildd/core/orchestration-ledger-source', () => ({ recordOrchestrationDecision: mockRecordDecision }));

// Import handler AFTER mocks
import { POST } from './route';
import { evaluateCoordinationGates, type CoordinationSnapshot } from '../../../workers/claim/coordination-gates';
import { makeWaitingReason, type WaitingReason } from '@buildd/core/waiting-reason';

/** The shapes the probe produces for a local mission and for dependency edges (lib/coordination-probe.ts). */
const localReason = (): WaitingReason => makeWaitingReason('mission_local', {
  because: "its mission runs in a person's own session, so runners do not pick up its tasks",
  blocker: { type: 'mission', id: 'mission-1', label: 'a mission run from your session' },
  provenance: { source: 'probe', derivedFrom: "missions.executor='local'" },
});
const migrationEdge = (id: string): WaitingReason => makeWaitingReason('dep_inferred', {
  because: 'both change migrations in core/db',
  blocker: { type: 'task', id, label: `task ${id}`, live: true },
  overlap: { areas: [{ area: 'core/db', count: 1 }], pathCount: 1, paths: ['packages/core/db/schema.ts'], basis: 'declared', overlapKind: 'migration' },
  provenance: { source: 'task_context', derivedFrom: 'tasks.pathDeclaration.inferredDependsOn' },
});
const declaredEdge = (id: string): WaitingReason => makeWaitingReason('dep_declared', {
  because: 'it was declared as a dependency',
  blocker: { type: 'task', id, label: `task ${id}` },
  provenance: { source: 'task_context', derivedFrom: 'tasks.dependsOn' },
});

// Helper to create mock NextRequest
function createMockRequest(options: {
  body?: any;
  bearer?: string;
} = {}): NextRequest {
  const { body, bearer } = options;

  const url = 'http://localhost:3000/api/tasks/task-123/start';
  const init: RequestInit = {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }),
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

// Start anyway: assess, coordinate and continue (spec 36df686b, revision 1).
// Route-level acceptance tests for the person's request half: R-1, R-2, R-3,
// AC-3, AC-6, AC-8, AC-14 (repeat clicks), AC-15 (no Jev; real failure named),
// AC-18 (no protected mutation authorized). Written before the build; every
// test here fails on the mission's starting commit.
describe('POST /api/tasks/[id]/start: Start anyway past a declared dependency', () => {
  const dependent = {
    id: 'task-123',
    title: 'Dependent task',
    status: 'pending',
    workspaceId: 'ws-1',
    missionId: null,
    pathManifest: ['apps/web/src/lib/foo.ts'],
    dependsOn: ['up-1'],
    context: {},
    workspace: { id: 'ws-1', teamId: 'team-1', repo: 'test/repo', maxConcurrentTasks: 10 },
  };

  beforeEach(() => {
    mockWakeTask.mockClear();
    mockDbUpdate.set.mockClear();
    mockFireGateEvent.mockClear();
    mockRecordDecision.mockClear();
    mockProbe.mockReset();
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockWorkersFindMany.mockResolvedValue([]);
    mockTasksFindMany.mockResolvedValue([]);
    mockMissionsFindFirst.mockResolvedValue(null);
    mockWorkspaceSkillsFindMany.mockResolvedValue([]);
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(dependent);
    mockProbe.mockResolvedValue([declaredEdge('up-1')]);
  });

  const writtenContext = () => (mockDbUpdate.set.mock.calls.at(-1) as any)[0].context;
  const refuse = async () => (await callHandler(createMockRequest(), 'task-123')).json();
  const startAnyway = async (first: any) => callHandler(createMockRequest({
    body: { force: { kinds: first.force?.kinds ?? [], reasonsDigest: first.reasonsDigest } },
  }), 'task-123');

  it('R-1: the refusal for a declared dependency offers Start anyway, naming the prerequisite, not a dead end', async () => {
    const res = await callHandler(createMockRequest(), 'task-123');
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.canForce).toBe(true);
    expect(body.force).not.toBeNull();
    expect(body.force.kinds).toContain('dep_declared');
    expect(body.notForceable ?? []).toEqual([]);
    expect(JSON.stringify(body.force)).toContain('up-1');
    expect(body.error).not.toMatch(/can't be forced/i);
    // The control explains that the agent assesses what can proceed.
    expect(JSON.stringify(body.force).toLowerCase()).toContain('assess');
  });

  it('R-2: Start anyway durably records one request naming person, observed edges and digest, and wakes a runner; it never claims', async () => {
    const first = await refuse();
    const res = await startAnyway(first);
    expect(res.status).toBe(200);
    const ctx = writtenContext();
    expect(ctx.forceStart).toMatchObject({
      userId: 'user-123',
      kinds: ['dep_declared'],
      assessDependsOn: ['up-1'],
      reasonsDigest: first.reasonsDigest,
    });
    expect(typeof ctx.forceStart.at).toBe('string');
    expect(Date.parse(ctx.forceStart.expiresAt)).toBeGreaterThan(Date.now());
    expect(ctx.forceClaim).toBeUndefined();
    expect(mockWakeTask).toHaveBeenCalledTimes(1);
    expect(mockFireGateEvent.mock.calls.filter(c => c[0].reason === 'force_start')).toHaveLength(1);
  });

  it('AC-8: accepting the request leaves the dependency edge and the upstream task untouched', async () => {
    const res = await startAnyway(await refuse());
    expect(res.status).toBe(200);
    const updates = mockDbUpdate.set.mock.calls.map(c => c[0] as any);
    // Only the dependent task row is written, and never its dependsOn.
    expect(updates).toHaveLength(1);
    expect(updates[0]).not.toHaveProperty('dependsOn');
    expect(updates[0]).not.toHaveProperty('status');
    expect(writtenContext().forceStart.assessDependsOn).toEqual(['up-1']);
  });

  it('R-3: a plain forceOverride no longer leaves a permanent global dependency bypass', async () => {
    mockProbe.mockResolvedValue([]);
    const res = await callHandler(createMockRequest({ body: { forceOverride: true } }), 'task-123');
    expect(res.status).toBe(200);
    // Converges on the bounded, single-use, expiring intent.
    expect(writtenContext().bypassDepsGate).toBeUndefined();
    expect(writtenContext().forceStart).toMatchObject({ kinds: ['dep_declared'], assessDependsOn: ['up-1'] });
    expect(Date.parse(writtenContext().forceStart.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('AC-14: repeated Start anyway clicks retain the one accepted request and do not mint a second', async () => {
    const first = await refuse();
    await startAnyway(first);
    const accepted = writtenContext().forceStart;

    mockDbUpdate.set.mockClear();
    mockFireGateEvent.mockClear();
    mockTasksFindFirst.mockResolvedValue({ ...dependent, context: { manualStartAt: new Date().toISOString(), forceStart: accepted } });
    const again = await startAnyway(first);
    expect(again.status).toBe(200);
    const ctx = mockDbUpdate.set.mock.calls.length > 0 ? writtenContext() : { forceStart: accepted };
    expect(ctx.forceStart.id).toBe(accepted.id);
    expect(mockFireGateEvent.mock.calls.filter(c => c[0].reason === 'force_start')).toHaveLength(0);
  });

  it('AC-3: a newly added blocking edge after confirmation returns reasons_changed with the current named reasons', async () => {
    const first = await refuse();
    expect(first.force?.kinds).toContain('dep_declared');
    mockProbe.mockResolvedValue([declaredEdge('up-1'), declaredEdge('up-2')]);
    const res = await startAnyway(first);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.gateReason).toBe('reasons_changed');
    expect(body.waitingReasons.map((r: any) => r.blocker.id).sort()).toEqual(['up-1', 'up-2']);
    expect(body.canForce).toBe(true);
    expect(mockWakeTask).not.toHaveBeenCalled();
  });

  it('AC-6: when the blocker clears before the person acts, an ordinary start proceeds with no force record', async () => {
    const first = await refuse();
    expect(first.canForce).toBe(true);
    mockProbe.mockResolvedValue([]);
    const res = await callHandler(createMockRequest(), 'task-123');
    expect(res.status).toBe(200);
    expect(writtenContext().forceStart).toBeUndefined();
    expect(writtenContext().bypassDepsGate).toBeUndefined();
    expect(mockFireGateEvent.mock.calls.filter(c => c[0].reason === 'force_start')).toHaveLength(0);
    // A stale confirmation also proceeds without needing another override.
    const stale = await startAnyway(first);
    expect(stale.status).toBe(200);
    expect(writtenContext().forceStart).toBeUndefined();
  });

  it('AC-15: authorization consults no Jev, confidence or provider, and a real permission failure is named, not "running"', async () => {
    const first = await refuse();
    expect(first.force?.kinds).toContain('dep_declared');
    // No explanation from the person is required.
    expect((await startAnyway(first)).status).toBe(200);

    // A caller without access to the workspace gets a refusal, never a started intent.
    mockDbUpdate.set.mockClear();
    mockWakeTask.mockClear();
    mockVerifyWorkspaceAccess.mockResolvedValue(null);
    const denied = await startAnyway(first);
    expect(denied.status).toBe(404);
    expect(mockDbUpdate.set).not.toHaveBeenCalled();
    expect(mockWakeTask).not.toHaveBeenCalled();

    // A real, non-overridable condition is named and no intent is promised.
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockTasksFindFirst.mockResolvedValue({ ...dependent, context: { entitlementBlock: { kind: 'concurrency' } } });
    mockCheckEntitlement.mockResolvedValue({ kind: 'concurrency', active: 2, limit: 2 });
    const blocked = await startAnyway(first);
    expect(blocked.status).toBe(422);
    expect((await blocked.json()).gateReason).toBe('entitlement_blocked');
    mockCheckEntitlement.mockResolvedValue(null);
  });

  it('AC-18: Start anyway admits assessment only; it writes no release, merge, held-gate or budget bypass', async () => {
    const res = await startAnyway(await refuse());
    expect(res.status).toBe(200);
    const ctx = writtenContext();
    for (const key of ['bypassDepsGate', 'bypassHeldGate', 'bypassMissionBudget', 'bypassSubjectGate', 'capExempt', 'forceClaim']) {
      expect(ctx[key]).toBeUndefined();
    }
    expect(ctx.forceStart.kinds).toEqual(['dep_declared']);
  });
});
