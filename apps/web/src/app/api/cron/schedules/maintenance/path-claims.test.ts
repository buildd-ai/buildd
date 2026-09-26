import { describe, it, expect, mock, beforeEach } from 'bun:test';

const mockFindStaleClaimHolderTaskIds = mock(async () => [] as string[]);
const mockResolveReleaseReasonForTask = mock(async (_taskId: string) => 'abandoned' as const);
const mockReleaseAndNotify = mock(async (_taskId: string, _reason: string) => {});

mock.module('@buildd/core/path-claim', () => ({
  findStaleClaimHolderTaskIds: mockFindStaleClaimHolderTaskIds,
}));

mock.module('@/lib/path-claim-release', () => ({
  releaseAndNotify: mockReleaseAndNotify,
  resolveReleaseReasonForTask: mockResolveReleaseReasonForTask,
}));

import { sweepAbandonedPathClaims } from './path-claims';

beforeEach(() => {
  mockFindStaleClaimHolderTaskIds.mockReset();
  mockFindStaleClaimHolderTaskIds.mockResolvedValue([]);
  mockResolveReleaseReasonForTask.mockReset();
  mockResolveReleaseReasonForTask.mockResolvedValue('abandoned');
  mockReleaseAndNotify.mockReset();
  mockReleaseAndNotify.mockResolvedValue(undefined);
});

describe('sweepAbandonedPathClaims', () => {
  it('returns 0 and touches nothing when there are no stale holders', async () => {
    const released = await sweepAbandonedPathClaims();
    expect(released).toBe(0);
    expect(mockReleaseAndNotify).not.toHaveBeenCalled();
  });

  it('releases every stale holder with its resolved reason', async () => {
    mockFindStaleClaimHolderTaskIds.mockResolvedValue(['task-a', 'task-b']);
    mockResolveReleaseReasonForTask.mockImplementation(async (taskId: string) =>
      taskId === 'task-a' ? 'pending_merge' : 'abandoned',
    );

    const released = await sweepAbandonedPathClaims();

    expect(released).toBe(2);
    expect(mockReleaseAndNotify).toHaveBeenCalledTimes(2);
    expect(mockReleaseAndNotify).toHaveBeenCalledWith('task-a', 'pending_merge');
    expect(mockReleaseAndNotify).toHaveBeenCalledWith('task-b', 'abandoned');
  });

  it('keeps releasing the remaining holders when one fails', async () => {
    mockFindStaleClaimHolderTaskIds.mockResolvedValue(['task-a', 'task-b']);
    mockReleaseAndNotify.mockImplementation(async (taskId: string) => {
      if (taskId === 'task-a') throw new Error('db down');
    });

    const released = await sweepAbandonedPathClaims();

    expect(released).toBe(1);
    expect(mockReleaseAndNotify).toHaveBeenCalledTimes(2);
  });

  it('returns 0 and swallows a failure from the holder lookup itself', async () => {
    mockFindStaleClaimHolderTaskIds.mockImplementation(async () => {
      throw new Error('db down');
    });

    const released = await sweepAbandonedPathClaims();

    expect(released).toBe(0);
    expect(mockReleaseAndNotify).not.toHaveBeenCalled();
  });
});
