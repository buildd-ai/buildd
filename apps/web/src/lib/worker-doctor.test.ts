import { describe, it, expect, beforeEach, mock } from 'bun:test';

// --- Mocks ---
const mockWorkersFindFirst = mock(() => null as any);

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findFirst: mockWorkersFindFirst },
    },
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  workers: 'workers',
  tasks: 'tasks',
}));

import { diagnoseWorker } from './worker-doctor';

const baseWorker = {
  id: 'w1',
  taskId: 't1',
  accountId: 'acc1',
  workspaceId: 'ws1',
  status: 'running',
  updatedAt: new Date(),
  milestones: [],
  prUrl: null,
  prNumber: null,
  commitCount: 0,
  currentAction: 'Processing...',
  error: null,
  task: { id: 't1' },
};

describe('diagnoseWorker', () => {
  beforeEach(() => {
    mockWorkersFindFirst.mockReset();
  });

  it('throws for unknown worker', async () => {
    mockWorkersFindFirst.mockResolvedValue(null);
    await expect(diagnoseWorker('unknown')).rejects.toThrow('not found');
  });

  it('returns none for completed worker', async () => {
    mockWorkersFindFirst.mockResolvedValue({ ...baseWorker, status: 'completed' });
    const result = await diagnoseWorker('w1');
    expect(result.recommendedAction).toBe('none');
    expect(result.confidence).toBe('high');
  });

  it('recommends complete for failed worker with PR', async () => {
    mockWorkersFindFirst.mockResolvedValue({
      ...baseWorker,
      status: 'failed',
      prUrl: 'https://github.com/org/repo/pull/1',
    });
    const result = await diagnoseWorker('w1');
    expect(result.recommendedAction).toBe('complete');
    expect(result.confidence).toBe('high');
  });

  it('recommends restart for failed worker with commits', async () => {
    mockWorkersFindFirst.mockResolvedValue({
      ...baseWorker,
      status: 'failed',
      commitCount: 3,
    });
    const result = await diagnoseWorker('w1');
    expect(result.recommendedAction).toBe('restart');
    expect(result.confidence).toBe('medium');
  });

  it('recommends restart for failed worker with transient error', async () => {
    mockWorkersFindFirst.mockResolvedValue({
      ...baseWorker,
      status: 'failed',
      error: 'Worker runner went offline (heartbeat expired)',
    });
    const result = await diagnoseWorker('w1');
    expect(result.recommendedAction).toBe('restart');
    expect(result.confidence).toBe('high');
    expect(result.diagnosis).toContain('transient');
  });

  it('recommends restart for failed worker with no progress', async () => {
    mockWorkersFindFirst.mockResolvedValue({
      ...baseWorker,
      status: 'error',
      error: 'Unknown error',
    });
    const result = await diagnoseWorker('w1');
    expect(result.recommendedAction).toBe('restart');
    expect(result.confidence).toBe('medium');
  });

  it('recommends diagnose for moderately stale running worker', async () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    mockWorkersFindFirst.mockResolvedValue({
      ...baseWorker,
      status: 'running',
      updatedAt: tenMinutesAgo,
    });
    const result = await diagnoseWorker('w1');
    expect(result.recommendedAction).toBe('diagnose');
    expect(result.confidence).toBe('medium');
  });

  it('recommends restart for very stale running worker without commits', async () => {
    const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000);
    mockWorkersFindFirst.mockResolvedValue({
      ...baseWorker,
      status: 'running',
      updatedAt: twentyMinutesAgo,
    });
    const result = await diagnoseWorker('w1');
    expect(result.recommendedAction).toBe('restart');
    expect(result.confidence).toBe('high');
  });

  it('recommends diagnose for very stale running worker with commits', async () => {
    const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000);
    mockWorkersFindFirst.mockResolvedValue({
      ...baseWorker,
      status: 'running',
      updatedAt: twentyMinutesAgo,
      commitCount: 5,
    });
    const result = await diagnoseWorker('w1');
    expect(result.recommendedAction).toBe('diagnose');
    expect(result.confidence).toBe('high');
  });

  it('recommends restart for long-waiting worker', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    mockWorkersFindFirst.mockResolvedValue({
      ...baseWorker,
      status: 'waiting_input',
      updatedAt: twoHoursAgo,
    });
    const result = await diagnoseWorker('w1');
    expect(result.recommendedAction).toBe('restart');
    expect(result.confidence).toBe('high');
  });

  it('returns none for active healthy worker', async () => {
    mockWorkersFindFirst.mockResolvedValue({
      ...baseWorker,
      status: 'running',
      updatedAt: new Date(), // Just updated
    });
    const result = await diagnoseWorker('w1');
    expect(result.recommendedAction).toBe('none');
  });
});
