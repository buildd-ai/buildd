process.env.NODE_ENV = 'test';

import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ── Captured DB traffic ───────────────────────────────────────────────────────
let insertedRows: any[] | null = null;
let conflictSet: Record<string, unknown> | null = null;
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
          conflictSet = opts.set;
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

// Spread the real module rather than returning a bare `{ listInstallationRepos }`.
// `mock.module` replaces the module GLOBALLY for the whole test process and is
// never undone by `mock.restore()`, so a partial stub deletes every other export
// for any file that loads later in the same run. That is order-dependent and
// therefore invisible locally: CI batches this file with pr-state-refresh /
// pr-state-reconcile (both `import { githubApi } from '@/lib/github'`) and they
// died at import with "Export named 'githubApi' not found".
// `@buildd/core/db` is already mocked above, so importing the real module here
// touches nothing but env reads.
const actualGithub = await import('@/lib/github');

mock.module('@/lib/github', () => ({
  ...actualGithub,
  listInstallationRepos: (installationId: number) => {
    listedFor.push(installationId);
    return Promise.resolve(ghRepos);
  },
}));

const { syncInstallationRepos, syncInstallationReposById } = await import('./github-repo-link');

// The back-link statement is asserted against the module source rather than a
// rendered SQL object: sibling lib tests stub `drizzle-orm` with a dozen
// incompatible `sql` shapes, and whichever loads last wins for the whole run,
// so anything built on the real tagged-template internals is load-order
// dependent. The source text is not.
const source = await Bun.file(new URL('./github-repo-link.ts', import.meta.url)).text();
const backLinkStatement = source.slice(
  source.indexOf('UPDATE workspaces w'),
  source.indexOf('RETURNING w.id')
);
const repoNormalizer = source.slice(
  source.indexOf('const NORMALIZED_WORKSPACE_REPO'),
  source.indexOf('/**', source.indexOf('const NORMALIZED_WORKSPACE_REPO'))
);

function makeGhRepo(overrides: Record<string, unknown> = {}) {
  return {
    id: 1146343038,
    full_name: 'maxjacu/sibling-app',
    name: 'sibling-app',
    owner: { login: 'maxjacu' },
    private: true,
    default_branch: 'dev',
    html_url: 'https://github.com/maxjacu/sibling-app',
    description: 'ops monorepo',
    ...overrides,
  };
}

beforeEach(() => {
  insertedRows = null;
  conflictSet = null;
  executed = [];
  executeRows = [];
  installationRow = null;
  listedFor = [];
  ghRepos = [];
});

describe('syncInstallationRepos', () => {
  it('upserts every repo on the installation and returns back-linked workspace ids', async () => {
    ghRepos = [makeGhRepo(), makeGhRepo({ id: 2, full_name: 'maxjacu/wix-moa-market', name: 'wix-moa-market' })];
    executeRows = [{ id: 'ws-sibling-app' }];

    const result = await syncInstallationRepos({ id: 'inst-row-1', installationId: 155534927 });

    expect(listedFor).toEqual([155534927]);
    expect(insertedRows).toHaveLength(2);
    expect(insertedRows![0]).toMatchObject({
      installationId: 'inst-row-1',
      repoId: 1146343038,
      fullName: 'maxjacu/sibling-app',
      owner: 'maxjacu',
      defaultBranch: 'dev',
    });
    // Re-running a sync must refresh metadata rather than error on repo_id.
    expect(Object.keys(conflictSet!)).toEqual(
      expect.arrayContaining(['installationId', 'fullName', 'defaultBranch', 'updatedAt'])
    );
    expect(result).toEqual({ synced: 2, linked: 1, linkedWorkspaceIds: ['ws-sibling-app'] });
  });

  it('issues exactly one back-link statement per sync', async () => {
    ghRepos = [makeGhRepo(), makeGhRepo({ id: 2, full_name: 'maxjacu/recut', name: 'recut' })];
    await syncInstallationRepos({ id: 'inst-row-1', installationId: 155534927 });

    // One multi-row upsert + one UPDATE ... FROM, regardless of repo count.
    expect(executed).toHaveLength(1);
  });

  it('back-links on a normalized owner/name match, not a substring match', () => {
    // Regression: the old predicate was `ilike(workspaces.repo, '%owner/name%')`,
    // which also matches `owner/name-legacy`.
    expect(backLinkStatement).toContain('${NORMALIZED_WORKSPACE_REPO} = lower(r.full_name)');
    expect(backLinkStatement).not.toMatch(/like/i);
  });

  it('normalizes workspaces.repo using the shared repo-scope regexes', () => {
    // The regexes live in @/lib/repo-scope so the webhook's workspace lookups
    // and this back-link share one definition. See repo-scope.test.ts for the
    // behavioural assertions on the patterns themselves.
    expect(repoNormalizer).toContain('regexp_replace');
    expect(repoNormalizer).toContain("coalesce(w.repo, '')");
    expect(repoNormalizer).toContain('GITHUB_HOST_PREFIX_RE');
    expect(repoNormalizer).toContain('GIT_SUFFIX_RE');
    expect(repoNormalizer).not.toMatch(/like/i);
  });

  it('re-links workspaces that already have a repo, so a reinstall refreshes them', () => {
    // Regression (2026-08-22 freeze): the old predicate was
    // `AND w.github_repo_id IS NULL`, so an App reinstall never refreshed
    // github_installation_id on an already-linked workspace. The workspace kept
    // pointing at the dead installation, whose token 404s on every repo call —
    // freezing all PR lifecycle state and deadlocking the claim queue.
    expect(backLinkStatement).not.toContain('w.github_repo_id IS NULL');
  });

  it('writes only when the workspace pointers actually differ', () => {
    // Keeps the UPDATE idempotent and keeps RETURNING (→ linkedWorkspaceIds)
    // meaning "changed", not "matched", so a no-op webhook reports linked: 0.
    expect(backLinkStatement).toContain('w.github_repo_id IS DISTINCT FROM r.id');
    expect(backLinkStatement).toContain(
      'w.github_installation_id IS DISTINCT FROM r.installation_id',
    );
  });

  it('scopes the back-link to the given installation', () => {
    expect(backLinkStatement).toContain('r.installation_id =');
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
    executeRows = [{ id: 'ws-sibling-app' }];

    const result = await syncInstallationReposById(155534927);

    expect(listedFor).toEqual([155534927]);
    expect(result.linkedWorkspaceIds).toEqual(['ws-sibling-app']);
  });

  it('no-ops when the installation row does not exist yet', async () => {
    installationRow = null;

    const result = await syncInstallationReposById(999);

    expect(listedFor).toEqual([]);
    expect(result).toEqual({ synced: 0, linked: 0, linkedWorkspaceIds: [] });
  });
});
