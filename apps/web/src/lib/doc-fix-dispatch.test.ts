import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ── Module mocks (must be before import) ────────────────────────────────────
const insertedValues: any[] = [];
const mockAnnounceTaskCreated = mock(() => Promise.resolve());

mock.module('@buildd/core/db', () => ({
  db: {
    // The group query: one open, unclaimed code_ahead row on the spec path.
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([{
          id: 'disc-1',
          assertionId: 'a-1',
          evidence: { detail: 'The doc says X; the code does Y.' },
          docFixTaskId: null,
          autoFollowUpTaskId: null,
          firstSeenAt: new Date('2026-01-01T00:00:00Z'),
          lastCheckedAt: new Date('2026-01-02T00:00:00Z'),
        }]),
      }),
    }),
    query: {
      tasks: { findMany: async () => [] },
      workers: { findMany: async () => [] },
      workspaces: { findFirst: async () => ({ id: 'ws-1', name: 'ws' }) },
      specDiscrepancies: { findFirst: async () => null },
    },
    insert: () => ({
      values: (v: any) => {
        insertedValues.push(v);
        return { returning: () => Promise.resolve([{ id: 'doc-fix-task-1', ...v }]) };
      },
    }),
    update: () => ({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 'disc-1' }]) }) }),
    }),
    delete: () => ({ where: () => Promise.resolve() }),
  },
}));

// The dispatch authority's full surface: mock.module is process-global.
const mockWakeTask = mock(async (_taskId: string, _cause: string, _opts?: unknown) => {});
mock.module('@/lib/dispatch-authority', () => ({
  announceTaskCreated: mockAnnounceTaskCreated,
  wakeTask: mockWakeTask,
  wakeTasks: mock(async () => {}),
  kickDispatch: () => {},
  enqueueTaskDispatch: async () => {},
  drainDispatchOutbox: async () => ({ claimed: 0, delivered: 0, skipped: 0, failed: 0 }),
  deliverTaskDispatch: async () => 'pusher',
  routeForCause: () => ({ event: 'task.created', legacyDefault: true, legacyUnfilteredRunnerPreference: false }),
  webhookWants: () => false,
  primaryCause: (_causes: string[], fallback: string) => fallback,
  DISPATCH_DUE_QUEUE: 'dispatch',
  DRAIN_BATCH: 25,
  reseedDispatchTimer: async () => {},
}));
mock.module('@/lib/action-queue', () => ({
  isDocFixInFlight: () => false,
  isDocFixClaimStale: () => false,
}));

// Roles effective for the row's workspace (role-routing §1 row 9, §3.1).
let effectiveRoles = new Set<string>();
const pickRoleCalls: Array<{ workspaceId: string; candidates: Array<string | null | undefined> }> = [];
mock.module('@/lib/effective-roles', () => ({
  pickEffectiveRole: async (workspaceId: string, candidates: Array<string | null | undefined>) => {
    pickRoleCalls.push({ workspaceId, candidates });
    return candidates.find(c => c && effectiveRoles.has(c)) ?? null;
  },
  resolveEffectiveRoleSlugs: async () => effectiveRoles,
}));

import { dispatchDocFix } from './doc-fix-dispatch';

const ROW = {
  id: 'disc-1',
  workspaceId: 'ws-1',
  specPath: 'docs/specs/example.md',
  direction: 'code_ahead',
  status: 'open',
};
const OPTS = { mode: 'initial' as const, dispatchedBy: 'user-1', creationSource: 'dashboard' as const };

beforeEach(() => {
  insertedValues.length = 0;
  pickRoleCalls.length = 0;
  effectiveRoles = new Set();
  mockAnnounceTaskCreated.mockClear();
  mockWakeTask.mockClear();
});

describe('dispatchDocFix — role (role-routing §1 row 9)', () => {
  it('runs the doc fix as the Writer when the workspace has one', async () => {
    effectiveRoles = new Set(['writer', 'builder']);
    const res = await dispatchDocFix(ROW, OPTS);
    expect(res).toMatchObject({ ok: true, dispatched: true, taskId: 'doc-fix-task-1' });
    expect(pickRoleCalls).toEqual([{ workspaceId: 'ws-1', candidates: ['writer', 'builder'] }]);
    expect(insertedValues[0].roleSlug).toBe('writer');
    expect(insertedValues[0].category).toBe('docs');
  });

  it('falls back to the Builder when the workspace has no Writer', async () => {
    effectiveRoles = new Set(['builder']);
    await dispatchDocFix(ROW, OPTS);
    expect(insertedValues[0].roleSlug).toBe('builder');
  });

  it('files it role-less when neither resolves', async () => {
    effectiveRoles = new Set(['researcher']);
    await dispatchDocFix(ROW, OPTS);
    expect(insertedValues[0].roleSlug).toBeNull();
    expect(mockAnnounceTaskCreated).toHaveBeenCalledTimes(1);
    expect(mockWakeTask).toHaveBeenCalledWith((mockAnnounceTaskCreated.mock.calls[0] as any[])[0].id, 'task.created');
  });
});
