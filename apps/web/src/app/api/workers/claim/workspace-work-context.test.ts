import { describe, it, expect, mock, beforeEach } from 'bun:test';

/**
 * Coverage note — why this file exists.
 *
 * `route.test.ts` never mentions openPRs or siblingTaskManifests: this block
 * had no test before it was extracted. The workspace scoping is the part worth
 * guarding — an agent must never see another workspace's branches or manifests.
 */

const mockWorkersFindMany = mock(async (_args?: any) => [] as any[]);
const mockTasksFindMany = mock(async (_args?: any) => [] as any[]);

// Predicate stubs: `db` is mocked, so the query-level scoping (which workspaces,
// which statuses, and the exclusion of the claiming workers/tasks themselves) is
// unobservable through the returned rows. Plain objects make it assertable —
// the post-filters below are only the second line of defence.
mock.module('drizzle-orm', () => ({
  and: (...args: any[]) => ({ args, type: 'and' }),
  not: (value: any) => ({ value, type: 'not' }),
  isNull: (field: any) => ({ field, type: 'isNull' }),
  isNotNull: (field: any) => ({ field, type: 'isNotNull' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
}));
mock.module('@buildd/core/db/schema', () => ({
  workers: { id: 'id', workspaceId: 'workspaceId', prUrl: 'prUrl', status: 'status', createdAt: 'createdAt' },
  tasks: { id: 'id', workspaceId: 'workspaceId', status: 'status', pathManifest: 'pathManifest' },
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findMany: mockWorkersFindMany },
      tasks: { findMany: mockTasksFindMany },
    },
  },
}));

const { attachWorkspaceWorkContext } = await import('./workspace-work-context');

function worker(taskId: string) {
  return { id: `w-${taskId}`, taskId } as any;
}

function task(id: string, workspaceId: string) {
  return { id, workspaceId } as any;
}

/** A live worker in the same workspace that already opened a PR. */
function prWorker(id: string, workspaceId: string, taskId: string | null) {
  return {
    id,
    branch: `feat/${id}`,
    prUrl: `https://github.com/acme/repo/pull/1`,
    prNumber: 1,
    taskId,
    workspaceId,
  } as any;
}

/** Reads one predicate out of the stubbed WHERE tree by node type + field. */
function predicate(args: any, type: string, field: string) {
  return (args?.where?.args ?? []).find((n: any) => n?.type === type && n.field === field);
}

/** Reads a NOT-wrapped predicate (`not(inArray(...))`, `not(isNull(...))`). */
function negated(args: any, innerType: string, field: string) {
  return (args?.where?.args ?? [])
    .find((n: any) => n?.type === 'not' && n.value?.type === innerType && n.value?.field === field)?.value;
}

beforeEach(() => {
  mockWorkersFindMany.mockReset();
  mockWorkersFindMany.mockResolvedValue([]);
  mockTasksFindMany.mockReset();
  mockTasksFindMany.mockResolvedValue([]);
});

describe('attachWorkspaceWorkContext — openPRs', () => {
  it('attaches open PRs from other workers in the same workspace', async () => {
    mockWorkersFindMany.mockResolvedValue([prWorker('w-other', 'ws-1', 't-other')]);
    mockTasksFindMany.mockImplementation(async () =>
      mockTasksFindMany.mock.calls.length === 1
        ? [{ id: 't-other', title: 'Other work', pathManifest: ['src/a.ts'] }]
        : [],
    );
    const workers = [worker('t1')];

    await attachWorkspaceWorkContext(workers, [task('t1', 'ws-1')]);

    expect(workers[0].openPRs).toEqual([
      {
        branch: 'feat/w-other',
        prUrl: 'https://github.com/acme/repo/pull/1',
        prNumber: 1,
        taskTitle: 'Other work',
        pathManifest: ['src/a.ts'],
        workspaceId: 'ws-1',
      },
    ]);
  });

  // The isolation guarantee: an agent must never see another workspace's work.
  it('does not leak an open PR from a different workspace', async () => {
    mockWorkersFindMany.mockResolvedValue([prWorker('w-other', 'ws-2', 't-other')]);
    mockTasksFindMany.mockResolvedValue([
      { id: 't-other', title: 'Other work', pathManifest: null },
    ]);
    const workers = [worker('t1')];

    await attachWorkspaceWorkContext(workers, [task('t1', 'ws-1')]);

    expect(workers[0].openPRs).toBeUndefined();
  });

  it('routes each worker only its own workspace PRs on a multi-workspace claim', async () => {
    mockWorkersFindMany.mockResolvedValue([
      prWorker('w-a', 'ws-1', 't-a'),
      prWorker('w-b', 'ws-2', 't-b'),
    ]);
    mockTasksFindMany.mockImplementation(async () =>
      mockTasksFindMany.mock.calls.length === 1
        ? [
            { id: 't-a', title: 'A', pathManifest: null },
            { id: 't-b', title: 'B', pathManifest: null },
          ]
        : [],
    );
    const workers = [worker('t1'), worker('t2')];

    await attachWorkspaceWorkContext(workers, [task('t1', 'ws-1'), task('t2', 'ws-2')]);

    expect(workers[0].openPRs.map((p: any) => p.branch)).toEqual(['feat/w-a']);
    expect(workers[1].openPRs.map((p: any) => p.branch)).toEqual(['feat/w-b']);
  });

  it('nulls the title and manifest for a PR worker with no task', async () => {
    mockWorkersFindMany.mockResolvedValue([prWorker('w-other', 'ws-1', null)]);
    const workers = [worker('t1')];

    await attachWorkspaceWorkContext(workers, [task('t1', 'ws-1')]);

    expect(workers[0].openPRs[0].taskTitle).toBeNull();
    expect(workers[0].openPRs[0].pathManifest).toBeNull();
  });

  it('attaches nothing when no other worker has an open PR', async () => {
    const workers = [worker('t1')];

    await attachWorkspaceWorkContext(workers, [task('t1', 'ws-1')]);

    expect(workers[0].openPRs).toBeUndefined();
  });
});

describe('attachWorkspaceWorkContext — siblingTaskManifests', () => {
  it('attaches sibling manifests from the same workspace', async () => {
    mockTasksFindMany.mockResolvedValue([
      { id: 't-sib', title: 'Sibling', pathManifest: ['src/b.ts'], workspaceId: 'ws-1' },
    ]);
    const workers = [worker('t1')];

    await attachWorkspaceWorkContext(workers, [task('t1', 'ws-1')]);

    expect(workers[0].siblingTaskManifests).toEqual([
      { id: 't-sib', title: 'Sibling', pathManifest: ['src/b.ts'] },
    ]);
  });

  it('does not leak a sibling manifest from a different workspace', async () => {
    mockTasksFindMany.mockResolvedValue([
      { id: 't-sib', title: 'Sibling', pathManifest: ['src/b.ts'], workspaceId: 'ws-2' },
    ]);
    const workers = [worker('t1')];

    await attachWorkspaceWorkContext(workers, [task('t1', 'ws-1')]);

    expect(workers[0].siblingTaskManifests).toBeUndefined();
  });

  it('attaches nothing when no sibling declared a manifest', async () => {
    mockTasksFindMany.mockResolvedValue([]);
    const workers = [worker('t1')];

    await attachWorkspaceWorkContext(workers, [task('t1', 'ws-1')]);

    expect(workers[0].siblingTaskManifests).toBeUndefined();
  });
});

describe('attachWorkspaceWorkContext — query scoping', () => {
  // Every filter here is invisible through the returned rows. Dropping the
  // self-exclusion makes a worker read back its own PR as if it were a
  // sibling's; dropping the workspace filter pulls every workspace's live
  // workers out of the DB and leans entirely on the post-filter.
  it('asks only for other live workers with a PR in the claimed workspaces', async () => {
    await attachWorkspaceWorkContext(
      [worker('t1'), worker('t2')],
      [task('t1', 'ws-1'), task('t2', 'ws-2')],
    );

    const args = mockWorkersFindMany.mock.calls[0]?.[0] as any;
    expect(predicate(args, 'inArray', 'workspaceId').values).toEqual(['ws-1', 'ws-2']);
    expect(negated(args, 'isNull', 'prUrl')).toBeDefined();
    expect(predicate(args, 'inArray', 'status').values)
      .toEqual(['running', 'idle', 'starting', 'waiting_input', 'completed']);
    // The claiming workers must not appear in their own openPRs context.
    expect(negated(args, 'inArray', 'id').values).toEqual(['w-t1', 'w-t2']);
    // Bounded context: this list is injected into the agent prompt.
    expect(args.limit).toBe(10);
  });

  it('deduplicates the workspace list when several workers share a workspace', async () => {
    await attachWorkspaceWorkContext(
      [worker('t1'), worker('t2')],
      [task('t1', 'ws-1'), task('t2', 'ws-1')],
    );

    expect(predicate(mockWorkersFindMany.mock.calls[0]?.[0], 'inArray', 'workspaceId').values).toEqual(['ws-1']);
  });

  it('asks only for pending/active sibling tasks with a manifest, excluding the claimed ones', async () => {
    await attachWorkspaceWorkContext([worker('t1')], [task('t1', 'ws-1')]);

    // Only one tasks query runs here (no PR workers → no title lookup).
    const args = mockTasksFindMany.mock.calls[0]?.[0] as any;
    expect(predicate(args, 'inArray', 'workspaceId').values).toEqual(['ws-1']);
    expect(predicate(args, 'inArray', 'status').values).toEqual(['pending', 'assigned', 'in_progress']);
    expect(predicate(args, 'isNotNull', 'pathManifest')).toBeDefined();
    // A task must never be shown its own manifest as a sibling's.
    expect(negated(args, 'inArray', 'id').values).toEqual(['t1']);
  });

  it('looks up PR titles only for the tasks behind the returned PR workers', async () => {
    mockWorkersFindMany.mockResolvedValue([
      prWorker('w-a', 'ws-1', 't-a'),
      prWorker('w-b', 'ws-1', null),
    ]);

    await attachWorkspaceWorkContext([worker('t1')], [task('t1', 'ws-1')]);

    // This query's WHERE is a bare `inArray`, not an `and(...)` tree.
    const where = (mockTasksFindMany.mock.calls[0]?.[0] as any)?.where;
    expect(where).toEqual({ field: 'id', values: ['t-a'], type: 'inArray' });
  });
});

describe('attachWorkspaceWorkContext — guards', () => {
  it('queries nothing when no worker claimed', async () => {
    await attachWorkspaceWorkContext([], []);

    expect(mockWorkersFindMany).not.toHaveBeenCalled();
    expect(mockTasksFindMany).not.toHaveBeenCalled();
  });

  it('queries nothing when no claimed worker maps to a candidate task', async () => {
    await attachWorkspaceWorkContext([worker('t1')], [task('other', 'ws-1')]);

    expect(mockWorkersFindMany).not.toHaveBeenCalled();
    expect(mockTasksFindMany).not.toHaveBeenCalled();
  });
});
