import { describe, it, expect, mock } from 'bun:test';

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
