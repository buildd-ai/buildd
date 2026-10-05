import { describe, it, expect, mock, beforeEach } from 'bun:test';

let outcome: any = { status: 'completed', message: 'Released' };
const mockExecuteRelease = mock(async (_i: unknown) => outcome);
const mockFire = mock(async (..._a: unknown[]) => {});
mock.module('@/lib/release-executor', () => ({ executeRelease: mockExecuteRelease }));
mock.module('@/lib/mission-release', () => ({ fireMissionReleaseIfComplete: mockFire }));

const { releasePolicy } = await import('./release-completion-policy');
const input = { taskId: 't-1', workerId: 'w-1', workspaceId: 'ws-1', missionId: 'm-1' };

beforeEach(() => { mockExecuteRelease.mockClear(); mockFire.mockClear(); });

describe('release policy', () => {
  it('runs the per-task release with the task, worker and workspace', async () => {
    await releasePolicy.evaluate(input);
    expect(mockExecuteRelease).toHaveBeenCalledWith({ taskId: 't-1', workerId: 'w-1', workspaceId: 'ws-1' });
  });

  it.each([
    ['completed'], ['skipped'], ['not_configured'],
  ])('%s passes, carrying the record and summary', async (status) => {
    outcome = { status, message: `Release: ${status}` };
    expect(await releasePolicy.evaluate(input)).toEqual({ kind: 'pass', record: outcome, summary: `Release: ${status}` });
  });

  it('failed fails, with the error as the reason (the message when there is none) and the PR url', async () => {
    outcome = { status: 'failed', message: 'CI red', error: 'CI red on main', releasePrUrl: 'https://example.test/pr/9' };
    expect(await releasePolicy.evaluate(input)).toEqual({
      kind: 'fail', record: outcome, summary: 'CI red', reason: 'CI red on main', prUrl: 'https://example.test/pr/9',
    });
    outcome = { status: 'failed', message: 'No PR found' };
    expect(await releasePolicy.evaluate(input)).toMatchObject({ kind: 'fail', reason: 'No PR found', prUrl: undefined });
  });

  it('pending_ci holds for CI with the release PR', async () => {
    outcome = { status: 'pending_ci', message: 'Waiting', releasePrNumber: 9, releasePrUrl: 'https://example.test/pr/9' };
    expect(await releasePolicy.evaluate(input)).toEqual({
      kind: 'hold', until: 'ci', record: outcome, summary: 'Waiting', prNumber: 9, prUrl: 'https://example.test/pr/9',
    });
  });

  it('settled fires the mission release for a mission task only', () => {
    releasePolicy.settled(input);
    expect(mockFire).toHaveBeenCalledWith('ws-1', 'm-1', 't-1', 'w-1');
    mockFire.mockClear();
    releasePolicy.settled({ ...input, missionId: null });
    expect(mockFire).not.toHaveBeenCalled();
  });
});
