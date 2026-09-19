import { describe, it, expect, beforeEach, mock } from 'bun:test';

let workerRow: any = null;
const updateCalls: Array<{ data: any; where: any }> = [];
const mockGithubApi = mock((_installationId: number, _path: string) => Promise.resolve({} as any));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findFirst: () => Promise.resolve(workerRow) },
    },
    update: () => ({
      set: (data: any) => ({
        where: (where: any) => {
          updateCalls.push({ data, where });
          return Promise.resolve();
        },
      }),
    }),
  },
}));

mock.module('@buildd/core/db/schema', () => ({
  workers: { id: 'id' },
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ type: 'eq', a, b }),
}));

mock.module('@/lib/github', () => ({
  githubApi: mockGithubApi,
}));

import { recordPrSupersession } from './pr-supersession';

function baseWorker(overrides: Record<string, unknown> = {}) {
  return {
    id: 'w-1',
    prNumber: 2287,
    prUrl: 'https://github.com/org/repo/pull/2287',
    mergedAt: null,
    workspace: {
      githubRepo: {
        fullName: 'org/repo',
        installation: { installationId: 123 },
      },
    },
    ...overrides,
  };
}

function reset() {
  workerRow = baseWorker();
  updateCalls.length = 0;
  mockGithubApi.mockReset();
  mockGithubApi.mockImplementation(() => Promise.resolve({ merged: true, html_url: 'https://github.com/org/repo/pull/2293', state: 'closed' }) as any);
}

describe('recordPrSupersession', () => {
  beforeEach(reset);

  it('rejects a blank reason', async () => {
    const r = await recordPrSupersession({ workerId: 'w-1', supersedingPrNumber: 2293, reason: '   ', recordedBy: 'agent:t-1' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
    expect(updateCalls.length).toBe(0);
  });

  it('rejects a non-positive-integer supersedingPrNumber', async () => {
    const r = await recordPrSupersession({ workerId: 'w-1', supersedingPrNumber: 0, reason: 'because', recordedBy: 'a' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('rejects when the worker is not found', async () => {
    workerRow = null;
    const r = await recordPrSupersession({ workerId: 'w-1', supersedingPrNumber: 2293, reason: 'because', recordedBy: 'a' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
  });

  it('rejects a worker with no PR to supersede', async () => {
    workerRow = baseWorker({ prNumber: null, prUrl: null });
    const r = await recordPrSupersession({ workerId: 'w-1', supersedingPrNumber: 2293, reason: 'because', recordedBy: 'a' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('rejects when the worker PR is already merged — nothing to supersede', async () => {
    workerRow = baseWorker({ mergedAt: new Date() });
    const r = await recordPrSupersession({ workerId: 'w-1', supersedingPrNumber: 2293, reason: 'because', recordedBy: 'a' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
    expect(updateCalls.length).toBe(0);
  });

  it('rejects a supersedingPrNumber equal to the PR being superseded', async () => {
    const r = await recordPrSupersession({ workerId: 'w-1', supersedingPrNumber: 2287, reason: 'because', recordedBy: 'a' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('rejects when the workspace has no GitHub installation', async () => {
    workerRow = baseWorker({ workspace: { githubRepo: null } });
    const r = await recordPrSupersession({ workerId: 'w-1', supersedingPrNumber: 2293, reason: 'because', recordedBy: 'a' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(422);
  });

  it('rejects a nonexistent target PR (GitHub 404)', async () => {
    mockGithubApi.mockImplementation(() => Promise.reject(new Error('GitHub API error: 404 Not Found')));
    const r = await recordPrSupersession({ workerId: 'w-1', supersedingPrNumber: 999999, reason: 'because', recordedBy: 'a' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(404);
      expect(r.error).toContain('999999');
    }
    expect(updateCalls.length).toBe(0);
  });

  it('rejects an UNMERGED target PR — write time, not discovered later', async () => {
    mockGithubApi.mockImplementation(() => Promise.resolve({ merged: false, state: 'open' }) as any);
    const r = await recordPrSupersession({ workerId: 'w-1', supersedingPrNumber: 2293, reason: 'because', recordedBy: 'a' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      expect(r.error).toContain('not merged');
    }
    expect(updateCalls.length).toBe(0);
  });

  it('records the edge when the target PR is merged, scoped to the same repo/installation', async () => {
    const r = await recordPrSupersession({
      workerId: 'w-1',
      supersedingPrNumber: 2293,
      reason: 'branch deleted out from under it; re-landed via #2293',
      recordedBy: 'agent:t-1',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.supersededPrNumber).toBe(2287);
      expect(r.supersedingPrNumber).toBe(2293);
      expect(r.supersedingPrUrl).toBe('https://github.com/org/repo/pull/2293');
    }
    expect(mockGithubApi).toHaveBeenCalledWith(123, '/repos/org/repo/pulls/2293');
    expect(updateCalls.length).toBe(1);
    expect(updateCalls[0].data).toMatchObject({
      supersededByPrNumber: 2293,
      supersededByPrUrl: 'https://github.com/org/repo/pull/2293',
      supersededReason: 'branch deleted out from under it; re-landed via #2293',
      supersededRecordedBy: 'agent:t-1',
    });
    expect(updateCalls[0].data.supersededAt).toBeInstanceOf(Date);
  });
});
