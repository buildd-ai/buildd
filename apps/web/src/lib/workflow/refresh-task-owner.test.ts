/**
 * One writer per mission integration branch: while a refresh conflict task is
 * live, the kernel's update-branch / refresh answer `retry` and CI-fix /
 * conflict-fix prompts tell the attempt not to merge trunk.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

let mission: Record<string, unknown> | null = null;
let taskRow: Record<string, unknown> | null = null;
let retryRow: Record<string, unknown> | null = null;
let updates = 0;
let refreshes = 0;

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missions: { findFirst: async () => mission },
      workers: { findFirst: async () => ({ id: 'wk1' }) },
      // First lookup is the pointed-at task, the second its live retry.
      tasks: { findFirst: async (q: { columns?: Record<string, boolean> }) => (q.columns?.status ? taskRow : retryRow) },
    },
  },
}));
mock.module('./github-facts', () => ({ workspaceRepo: async () => ({ installationId: 1, repoFullName: 'acme/w', gitConfig: null }) }));
mock.module('@/lib/pr-branch-update', () => ({ updateBehindPrBranch: async () => { updates++; return { updated: true }; } }));

const { liveRefreshConflictTaskFor, refreshOwnerNote } = await import('./refresh-task-owner');
const { conflictsHost, __setConflictEffectDeps } = await import('./conflict-retry-effects');

const d = { workspaceId: 'w1', repoFullName: 'acme/w', prNumber: 7, ownerTaskId: 'o1' } as never;
const attempt = { boundHeadSha: 'H1' } as never;

beforeEach(() => {
  mission = { branchRefreshConflictTaskId: 'abcdef12-0000' };
  taskRow = { status: 'running' };
  retryRow = null;
  updates = 0; refreshes = 0;
  __setConflictEffectDeps({
    api: async () => ({ head: { ref: 'mission/m-1' } }),
    refresh: (async () => { refreshes++; return { kind: 'updated' }; }) as never,
  });
});

describe('liveRefreshConflictTaskFor', () => {
  test('a running conflict task is live; a reservation (no row) is live', async () => {
    expect(await liveRefreshConflictTaskFor('w1', 'mission/m-1')).toBe('abcdef12-0000');
    taskRow = null;
    expect(await liveRefreshConflictTaskFor('w1', 'mission/m-1')).toBe('abcdef12-0000');
  });
  test('a terminal task is live only while a retry runs', async () => {
    taskRow = { status: 'completed' };
    expect(await liveRefreshConflictTaskFor('w1', 'mission/m-1')).toBeNull();
    retryRow = { id: 'r1' };
    expect(await liveRefreshConflictTaskFor('w1', 'mission/m-1')).toBe('abcdef12-0000');
  });
  test('no mission, no pointer or no head ref: null', async () => {
    mission = null;
    expect(await liveRefreshConflictTaskFor('w1', 'feat/x')).toBeNull();
    mission = { branchRefreshConflictTaskId: null };
    expect(await liveRefreshConflictTaskFor('w1', 'mission/m-1')).toBeNull();
    expect(await liveRefreshConflictTaskFor('w1', null)).toBeNull();
  });
});

describe('conflictsHost fence', () => {
  test('update-branch and refresh defer to the live refresh task and merge nothing', async () => {
    expect(await conflictsHost.updateBranch(d, 'H1')).toMatchObject({ kind: 'retry' });
    expect(await conflictsHost.refresh(d, attempt)).toMatchObject({ kind: 'retry' });
    expect(updates).toBe(0);
    expect(refreshes).toBe(0);
  });
  test('once the task is settled the writers are free again', async () => {
    taskRow = { status: 'completed' };
    expect(await conflictsHost.updateBranch(d, 'H1')).toEqual({ kind: 'updated' });
    expect(await conflictsHost.refresh(d, attempt)).toEqual({ kind: 'updated' });
    expect(updates).toBe(1);
    expect(refreshes).toBe(1);
  });
});

test('the prompt note names the owner and forbids merging trunk', () => {
  const n = refreshOwnerNote('abcdef12-0000');
  expect(n).toContain('abcdef12');
  expect(n).toContain('Do not merge or rebase trunk');
});
