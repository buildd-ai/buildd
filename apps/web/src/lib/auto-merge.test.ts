import { beforeEach, describe, expect, it, mock } from 'bun:test';

const mockGithubApi = mock(() => Promise.resolve({ check_runs: [] }) as Promise<unknown>);
mock.module('@/lib/github', () => ({
  githubApi: mockGithubApi,
  mergePullRequest: mock(() => Promise.resolve()),
}));
mock.module('@buildd/core/db', () => ({
  db: { query: { tasks: { findFirst: mock(() => Promise.resolve(null)) } } },
}));
mock.module('@buildd/core/db/schema', () => ({ tasks: {} }));
mock.module('drizzle-orm', () => ({ eq: mock(() => ({})) }));
mock.module('@/lib/mission-notifications', () => ({
  notifyMissionPrReady: mock(() => Promise.resolve()),
}));

const mockInspectPullRequestMigrations = mock(() => Promise.resolve({ safe: true as const }));
mock.module('@/lib/migration-inspector', () => ({
  inspectPullRequestMigrations: mockInspectPullRequestMigrations,
}));

import { evaluateAutoMergeSafety } from './auto-merge';

const params = [1, 'buildd-ai/buildd', 42, 'head-sha'] as const;

describe('evaluateAutoMergeSafety schema deny paths', () => {
  beforeEach(() => {
    mockGithubApi.mockReset();
    mockGithubApi
      .mockResolvedValueOnce({ check_runs: [] })
      .mockResolvedValueOnce([
        { filename: 'packages/core/db/schema.ts', additions: 2, deletions: 0 },
        { filename: 'packages/core/drizzle/0094_safe.sql', additions: 1, deletions: 0 },
      ]);
    mockInspectPullRequestMigrations.mockReset();
    mockInspectPullRequestMigrations.mockResolvedValue({ safe: true });
  });

  it('allows additive SQL through a schema-specific deny path', async () => {
    await expect(
      evaluateAutoMergeSafety(...params, {
        autoMergeDenyPaths: ['packages/core/db/schema.ts', 'packages/core/drizzle/'],
      }),
    ).resolves.toEqual({ ok: true });
    expect(mockInspectPullRequestMigrations).toHaveBeenCalledTimes(1);
  });

  it('returns the specific destructive migration reason', async () => {
    mockInspectPullRequestMigrations.mockResolvedValue({
      safe: false,
      reason: 'drops column missions.legacy_mode',
    });
    await expect(
      evaluateAutoMergeSafety(...params, {
        autoMergeDenyPaths: ['packages/core/db/schema.ts'],
      }),
    ).resolves.toEqual({
      ok: false,
      reason: 'drops column missions.legacy_mode',
    });
  });

  it('does not narrow an ordinary deny path', async () => {
    mockGithubApi.mockReset();
    mockGithubApi
      .mockResolvedValueOnce({ check_runs: [] })
      .mockResolvedValueOnce([
        { filename: '.github/workflows/build.yml', additions: 2, deletions: 0 },
      ]);
    await expect(
      evaluateAutoMergeSafety(...params, {
        autoMergeDenyPaths: ['.github/workflows/'],
      }),
    ).resolves.toEqual({
      ok: false,
      reason: 'touches protected path (.github/workflows/build.yml)',
    });
    expect(mockInspectPullRequestMigrations).not.toHaveBeenCalled();
  });
});
