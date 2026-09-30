import { beforeEach, describe, expect, it, mock } from 'bun:test';

const mockGithubApi = mock((_installationId: number, _path: string): Promise<unknown> => Promise.resolve([]));
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
    ).resolves.toEqual({ safe: true, operationClass: 'EXPAND' });
    expect(mockGithubApi.mock.calls[1][1]).toContain(
      '/contents/packages/core/drizzle/0094_safe.sql?ref=abc123',
    );
  });

  it('finds a same-number migration in another open PR and owns the fix (higher PR number)', async () => {
    mockGithubApi
      .mockResolvedValueOnce([
        { filename: 'packages/core/drizzle/0094_safe.sql', status: 'added' },
      ])
      .mockResolvedValueOnce({
        encoding: 'base64',
        content: Buffer.from('CREATE TABLE "safe" ("id" uuid);').toString('base64'),
      })
      .mockResolvedValueOnce([{ number: 42 }, { number: 40 }])
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
      operationClass: 'CONTRACT',
      reason:
        'migration number collision: 0094_safe.sql conflicts with open PR #40 migration 0094_collision.sql',
      collision: { file: '0094_safe.sql', otherFile: '0094_collision.sql', otherPrNumber: 40 },
    });
  });

  it('does not report a collision when this PR is not the deterministic owner (lower PR number)', async () => {
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
    ).resolves.toEqual({ safe: true, operationClass: 'EXPAND' });
  });

  it('excludes a migration path already present on the base branch — inherited, not a real collision (PR #2540 gotcha)', async () => {
    mockGithubApi
      .mockResolvedValueOnce([
        { filename: 'packages/core/drizzle/0094_safe.sql', status: 'added' },
      ])
      .mockResolvedValueOnce({
        encoding: 'base64',
        content: Buffer.from('CREATE TABLE "safe" ("id" uuid);').toString('base64'),
      })
      .mockResolvedValueOnce([{ number: 42 }, { number: 40 }])
      .mockResolvedValueOnce([
        { filename: 'packages/core/drizzle/0093_inherited.sql', status: 'added' },
      ])
      .mockResolvedValueOnce({
        encoding: 'base64',
        content: Buffer.from('CREATE TABLE "inherited" ("id" uuid);').toString('base64'),
      });

    await expect(
      inspectPullRequestMigrations({
        installationId: 1,
        repoFullName: 'buildd-ai/buildd',
        prNumber: 42,
        headSha: 'abc123',
        files: [],
        baseRef: 'dev',
      }),
    ).resolves.toEqual({ safe: true, operationClass: 'EXPAND' });
  });

  it.each([
    ['identical stacked file', 'dev', 'CREATE TABLE "safe" ("id" uuid);', true, '0094_safe.sql'],
    ['identical SQL under a different name', 'dev', 'CREATE TABLE "safe" ("id" uuid);', false, '0094_other.sql'],
    ['same path with different SQL', 'dev', 'CREATE TABLE "other" ("id" uuid);', false],
    ['different base', 'mission/evidence', 'CREATE TABLE "other" ("id" uuid);', true],
    ['unreadable peer content', 'dev', undefined, false],
  ])('%s', async (_label, otherBase, otherSql, safe, otherName = '0094_safe.sql') => {
    const path = 'packages/core/drizzle/0094_safe.sql';
    const sql = 'CREATE TABLE "safe" ("id" uuid);';
    mockGithubApi.mockImplementation(async (_installation, url) => {
      if (url.includes('/pulls/42/files')) return [{ filename: path, status: 'added' }];
      if (url.includes('/pulls?')) return [{ number: 40, base: { ref: otherBase }, head: { sha: 'peer-head' } }];
      if (url.includes('/pulls/40/files')) return [{ filename: `packages/core/drizzle/${otherName}`, status: 'added' }];
      if (url.includes('ref=dev')) throw new Error('not on base');
      const content = url.includes('ref=peer-head') ? otherSql : sql;
      return content === undefined ? {} : { encoding: 'base64', content: Buffer.from(content).toString('base64') };
    });
    const result = await inspectPullRequestMigrations({
      installationId: 1, repoFullName: 'acme/app', prNumber: 42,
      headSha: 'abc123', files: [], baseRef: 'dev',
    });
    expect(result.safe).toBe(safe);
    if (otherBase !== 'dev') {
      expect(mockGithubApi.mock.calls.some((call) => call[1].includes('/pulls/40/files'))).toBe(false);
    }
  });

  it.each([true, false])('requires matching content to exclude a same-path migration on the base (identical=%s)', async (identical) => {
    const path = 'packages/core/drizzle/0094_safe.sql';
    const sql = 'CREATE TABLE "safe" ("id" uuid);';
    mockGithubApi
      .mockResolvedValueOnce([{ filename: path, status: 'added' }])
      .mockResolvedValueOnce({ encoding: 'base64', content: Buffer.from(sql).toString('base64') })
      .mockResolvedValueOnce([{ number: 40, base: { ref: 'dev' } }])
      .mockResolvedValueOnce([{ filename: path, status: 'added' }])
      .mockResolvedValueOnce({ encoding: 'base64', content: Buffer.from(identical ? sql : sql + '\n').toString('base64') });
    const result = await inspectPullRequestMigrations({
      installationId: 1, repoFullName: 'acme/app', prNumber: 42,
      headSha: 'abc123', files: [], baseRef: 'dev',
    });
    expect(result.safe).toBe(identical);
  });

  it('escalates deleting a generated migration', async () => {
    mockGithubApi.mockResolvedValueOnce([
      {
        filename: 'packages/core/drizzle/0094_safe.sql',
        status: 'removed',
      },
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
      operationClass: 'CONTRACT',
      reason: 'deletes generated migration packages/core/drizzle/0094_safe.sql',
    });
    expect(mockGithubApi).toHaveBeenCalledTimes(1);
  });

  it('escalates modifying an existing generated migration', async () => {
    mockGithubApi.mockResolvedValueOnce([
      {
        filename: 'packages/core/drizzle/0094_safe.sql',
        status: 'modified',
      },
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
      operationClass: 'CONTRACT',
      reason: 'modifies existing migration packages/core/drizzle/0094_safe.sql',
    });
    expect(mockGithubApi).toHaveBeenCalledTimes(1);
  });
});
