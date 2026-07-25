import { beforeEach, describe, expect, it, mock } from 'bun:test';

const mockGithubApi = mock(() => Promise.resolve([]) as Promise<unknown>);
mock.module('@/lib/github', () => ({ githubApi: mockGithubApi }));

import { inspectPullRequestMigrations } from './migration-inspector';

describe('inspectPullRequestMigrations', () => {
  beforeEach(() => mockGithubApi.mockReset());

  it('loads generated SQL at the head SHA and allows an additive PR', async () => {
    mockGithubApi
      .mockResolvedValueOnce([
        { filename: 'packages/core/db/schema.ts', status: 'modified' },
        { filename: 'packages/core/drizzle/0094_safe.sql', status: 'added' },
      ])
      .mockResolvedValueOnce({
        encoding: 'base64',
        content: Buffer.from(
          'ALTER TABLE "missions" ADD COLUMN "summary" text;',
        ).toString('base64'),
      })
      .mockResolvedValueOnce([{ number: 42 }]);

    await expect(
      inspectPullRequestMigrations({
        installationId: 1,
        repoFullName: 'buildd-ai/buildd',
        prNumber: 42,
        headSha: 'abc123',
        files: [],
      }),
    ).resolves.toEqual({ safe: true });
    expect(mockGithubApi.mock.calls[1][1]).toContain(
      '/contents/packages/core/drizzle/0094_safe.sql?ref=abc123',
    );
  });

  it('finds a same-number migration in another open PR', async () => {
    mockGithubApi
      .mockResolvedValueOnce([
        { filename: 'packages/core/drizzle/0094_safe.sql', status: 'added' },
      ])
      .mockResolvedValueOnce({
        encoding: 'base64',
        content: Buffer.from('CREATE TABLE "safe" ("id" uuid);').toString('base64'),
      })
      .mockResolvedValueOnce([{ number: 42 }, { number: 43 }])
      .mockResolvedValueOnce([
        { filename: 'packages/core/drizzle/0094_collision.sql', status: 'added' },
      ]);

    await expect(
      inspectPullRequestMigrations({
        installationId: 1,
        repoFullName: 'buildd-ai/buildd',
        prNumber: 42,
        headSha: 'abc123',
        files: [],
      }),
    ).resolves.toEqual({
      safe: false,
      reason:
        'migration number collision: 0094_safe.sql conflicts with open PR migration 0094_collision.sql',
    });
  });
});
