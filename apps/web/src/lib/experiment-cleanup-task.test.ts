import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ── Module mocks (must be before import) ────────────────────────────────────
const insertedValues: any[] = [];
const mockAnnounceTaskCreated = mock(() => Promise.resolve());

mock.module('@buildd/core/db', () => ({
  db: {
    insert: () => ({
      values: (v: any) => {
        insertedValues.push(v);
        return { returning: () => Promise.resolve([{ id: 'cleanup-task-1' }]) };
      },
    }),
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 'ws-1', name: 'ws' }]) }) }),
    }),
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
  routeForCause: () => ({ event: 'task.created', legacyDefault: true, githubActions: true, legacyUnfilteredRunnerPreference: false }),
  webhookWants: () => false,
  primaryCause: (_causes: string[], fallback: string) => fallback,
  DISPATCH_DUE_QUEUE: 'dispatch',
  DRAIN_BATCH: 25,
  reseedDispatchTimer: async () => {},
}));

// Roles effective for the workspace (role-routing §1 row 9, §3.1).
let effectiveRoles = new Set<string>();
const pickRoleCalls: Array<{ workspaceId: string; candidates: Array<string | null | undefined> }> = [];
mock.module('@/lib/effective-roles', () => ({
  pickEffectiveRole: async (workspaceId: string, candidates: Array<string | null | undefined>) => {
    pickRoleCalls.push({ workspaceId, candidates });
    return candidates.find(c => c && effectiveRoles.has(c)) ?? null;
  },
  resolveEffectiveRoleSlugs: async () => effectiveRoles,
}));

import { fileExperimentCleanupTask } from './experiment-cleanup-task';

const SPEC = {
  slug: 'exp-v1',
  label: 'Example experiment',
  verdict: 'no_difference',
  artifactUrl: null,
  baseBranch: 'dev',
  scaffolding: [],
  keep: [],
  optional: [],
  stageTwo: 'Nothing further.',
  pathManifest: ['apps/web/src/lib/example-experiment.ts'],
} as any;

beforeEach(() => {
  insertedValues.length = 0;
  pickRoleCalls.length = 0;
  effectiveRoles = new Set();
  mockAnnounceTaskCreated.mockClear();
  mockWakeTask.mockClear();
});

describe('fileExperimentCleanupTask — role (role-routing §1 row 9)', () => {
  it('files the cleanup PR as Builder work when the workspace has the role', async () => {
    effectiveRoles = new Set(['builder', 'writer']);
    const res = await fileExperimentCleanupTask({ workspaceId: 'ws-1', spec: SPEC });
    expect(res).toEqual({ id: 'cleanup-task-1' });
    expect(pickRoleCalls).toEqual([{ workspaceId: 'ws-1', candidates: ['builder'] }]);
    expect(insertedValues[0].roleSlug).toBe('builder');
    expect(insertedValues[0].outputRequirement).toBe('pr_required');
  });

  it('files it role-less when the workspace has no Builder', async () => {
    effectiveRoles = new Set(['writer']);
    await fileExperimentCleanupTask({ workspaceId: 'ws-1', spec: SPEC });
    expect(insertedValues[0].roleSlug).toBeNull();
    expect(mockAnnounceTaskCreated).toHaveBeenCalledTimes(1);
    expect(mockWakeTask).toHaveBeenCalledWith((mockAnnounceTaskCreated.mock.calls[0] as any[])[0].id, 'task.created');
  });
});
