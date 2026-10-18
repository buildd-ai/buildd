/**
 * AC-3 (docs/specs/workflow-kernel-library.md §1): a page render, MCP read or
 * explain of a delivery-owned task whose GitHub state changed records at most
 * a fact. It issues no UPDATE to tasks.status/result, workers.merged_at,
 * workers.pr_lifecycle_status, workers.pr_url or workers.pr_number, during the
 * request or in after(). A task with no delivery heals exactly as before.
 *
 * The db stub records every statement as SQL: raw `db.execute` through
 * PgDialect, builder updates as `UPDATE <table> SET <column> = ?`. The PR fact
 * funnel (recordPrFact) and the merge stamp run for real, so a lifecycle write
 * they would issue shows up in the log rather than in a mock's call list.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { getTableName, type Table } from 'drizzle-orm';

const dialect = new PgDialect();
const statements: string[] = [];
/** What the ownership SELECT returns: rows the one definition (kernel authority, switch on) owns. */
let ownedRows: Array<{ workerId: string }> = [];
let ownershipFails = false;
const params: unknown[][] = [];

const mockWorkersFindMany = mock(async (_opts?: unknown) => [] as any[]);
const mockWorkspacesFindFirst = mock(async (_opts?: unknown) => ({ repo: 'owner/repo', githubInstallation: { installationId: 123 } }) as any);

function columnName(table: Table, key: string): string {
  const col = (table as unknown as Record<string, { name?: string }>)[key];
  return col?.name ?? key;
}

const db = {
  query: {
    workers: { findMany: mockWorkersFindMany },
    workspaces: { findFirst: mockWorkspacesFindFirst },
    githubRepos: { findFirst: async () => null },
  },
  update: (table: Table) => ({
    set: (values: Record<string, unknown>) => {
      statements.push(`UPDATE ${getTableName(table)} SET ${Object.keys(values).map((k) => `${columnName(table, k)} = ?`).join(', ')}`);
      const chain = { where: () => chain, returning: async () => [], then: (r: (v: unknown) => unknown) => Promise.resolve([]).then(r) };
      return chain;
    },
  }),
  execute: async (q: Parameters<PgDialect['sqlToQuery']>[0]) => {
    const rendered = dialect.sqlToQuery(q);
    const text = rendered.sql;
    statements.push(text);
    params.push(rendered.params);
    if (text.includes('workflow:delivery_owned_workers')) {
      if (ownershipFails) throw new Error('read failed');
      return { rows: ownedRows };
    }
    return { rows: [] };
  },
};
mock.module('@buildd/core/db', () => ({ db }));

const realGithub = await import('@/lib/github');
const mockGithubApi = mock(async (..._a: unknown[]) => ({}) as any);
const mockFetchCi = mock(async (..._a: unknown[]) => null as string | null);
mock.module('@/lib/github', () => ({ ...realGithub, githubApi: mockGithubApi, fetchCiLifecycleStatus: mockFetchCi }));

const mockTriggerEvent = mock(async () => {});
mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  channels: { workspace: (id: string) => `workspace-${id}` },
  events: { WORKER_PROGRESS: 'worker:progress' },
}));

const mockCheckDependsOnResolved = mock(async (_id: string) => {});
mock.module('@/lib/task-dependencies', () => ({ checkDependsOnResolved: mockCheckDependsOnResolved }));

const mockEmit = mock(async (_e: unknown) => {});
mock.module('@/lib/core-emit', () => ({ emit: mockEmit }));

const mockRefreshWorkerMergeState = mock(async (..._a: unknown[]) => true);
mock.module('@/lib/pr-reconcile', () => ({ refreshWorkerMergeStateIfStale: mockRefreshWorkerMergeState }));

// The seam: its read-side helpers for real (they are the statements under test),
// observePrState (the webhook's apply-and-drain door) as a spy that must stay unused for owned rows.
const renderObservation = await import('./workflow/render-observation');
const mockObservePrState = mock(async (_p: unknown, _c?: unknown) => false);
mock.module('@/lib/workflow/seam', () => ({ ...renderObservation, observePrState: mockObservePrState }));
const realKernelClient = await import('./workflow/kernel-client');
mock.module('@/lib/workflow/kernel-client', () => ({ ...realKernelClient, observePrState: mockObservePrState }));

const { refreshStaleWorkersForWorkspaces, refreshStaleWorkers, observeMergeStateOnRender, _resetFailureBackoffForTests } = await import('./pr-state-refresh');

/** An UPDATE to tasks or workers that sets a delivery lifecycle column. */
const LIFECYCLE_COLUMNS = /\b(status|result|merged_at|pr_lifecycle_status|pr_url|pr_number)"?\s*=/i;
function lifecycleUpdates(): string[] {
  return statements.filter((s) => {
    const m = /\bUPDATE\s+"?(tasks|workers)"?\b[\s\S]*?\bSET\b([\s\S]*?)(\bWHERE\b|\bFROM\b|\bRETURNING\b|$)/i.exec(s);
    return !!m && LIFECYCLE_COLUMNS.test(m[2]);
  });
}
const factInserts = () => statements.filter((s) => s.includes('workflow:insert_fact'));

const MERGED = { state: 'closed', merged: true, merged_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', head: { sha: 'abc' }, base: { ref: 'dev' } };
const OPEN = { state: 'open', merged: false, merged_at: null, updated_at: '2026-01-01T00:00:00Z', head: { sha: 'abc' }, base: { ref: 'dev' } };
const worker = { id: 'w1', prNumber: 42, prUrl: 'https://github.com/owner/repo/pull/42', workspaceId: 'ws1', taskId: 't1', prLifecycleStatus: 'pr_open' };

beforeEach(() => {
  statements.length = 0;
  ownedRows = [];
  ownershipFails = false;
  params.length = 0;
  _resetFailureBackoffForTests();
  for (const m of [mockWorkersFindMany, mockGithubApi, mockFetchCi, mockTriggerEvent, mockCheckDependsOnResolved, mockEmit, mockObservePrState, mockRefreshWorkerMergeState]) m.mockClear();
  mockWorkersFindMany.mockResolvedValue([worker]);
});

describe('read-through refresh of a delivery-owned task (AC-3)', () => {
  it('a merged PR records a fact and issues no lifecycle UPDATE (task list / Home / PR list path)', async () => {
    ownedRows = [{ workerId: 'w1' }];
    mockGithubApi.mockResolvedValue(MERGED);

    await refreshStaleWorkersForWorkspaces(['ws1']);

    expect(lifecycleUpdates()).toEqual([]);
    // Nothing moved for this row: its clocks stay put, so pr-reconcile still sees it stale and heals it.
    expect(statements.filter((s) => /UPDATE\s+"?workers/i.test(s))).toEqual([]);
    expect(factInserts()).toHaveLength(1);
    expect(factInserts()[0]).toContain('INSERT INTO workflow_facts');
    // Recorded, never applied or drained during the request.
    expect(statements.some((s) => /UPDATE\s+workflow_|INSERT INTO workflow_transitions/i.test(s))).toBe(false);
    expect(mockObservePrState).not.toHaveBeenCalled();
    expect(mockCheckDependsOnResolved).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('a mission render (pre-fetched candidates) records a fact and issues no lifecycle UPDATE', async () => {
    ownedRows = [{ workerId: 'w1' }];
    mockGithubApi.mockResolvedValue(MERGED);

    await refreshStaleWorkers([{ ...worker, prLastCheckedAt: null }]);

    expect(lifecycleUpdates()).toEqual([]);
    expect(factInserts()).toHaveLength(1);
  });

  it('a CI verdict that moved is not written for a delivery-owned row', async () => {
    ownedRows = [{ workerId: 'w1' }];
    mockWorkersFindMany.mockResolvedValue([{ ...worker, prLifecycleStatus: 'ci_failed' }]);
    mockGithubApi.mockResolvedValue(OPEN);
    mockFetchCi.mockResolvedValue('ci_green');

    await refreshStaleWorkersForWorkspaces(['ws1']);

    expect(lifecycleUpdates()).toEqual([]);
    expect(statements.filter((s) => /UPDATE\s+"?workers/i.test(s))).toEqual([]);
    expect(factInserts()).toEqual([]);
  });

  it('an open PR that did not move only advances the bookkeeping clocks', async () => {
    ownedRows = [{ workerId: 'w1' }];
    mockGithubApi.mockResolvedValue(OPEN);

    await refreshStaleWorkersForWorkspaces(['ws1']);

    expect(lifecycleUpdates()).toEqual([]);
    expect(statements).toContainEqual(expect.stringMatching(/^UPDATE workers SET pr_last_checked_at = \?/));
    expect(factInserts()).toEqual([]);
  });

  it('a delivery released to legacy is not delivery-owned: the read heals it as before (S4a: one definition)', async () => {
    // The ownership SELECT is kernel-authority only (render-observation.test.ts pins the SQL), so a
    // released delivery's row comes back unowned and takes the legacy path.
    ownedRows = [];
    mockGithubApi.mockResolvedValue(MERGED);

    await refreshStaleWorkersForWorkspaces(['ws1']);

    expect(lifecycleUpdates().length).toBeGreaterThan(0);
    expect(factInserts()).toEqual([]);
  });

  it('fails closed when ownership cannot be read: no lifecycle UPDATE, no fact', async () => {
    ownershipFails = true;
    mockGithubApi.mockResolvedValue(MERGED);

    await refreshStaleWorkersForWorkspaces(['ws1']);

    expect(lifecycleUpdates()).toEqual([]);
    expect(factInserts()).toEqual([]);
  });

  it('the task and mission page import records a fact and never calls the merge stamp', async () => {
    ownedRows = [{ workerId: 'w1' }];
    mockGithubApi.mockResolvedValue(MERGED);

    await observeMergeStateOnRender([{ id: 'w1', prNumber: 42, prUrl: worker.prUrl, workspaceId: 'ws-of-w1' }], 123);

    expect(mockRefreshWorkerMergeState).not.toHaveBeenCalled();
    expect(lifecycleUpdates()).toEqual([]);
    expect(factInserts()).toHaveLength(1);
    // The fact is the worker's own workspace's, not the page's (a mission can span workspaces).
    const insertParams = params[statements.findIndex((s) => s.includes('workflow:insert_fact'))];
    expect(insertParams[0]).toBe('ws-of-w1');
  });
});

describe('read-through refresh of a task with no delivery (unchanged)', () => {
  it('a merged PR still heals the row: merged_at and the lifecycle status are written', async () => {
    mockGithubApi.mockResolvedValue(MERGED);

    await refreshStaleWorkersForWorkspaces(['ws1']);

    const writes = lifecycleUpdates();
    expect(writes.length).toBeGreaterThan(0);
    // The merge stamp over every row carrying the PR still runs when none is delivery-owned.
    expect(writes.some((s) => /w\.pr_url = \$\d+::text AND w\.pr_number/.test(s))).toBe(true);
    expect(writes.some((s) => /merged_at\s*=/.test(s) && /pr_lifecycle_status\s*=\s*'merged'/.test(s))).toBe(true);
    expect(mockCheckDependsOnResolved).toHaveBeenCalledWith('t1', { observeOnly: true });
    expect(mockEmit).toHaveBeenCalled();
    expect(factInserts()).toEqual([]);
  });

  it('the stamp over every row of the PR carries the funnel scope, so a delivery-owned sibling is never written (S4a)', async () => {
    mockGithubApi.mockResolvedValue(MERGED);

    await refreshStaleWorkersForWorkspaces(['ws1']);

    const byUrl = lifecycleUpdates().filter((s) => /w\.pr_url = /.test(s));
    expect(byUrl.length).toBeGreaterThan(0);
    // The scope (pr-fact-scope.ts factFunnelScope) sits in the statement's own WHERE.
    for (const s of byUrl) expect(s).toContain('NOT EXISTS (SELECT 1 FROM workflow_deliveries kd JOIN workspaces kw');
  });

  it('the task and mission page import still runs the merge-state refresh', async () => {
    const w = { id: 'w1', prNumber: 42, prUrl: worker.prUrl, workspaceId: 'ws1' };
    await observeMergeStateOnRender([w], 123);

    // From a render: a kernel-owned dependency or sibling merge is recorded, never applied (AC-3).
    expect(mockRefreshWorkerMergeState).toHaveBeenCalledWith({ id: 'w1', prNumber: 42, prUrl: worker.prUrl }, 123, { workspaceId: 'ws1', observeOnly: true });
    expect(mockGithubApi).not.toHaveBeenCalled();
  });
});
