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
