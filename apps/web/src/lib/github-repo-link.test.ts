process.env.NODE_ENV = 'test';

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

// ── Captured DB traffic ───────────────────────────────────────────────────────
let insertedRows: any[] | null = null;
let conflictTarget: any = null;
let executed: any[] = [];
let executeRows: Array<{ id: string }> = [];
let installationRow: any = null;
let listedFor: number[] = [];
let ghRepos: Array<Record<string, unknown>> = [];

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      githubInstallations: { findFirst: () => Promise.resolve(installationRow) },
    },
    insert: () => ({
      values: (rows: any[]) => ({
        onConflictDoUpdate: (opts: any) => {
          insertedRows = rows;
          conflictTarget = opts.target;
          return Promise.resolve();
        },
      }),
    }),
    execute: (query: any) => {
      executed.push(query);
      return Promise.resolve({ rows: executeRows });
    },
  },
}));

mock.module('@/lib/github', () => ({
  listInstallationRepos: (installationId: number) => {
    listedFor.push(installationId);
    return Promise.resolve(ghRepos);
  },
}));

const { syncInstallationRepos, syncInstallationReposById } = await import('./github-repo-link');

const dialect = new PgDialect();
const renderLastExecuted = () => dialect.sqlToQuery(executed[executed.length - 1]);

function makeGhRepo(overrides: Record<string, unknown> = {}) {
  return {
    id: 1146343038,
    full_name: 'maxjacu/moa-ops',
    name: 'moa-ops',
    owner: { login: 'maxjacu' },
    private: true,
    default_branch: 'dev',
    html_url: 'https://github.com/maxjacu/moa-ops',
    description: 'ops monorepo',
    ...overrides,
  };
}

beforeEach(() => {
  insertedRows = null;
  conflictTarget = null;
  executed = [];
  executeRows = [];
  installationRow = null;
  listedFor = [];
  ghRepos = [];
});

describe('syncInstallationRepos', () => {
  it('upserts every repo on the installation and returns back-linked workspace ids', async () => {
    ghRepos = [makeGhRepo(), makeGhRepo({ id: 2, full_name: 'maxjacu/wix-moa-market', name: 'wix-moa-market' })];
    executeRows = [{ id: 'ws-moa-ops' }];

    const result = await syncInstallationRepos({ id: 'inst-row-1', installationId: 155534927 });

    expect(listedFor).toEqual([155534927]);
    expect(insertedRows).toHaveLength(2);
    expect(insertedRows![0]).toMatchObject({
      installationId: 'inst-row-1',
      repoId: 1146343038,
      fullName: 'maxjacu/moa-ops',
      owner: 'maxjacu',
      defaultBranch: 'dev',
    });
    expect(conflictTarget).toBeDefined();
    expect(result).toEqual({ synced: 2, linked: 1, linkedWorkspaceIds: ['ws-moa-ops'] });
  });

  it('back-links on a normalized owner/name match, not a substring match', async () => {
    // Regression: the old predicate was `ilike(workspaces.repo, '%owner/name%')`,
    // which also matches `owner/name-legacy`.
    ghRepos = [makeGhRepo()];
    await syncInstallationRepos({ id: 'inst-row-1', installationId: 155534927 });

    const { sql: text, params } = renderLastExecuted();
    expect(text).toContain('UPDATE workspaces');
    expect(text).toContain('regexp_replace');
    expect(text).toContain('= lower(r.full_name)');
    expect(text).toContain('w.github_repo_id IS NULL');
    expect(text.toLowerCase()).not.toContain('like');
    expect(params).toContain('inst-row-1');
  });

  it('scopes the back-link to the given installation', async () => {
    ghRepos = [makeGhRepo()];
    await syncInstallationRepos({ id: 'inst-row-1', installationId: 155534927 });

    const { sql: text } = renderLastExecuted();
    expect(text).toContain('r.installation_id =');
  });

  it('falls back to full_name for owner/name when the payload omits them', async () => {
    ghRepos = [{ id: 7, full_name: 'someorg/somerepo' }];
    await syncInstallationRepos({ id: 'inst-row-1', installationId: 1 });

    expect(insertedRows![0]).toMatchObject({
      name: 'somerepo',
      owner: 'someorg',
      private: false,
      defaultBranch: 'main',
      htmlUrl: null,
      description: null,
    });
  });

  it('writes nothing when the installation has no repos', async () => {
    ghRepos = [];
    const result = await syncInstallationRepos({ id: 'inst-row-1', installationId: 1 });

    expect(insertedRows).toBeNull();
    expect(executed).toHaveLength(0);
    expect(result).toEqual({ synced: 0, linked: 0, linkedWorkspaceIds: [] });
  });
});

describe('syncInstallationReposById', () => {
  it('resolves the installation row from the numeric id webhooks carry', async () => {
    installationRow = { id: 'inst-row-1', installationId: 155534927 };
    ghRepos = [makeGhRepo()];
    executeRows = [{ id: 'ws-moa-ops' }];

    const result = await syncInstallationReposById(155534927);

    expect(listedFor).toEqual([155534927]);
    expect(result.linkedWorkspaceIds).toEqual(['ws-moa-ops']);
  });

  it('no-ops when the installation row does not exist yet', async () => {
    installationRow = null;

    const result = await syncInstallationReposById(999);

    expect(listedFor).toEqual([]);
    expect(result).toEqual({ synced: 0, linked: 0, linkedWorkspaceIds: [] });
  });
});
