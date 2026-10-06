import { describe, it, expect, beforeEach, mock } from 'bun:test';

const REPO = { fullName: 'acme/widgets', installationId: 42 };
const TASK = { id: 'task-1', workspaceId: 'ws-1', result: { summary: 'closed by hand' } as unknown };

const mockWorkersFindFirst = mock(() => Promise.resolve(null as any));
const mockGithubApi = mock(() => Promise.resolve(null as any));
const mockInsertPrOwnerWorker = mock(() => Promise.resolve({ id: 'worker-new' } as any));
const mockSet = mock(() => ({ where: mock(() => Promise.resolve()) }));
const mockUpdate = mock(() => ({ set: mockSet }));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findFirst: mockWorkersFindFirst },
      githubRepos: { findFirst: mock(() => Promise.resolve(null)) },
    },
    update: mockUpdate,
  },
}));
mock.module('./github', () => ({ githubApi: mockGithubApi }));
mock.module('./pr-review-request', () => ({ insertPrOwnerWorker: mockInsertPrOwnerWorker }));

import { attachPrToTask, parsePrReference } from './task-pr-attach';

function pr(overrides: Record<string, unknown> = {}) {
  return {
    number: 17,
    html_url: 'https://github.com/acme/widgets/pull/17',
    state: 'closed',
    merged: true,
    merged_at: '2026-09-20T10:00:00Z',
    head: { ref: 'feature/x', sha: 'abc' },
    base: { ref: 'dev', sha: 'def' },
    ...overrides,
  };
}

describe('parsePrReference', () => {
  it('reads the number off a PR URL in the workspace repo', () => {
    expect(parsePrReference({ prUrl: 'https://github.com/acme/widgets/pull/17' }, 'acme/widgets')).toEqual({ prNumber: 17 });
  });

  it('matches the repo case-insensitively and tolerates a trailing path', () => {
    expect(parsePrReference({ prUrl: 'https://github.com/Acme/Widgets/pull/17/files' }, 'acme/widgets')).toEqual({ prNumber: 17 });
  });

  it('accepts a bare prNumber', () => {
    expect(parsePrReference({ prNumber: 17 }, 'acme/widgets')).toEqual({ prNumber: 17 });
  });

  it('refuses a PR in another repo', () => {
    const r = parsePrReference({ prUrl: 'https://github.com/other/repo/pull/17' }, 'acme/widgets');
    expect('error' in r && r.error).toContain('other/repo');
  });

  it('refuses a URL and number that disagree', () => {
    const r = parsePrReference({ prUrl: 'https://github.com/acme/widgets/pull/17', prNumber: 18 }, 'acme/widgets');
    expect('error' in r).toBe(true);
  });

  it('refuses a non-PR URL, a bad number, and nothing at all', () => {
    expect('error' in parsePrReference({ prUrl: 'https://github.com/acme/widgets/issues/17' }, 'acme/widgets')).toBe(true);
    expect('error' in parsePrReference({ prNumber: -3 }, 'acme/widgets')).toBe(true);
    expect('error' in parsePrReference({}, 'acme/widgets')).toBe(true);
  });
});

describe('attachPrToTask', () => {
  beforeEach(() => {
    mockWorkersFindFirst.mockReset();
    mockWorkersFindFirst.mockResolvedValue(null);
    mockGithubApi.mockReset();
    mockGithubApi.mockResolvedValue(pr());
    mockInsertPrOwnerWorker.mockReset();
    mockInsertPrOwnerWorker.mockResolvedValue({ id: 'worker-new' });
    mockSet.mockClear();
    mockUpdate.mockClear();
  });

  it('creates an external placeholder worker and fills result.prUrl', async () => {
    const out = await attachPrToTask({ task: TASK, repo: REPO, prNumber: 17, accountId: 'acct-1' });

    expect(out).toMatchObject({ ok: true, alreadyAttached: false, workerId: 'worker-new', prState: 'merged' });
    const insertArgs = (mockInsertPrOwnerWorker.mock.calls[0] as any[])[0];
    expect(insertArgs).toMatchObject({ workspaceId: 'ws-1', taskId: 'task-1', repoFullName: 'acme/widgets', accountId: 'acct-1' });
    expect(insertArgs.pr.number).toBe(17);

    const written = (mockSet.mock.calls[0] as any[])[0].result;
    expect(written).toMatchObject({
      summary: 'closed by hand',
      prUrl: 'https://github.com/acme/widgets/pull/17',
      prNumber: 17,
      branch: 'feature/x',
    });
  });

  it('writes nothing when the PR does not exist', async () => {
    mockGithubApi.mockRejectedValue(new Error('GitHub API error: 404 Not Found'));
    const out = await attachPrToTask({ task: TASK, repo: REPO, prNumber: 999 });
    expect(out).toMatchObject({ ok: false, status: 404 });
    expect(mockInsertPrOwnerWorker).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('refuses a PR another task already owns', async () => {
    mockWorkersFindFirst.mockResolvedValue({ id: 'w-other', taskId: 'task-other', prUrl: 'x' });
    const out = await attachPrToTask({ task: TASK, repo: REPO, prNumber: 17 });
    expect(out).toMatchObject({ ok: false, status: 409 });
    expect(mockGithubApi).not.toHaveBeenCalled();
  });

  it('refuses to replace a different PR already on the task', async () => {
    const out = await attachPrToTask({ task: { ...TASK, result: { prNumber: 5 } }, repo: REPO, prNumber: 17 });
    expect(out).toMatchObject({ ok: false, status: 409 });
    expect(mockInsertPrOwnerWorker).not.toHaveBeenCalled();
  });

  it('is idempotent when this task already owns the PR', async () => {
    mockWorkersFindFirst.mockResolvedValue({ id: 'w-mine', taskId: 'task-1', prUrl: 'x' });
    const out = await attachPrToTask({ task: TASK, repo: REPO, prNumber: 17 });
    expect(out).toMatchObject({ ok: true, alreadyAttached: true, workerId: 'w-mine' });
    expect(mockInsertPrOwnerWorker).not.toHaveBeenCalled();
  });

  it('reports an open PR as open', async () => {
    mockGithubApi.mockResolvedValue(pr({ state: 'open', merged: false, merged_at: null }));
    const out = await attachPrToTask({ task: TASK, repo: REPO, prNumber: 17 });
    expect(out).toMatchObject({ ok: true, prState: 'open' });
  });

  it('moves an auto-adopted placeholder mapping onto the task that actually did the work', async () => {
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-placeholder',
      taskId: 'task-bookkeeping',
      prUrl: 'x',
      runner: 'external',
      task: { taskClass: 'bookkeeping', context: { adoptedPr: { prNumber: 17 } } },
    });
    const out = await attachPrToTask({ task: TASK, repo: REPO, prNumber: 17 });

    expect(out).toMatchObject({ ok: true, alreadyAttached: false, workerId: 'w-placeholder' });
    expect(mockInsertPrOwnerWorker).not.toHaveBeenCalled();
    const moveCall = mockSet.mock.calls.find((c: any[]) => c[0]?.taskId === 'task-1');
    expect(moveCall).toBeTruthy();
  });

  it('leaves the placeholder mapping untouched when the PR cannot be read', async () => {
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-placeholder',
      taskId: 'task-bookkeeping',
      prUrl: 'x',
      runner: 'external',
      task: { taskClass: 'bookkeeping', context: { adoptedPr: { prNumber: 17 } } },
    });
    mockGithubApi.mockRejectedValue(new Error('GitHub API error: 404 Not Found'));
    const out = await attachPrToTask({ task: TASK, repo: REPO, prNumber: 17 });
    expect(out).toMatchObject({ ok: false, status: 404 });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('still refuses a non-placeholder worker owned by another task even with a task row attached', async () => {
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-other',
      taskId: 'task-other',
      prUrl: 'x',
      runner: 'claude-code',
      task: { taskClass: 'work', context: {} },
    });
    const out = await attachPrToTask({ task: TASK, repo: REPO, prNumber: 17 });
    expect(out).toMatchObject({ ok: false, status: 409 });
    expect(mockGithubApi).not.toHaveBeenCalled();
  });
});
