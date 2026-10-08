import { beforeEach, describe, expect, it, mock } from 'bun:test';

const mockGithubApi = mock((_installationId: number, _path: string): Promise<unknown> => Promise.resolve([]));
mock.module('@/lib/github', () => ({ githubApi: mockGithubApi }));

import { inspectPullRequestMigrations } from './migration-inspector';

const DIR = 'packages/core/drizzle';
const BASE_SHA = 'base-tip-sha';

function blob(content: string) {
  return { encoding: 'base64', content: Buffer.from(content).toString('base64') };
}

/**
 * Route GitHub reads by URL. `head` / `base` map path → SQL at this PR's head
 * and at the target's current tip; `peers` are other open PRs with their files
 * and head SQL. A missing key is a 404.
 */
function github(opts: {
  files: Array<{ filename: string; status?: string }>;
  head?: Record<string, string>;
  base?: Record<string, string>;
  baseRef?: string;
  peers?: Array<{
    number: number;
    baseRef?: string;
    files: Array<{ filename: string; status?: string }>;
    head?: Record<string, string>;
  }>;
}) {
  mockGithubApi.mockImplementation(async (_installation, url) => {
    if (url.includes('/pulls/42/files')) return opts.files;
    if (url.endsWith('/pulls/42')) return { number: 42, base: { ref: opts.baseRef ?? 'dev' } };
    if (url.includes('/git/ref/heads/')) return { object: { sha: BASE_SHA } };
    if (url.includes('/pulls?')) {
      return [
        { number: 42 },
        ...(opts.peers ?? []).map((peer) => ({
          number: peer.number,
          base: { ref: peer.baseRef ?? 'dev' },
          head: { sha: `peer-${peer.number}` },
        })),
      ];
    }
    const peerFiles = /\/pulls\/(\d+)\/files/.exec(url);
    if (peerFiles) return opts.peers?.find((p) => p.number === Number(peerFiles[1]))?.files ?? [];
    const contents = /\/contents\/(.+)\?ref=(.+)$/.exec(url);
    if (contents) {
      const [, path, ref] = contents;
      const source =
        ref === 'abc123' ? opts.head
          : ref === BASE_SHA ? opts.base
            : opts.peers?.find((p) => ref === `peer-${p.number}`)?.head;
      const sql = source?.[decodeURIComponent(path)];
      if (sql === undefined) throw new Error('Not Found');
      return blob(sql);
    }
    throw new Error(`unexpected GitHub call ${url}`);
  });
}

function inspect(baseRef?: string | null) {
  return inspectPullRequestMigrations({
    installationId: 1,
    repoFullName: 'acme/app',
    prNumber: 42,
    headSha: 'abc123',
    files: [],
    ...(baseRef !== undefined ? { baseRef } : {}),
  });
}

const SAFE = 'CREATE TABLE "safe" ("id" uuid);';
const DROP_CONSTRAINT = 'ALTER TABLE "tasks" DROP CONSTRAINT "tasks_owner_fk";';

describe('inspectPullRequestMigrations', () => {
  beforeEach(() => mockGithubApi.mockReset());

  it('loads generated SQL at the head SHA and allows an additive PR', async () => {
    github({
      files: [
        { filename: 'packages/core/db/schema.ts', status: 'modified' },
        { filename: `${DIR}/0094_safe.sql`, status: 'added' },
      ],
      head: { [`${DIR}/0094_safe.sql`]: 'ALTER TABLE "missions" ADD COLUMN "summary" text;' },
    });

    await expect(inspect()).resolves.toEqual({ safe: true, operationClass: 'EXPAND' });
    expect(mockGithubApi.mock.calls.some((c) => c[1].includes(`/contents/${DIR}/0094_safe.sql?ref=abc123`))).toBe(true);
  });

  it('does not read the base when the PR carries no migration', async () => {
    github({ files: [{ filename: 'packages/core/db/schema.ts', status: 'modified' }] });
    await expect(inspect('dev')).resolves.toEqual({ safe: true, operationClass: 'EXPAND' });
    expect(mockGithubApi.mock.calls.some((c) => c[1].includes('/git/ref/'))).toBe(false);
  });

  describe('SQL the target already carries (incident #3986 shape)', () => {
    const inheritedPath = `${DIR}/0266_faulty_venom.sql`;
    const inheritedSql = 'ALTER TABLE "tasks" ADD COLUMN "x" text;--> statement-breakpoint\nALTER TABLE "tasks" DROP COLUMN "old";';

    it('excludes a byte-identical inherited migration from this PR’s own classification', async () => {
      github({
        baseRef: 'mission/evidence',
        files: [
          { filename: inheritedPath, status: 'added' },
          { filename: `${DIR}/0267_new.sql`, status: 'added' },
        ],
        head: { [inheritedPath]: inheritedSql, [`${DIR}/0267_new.sql`]: SAFE },
        base: { [inheritedPath]: inheritedSql },
      });

      await expect(inspect('mission/evidence')).resolves.toEqual({ safe: true, operationClass: 'EXPAND' });
      // Compared at the target's current tip SHA, not a branch name or merge base.
      expect(mockGithubApi.mock.calls.some((c) => c[1].endsWith('/git/ref/heads/mission/evidence'))).toBe(true);
      expect(mockGithubApi.mock.calls.some((c) => c[1].includes(`${inheritedPath}?ref=${BASE_SHA}`))).toBe(true);
    });

    it('resolves the base from the PR when the caller does not pass it', async () => {
      github({
        files: [{ filename: inheritedPath, status: 'added' }],
        head: { [inheritedPath]: inheritedSql },
        base: { [inheritedPath]: inheritedSql },
      });
      await expect(inspect()).resolves.toEqual({ safe: true, operationClass: 'EXPAND' });
    });

    it('still holds novel destructive SQL that is not on the target', async () => {
      github({
        files: [
          { filename: inheritedPath, status: 'added' },
          { filename: `${DIR}/0267_drop_fk.sql`, status: 'added' },
        ],
        head: { [inheritedPath]: inheritedSql, [`${DIR}/0267_drop_fk.sql`]: DROP_CONSTRAINT },
        base: { [inheritedPath]: inheritedSql },
      });
      await expect(inspect('dev')).resolves.toEqual({
        safe: false,
        operationClass: 'CONTRACT',
        reason: 'drops constraint tasks.tasks_owner_fk',
      });
    });

    it('classifies a same-path migration whose bytes differ from the target', async () => {
      github({
        files: [{ filename: inheritedPath, status: 'added' }],
        head: { [inheritedPath]: inheritedSql },
        base: { [inheritedPath]: `${inheritedSql}\n` },
      });
      const result = await inspect('dev');
      expect(result.safe).toBe(false);
      expect(!result.safe && result.reason).toBe('drops column tasks.old');
    });

    it('fails closed when the target tip cannot be resolved', async () => {
      github({
        files: [{ filename: inheritedPath, status: 'added' }],
        head: { [inheritedPath]: inheritedSql },
        base: { [inheritedPath]: inheritedSql },
      });
      const route = mockGithubApi.getMockImplementation()!;
      mockGithubApi.mockImplementation(async (i, url) => {
        if (url.includes('/git/ref/')) throw new Error('Not Found');
        return route(i, url);
      });
      expect((await inspect('dev')).safe).toBe(false);
    });

    it('fails closed when this PR’s head SQL is unreadable', async () => {
      github({
        files: [{ filename: `${DIR}/0267_new.sql`, status: 'added' }],
        base: { [`${DIR}/0267_new.sql`]: SAFE },
      });
      const result = await inspect('dev');
      expect(!result.safe && result.reason).toBe(`could not inspect generated migration ${DIR}/0267_new.sql`);
    });

    it('treats a "modified" migration identical to the target as inherited', async () => {
      github({
        files: [{ filename: inheritedPath, status: 'modified' }],
        head: { [inheritedPath]: inheritedSql },
        base: { [inheritedPath]: inheritedSql },
      });
      await expect(inspect('dev')).resolves.toEqual({ safe: true, operationClass: 'EXPAND' });
    });

    it('holds a "renamed" migration even when the bytes match the target', async () => {
      github({
        files: [{ filename: inheritedPath, status: 'renamed' }],
        head: { [inheritedPath]: inheritedSql },
        base: { [inheritedPath]: inheritedSql },
      });
      const result = await inspect('dev');
      expect(!result.safe && result.reason).toBe(`modifies existing migration ${inheritedPath}`);
    });

    it('holds novel SQL numbered before a migration already on the target', async () => {
      github({
        files: [
          { filename: inheritedPath, status: 'added' },
          { filename: `${DIR}/0265_late.sql`, status: 'added' },
        ],
        head: { [inheritedPath]: inheritedSql, [`${DIR}/0265_late.sql`]: SAFE },
        base: { [inheritedPath]: inheritedSql },
      });
      const result = await inspect('dev');
      expect(!result.safe && result.reason).toBe(
        `migration ${DIR}/0265_late.sql is ordered before migrations already on the base`,
      );
    });

    it('does not let an inherited slot count as this PR’s collision', async () => {
      github({
        files: [{ filename: inheritedPath, status: 'added' }],
        head: { [inheritedPath]: inheritedSql },
        base: { [inheritedPath]: inheritedSql },
        peers: [{ number: 40, files: [{ filename: `${DIR}/0266_other.sql`, status: 'added' }] }],
      });
      await expect(inspect('dev')).resolves.toEqual({ safe: true, operationClass: 'EXPAND' });
    });
  });

  it('finds a same-number migration in another open PR and owns the fix (higher PR number)', async () => {
    github({
      files: [{ filename: `${DIR}/0094_safe.sql`, status: 'added' }],
      head: { [`${DIR}/0094_safe.sql`]: SAFE },
      peers: [{ number: 40, files: [{ filename: `${DIR}/0094_collision.sql`, status: 'added' }] }],
    });

    await expect(inspect()).resolves.toEqual({
      safe: false,
      operationClass: 'CONTRACT',
      reason:
        'migration number collision: 0094_safe.sql conflicts with open PR #40 migration 0094_collision.sql',
      collision: { file: '0094_safe.sql', otherFile: '0094_collision.sql', otherPrNumber: 40 },
    });
  });

  it('does not report a collision when this PR is not the deterministic owner (lower PR number)', async () => {
    github({
      files: [{ filename: `${DIR}/0094_safe.sql`, status: 'added' }],
      head: { [`${DIR}/0094_safe.sql`]: SAFE },
      peers: [{ number: 43, files: [{ filename: `${DIR}/0094_collision.sql`, status: 'added' }] }],
    });
    await expect(inspect()).resolves.toEqual({ safe: true, operationClass: 'EXPAND' });
  });

  it('excludes a peer migration path already present on the base branch — inherited, not a real collision (PR #2540 gotcha)', async () => {
    github({
      files: [{ filename: `${DIR}/0094_safe.sql`, status: 'added' }],
      head: { [`${DIR}/0094_safe.sql`]: SAFE },
      peers: [{ number: 40, files: [{ filename: `${DIR}/0093_inherited.sql`, status: 'added' }] }],
      base: { [`${DIR}/0093_inherited.sql`]: 'CREATE TABLE "inherited" ("id" uuid);' },
    });
    await expect(inspect('dev')).resolves.toEqual({ safe: true, operationClass: 'EXPAND' });
  });

  it.each([
    ['identical stacked file', 'dev', SAFE, true, '0094_safe.sql'],
    ['identical SQL under a different name', 'dev', SAFE, false, '0094_other.sql'],
    ['same path with different SQL', 'dev', 'CREATE TABLE "other" ("id" uuid);', false],
    ['different base', 'mission/evidence', 'CREATE TABLE "other" ("id" uuid);', true],
    ['unreadable peer content', 'dev', undefined, false],
  ])('%s', async (_label, otherBase, otherSql, safe, otherName = '0094_safe.sql') => {
    const path = `${DIR}/0094_safe.sql`;
    const peerPath = `${DIR}/${otherName}`;
    github({
      files: [{ filename: path, status: 'added' }],
      head: { [path]: SAFE },
      peers: [{
        number: 40,
        baseRef: otherBase as string,
        files: [{ filename: peerPath, status: 'added' }],
        head: otherSql === undefined ? {} : { [peerPath]: otherSql as string },
      }],
    });
    const result = await inspect('dev');
    expect(result.safe).toBe(safe as boolean);
    if (otherBase !== 'dev') {
      expect(mockGithubApi.mock.calls.some((call) => call[1].includes('/pulls/40/files'))).toBe(false);
    }
  });

  it.each([true, false])('requires matching content to exclude a same-path peer migration on the base (identical=%s)', async (identical) => {
    const path = `${DIR}/0094_safe.sql`;
    github({
      files: [{ filename: path, status: 'added' }],
      head: { [path]: SAFE },
      peers: [{ number: 40, files: [{ filename: path, status: 'added' }] }],
      base: { [path]: identical ? SAFE : `${SAFE}\n` },
    });
    expect((await inspect('dev')).safe).toBe(identical);
  });

  it('escalates deleting a generated migration', async () => {
    github({ files: [{ filename: `${DIR}/0094_safe.sql`, status: 'removed' }] });

    await expect(inspect()).resolves.toEqual({
      safe: false,
      operationClass: 'CONTRACT',
      reason: `deletes generated migration ${DIR}/0094_safe.sql`,
    });
    expect(mockGithubApi).toHaveBeenCalledTimes(1);
  });

  it('escalates modifying an existing generated migration', async () => {
    github({
      files: [{ filename: `${DIR}/0094_safe.sql`, status: 'modified' }],
      head: { [`${DIR}/0094_safe.sql`]: SAFE },
      base: { [`${DIR}/0094_safe.sql`]: 'CREATE TABLE "older" ("id" uuid);' },
    });

    await expect(inspect()).resolves.toEqual({
      safe: false,
      operationClass: 'CONTRACT',
      reason: `modifies existing migration ${DIR}/0094_safe.sql`,
    });
  });
});
