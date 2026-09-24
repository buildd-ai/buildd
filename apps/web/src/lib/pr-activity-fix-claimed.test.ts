import { describe, it, expect, beforeEach, mock } from 'bun:test';

let workspaceRow: Record<string, unknown> | undefined;
const mockWorkspacesFindFirst = mock(async () => workspaceRow);
mock.module('@buildd/core/db', () => ({
  db: { query: { workspaces: { findFirst: mockWorkspacesFindFirst } } },
}));
mock.module('@buildd/core/db/schema', () => ({ workspaces: { id: 'id' } }));
mock.module('drizzle-orm', () => ({ eq: (field: string, value: unknown) => ({ field, value }) }));

const mockAppend = mock(async () => ({ action: 'updated', commentId: 1 }));
mock.module('./pr-activity-comment', () => ({
  appendPrActivity: mockAppend,
  taskActivityUrl: (id: string) => `https://buildd.dev/app/tasks/${id}`,
}));

const { fixAttemptOf, announceFixClaimed } = await import('./pr-activity-fix-claimed');

beforeEach(() => {
  workspaceRow = { id: 'ws-1', githubRepo: { fullName: 'o/r', installation: { installationId: 42 } } };
  mockAppend.mockClear();
  mockWorkspacesFindFirst.mockClear();
});

describe('fixAttemptOf', () => {
  it('recognises a builder-after-review attempt and reads its iteration', () => {
    expect(fixAttemptOf({
      id: 't', workspaceId: 'ws-1', reviewerRetryPrNumber: 2658, context: { iteration: 1, maxIterations: 3 },
    })).toEqual({ prNumber: 2658, iteration: 1, maxIterations: 3 });
  });

  it('recognises a CI retry', () => {
    expect(fixAttemptOf({ id: 't', workspaceId: 'ws-1', ciRetryPrNumber: 7, context: null }))
      .toEqual({ prNumber: 7, iteration: null, maxIterations: null });
  });

  it('ignores an ordinary task', () => {
    expect(fixAttemptOf({ id: 't', workspaceId: 'ws-1', context: { iteration: 1 } })).toBeNull();
  });
});

describe('announceFixClaimed', () => {
  it('moves the PR comment to Fixing, only on a comment that already exists', async () => {
    await announceFixClaimed({
      id: 'fix-1', workspaceId: 'ws-1', reviewerRetryPrNumber: 2658, context: { iteration: 1, maxIterations: 3 },
    });
    expect(mockAppend).toHaveBeenCalledTimes(1);
    const arg = (mockAppend.mock.calls[0] as unknown as [Record<string, any>])[0];
    expect(arg).toMatchObject({
      installationId: 42,
      repoFullName: 'o/r',
      prNumber: 2658,
      onlyIfPresent: true,
      entry: { kind: 'fix_started', iteration: 1, maxIterations: 3, taskUrl: 'https://buildd.dev/app/tasks/fix-1' },
    });
  });

  it('does nothing for a task that is not a fix attempt — no DB read either', async () => {
    await announceFixClaimed({ id: 't', workspaceId: 'ws-1' });
    expect(mockWorkspacesFindFirst).not.toHaveBeenCalled();
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('skips a workspace with no GitHub repo', async () => {
    workspaceRow = { id: 'ws-1', githubRepo: null };
    await announceFixClaimed({ id: 't', workspaceId: 'ws-1', ciRetryPrNumber: 7 });
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('never throws — a claim must not fail on a status comment', async () => {
    mockWorkspacesFindFirst.mockImplementationOnce(async () => { throw new Error('db down'); });
    await expect(announceFixClaimed({ id: 't', workspaceId: 'ws-1', ciRetryPrNumber: 7 })).resolves.toBeUndefined();
  });
});
