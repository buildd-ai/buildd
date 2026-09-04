import { describe, it, expect, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

const mockWorkersFindMany = mock(() => [] as any[]);

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findMany: mockWorkersFindMany },
    },
  },
}));

import { checkWorkspaceCap, DEFAULT_MAX_CONCURRENT_TASKS } from './workspace-cap-gate';

const WORKSPACE_ID = 'ws-abc';

describe('checkWorkspaceCap', () => {
  it('returns null when no active workers', async () => {
    mockWorkersFindMany.mockResolvedValue([]);
    const result = await checkWorkspaceCap(WORKSPACE_ID, 3);
    expect(result).toBeNull();
  });

  it('returns null when active count is below cap', async () => {
    mockWorkersFindMany.mockResolvedValue([{ id: 'w1' }, { id: 'w2' }]);
    const result = await checkWorkspaceCap(WORKSPACE_ID, 3);
    expect(result).toBeNull();
  });

  it('returns { active, cap } when at cap', async () => {
    mockWorkersFindMany.mockResolvedValue([{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }]);
    const result = await checkWorkspaceCap(WORKSPACE_ID, 3);
    expect(result).toEqual({ active: 3, cap: 3 });
  });

  it('uses DEFAULT_MAX_CONCURRENT_TASKS when null passed', async () => {
    const workers = Array.from({ length: DEFAULT_MAX_CONCURRENT_TASKS }, (_, i) => ({ id: `w${i}` }));
    mockWorkersFindMany.mockResolvedValue(workers);
    const result = await checkWorkspaceCap(WORKSPACE_ID, null);
    expect(result).toEqual({ active: DEFAULT_MAX_CONCURRENT_TASKS, cap: DEFAULT_MAX_CONCURRENT_TASKS });
  });

  it('uses missionCap when it exceeds workspaceCap', async () => {
    // workspace cap = 3, mission cap = 5 → effective = 5
    // 4 active workers should be fine
    mockWorkersFindMany.mockResolvedValue([{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }, { id: 'w4' }]);
    const result = await checkWorkspaceCap(WORKSPACE_ID, 3, 5);
    expect(result).toBeNull();
  });

  it('returns blocked when active exceeds missionCap', async () => {
    // workspace cap = 3, mission cap = 5 → effective = 5
    // 5 active workers should block
    const workers = Array.from({ length: 5 }, (_, i) => ({ id: `w${i}` }));
    mockWorkersFindMany.mockResolvedValue(workers);
    const result = await checkWorkspaceCap(WORKSPACE_ID, 3, 5);
    expect(result).toEqual({ active: 5, cap: 5 });
  });

  it('ignores null missionCap (uses workspace cap)', async () => {
    mockWorkersFindMany.mockResolvedValue([{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }]);
    const result = await checkWorkspaceCap(WORKSPACE_ID, 3, null);
    expect(result).toEqual({ active: 3, cap: 3 });
  });
});

// ─── What gets counted ───────────────────────────────────────────────────────
//
// Every test above feeds the active-worker count straight in from the mock, so
// the query that produces that count was never observed. Two mutations to it
// were silent, and both are outages:
//
//   - dropping `eq(workers.workspaceId, workspaceId)` counts the active workers
//     of EVERY workspace on the instance against this one workspace's cap of
//     3 — the whole fleet wedges at workspace_cap and no task ever starts.
//   - dropping 'idle' from the status list under-counts held-open workers, so
//     the workspace admits more concurrent tasks than its cap allows.
//
// Neither shows up as an error; both look exactly like a quiet queue.

describe('checkWorkspaceCap — the active-worker query', () => {
  it('counts only this workspace, and only running/starting/idle workers', async () => {
    mockWorkersFindMany.mockResolvedValue([]);
    await checkWorkspaceCap(WORKSPACE_ID, 3);

    const args = mockWorkersFindMany.mock.calls.at(-1)![0] as { where: any };
    const { sql: text, params } = new PgDialect().sqlToQuery(args.where);

    expect(text).toContain('"workers"."workspace_id" = $1');
    expect(text).toContain('"workers"."status" in ($2, $3, $4)');
    expect(params).toEqual([WORKSPACE_ID, 'running', 'starting', 'idle']);
  });
});
