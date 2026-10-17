/**
 * Every repo-to-installation lookup is team-scoped: a PR is read or acted on only through
 * its own workspace's team's GitHub App installation. Callers go through
 * `createTeamInstallationResolver` or `teamInstallationIdForRepo`
 * (lib/workspace-installation.ts), never the bare `installationIdForRepo`, never a
 * hand-rolled `github_repos` → `github_installations` join by repo name, and never an
 * installation picked by account login without an ownership check (`teamInstallationIdForOwner`).
 *
 * A new hit fails until it uses the scoped lookup or is listed below with the reason it
 * already checks team ownership itself.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const REPO = join(import.meta.dir, '..', '..', '..', '..');
const ROOTS = ['apps/web/src', 'packages/core'];

const PATTERNS = [
  /\binstallationIdForRepo\s*\(/,
  // An installation picked by account login, in any form: eq(), a sql`lower(...)` template, raw SQL.
  /githubInstallations\.accountLogin\b/,
  /\baccount_login\b/,
  /\.innerJoin\(\s*githubInstallations\s*,\s*eq\(\s*githubRepos\.installationId/,
];

/** File → why its hits are already team-scoped (and what pins it). */
const ALLOWED: Record<string, string> = {
  'apps/web/src/lib/workspace-installation.ts': 'defines installationIdForRepo; teamInstallationIdForRepo wraps it with installationBelongsToTeam (tests/db/team-installation-ownership.test.ts)',
  'apps/web/src/lib/workflow/command-installation.ts': 'expectedInstallation checks the answer with ownedByTeam and refuses installation_not_team_owned (tests/db/command-installation-scope.test.ts)',
  'apps/web/src/lib/mission-invariant-scan.ts': 'the join reads each workspace\'s own linked repo by github_repos.id (its own link, the team\'s by the ownership rule); any other repo goes through teamInstallationIdForOwner',
  'packages/core/db/schema.ts': 'defines the column and its index',
  'apps/web/src/app/api/workspaces/[id]/create-repo/route.ts': 'checks installationBelongsToTeam on each installation on the org before using it (create-repo/route.test.ts)',
  'apps/web/src/lib/github-repo-access-store.ts': 'checks teamOwns on each installation on the owner before offering it',
  'apps/web/src/lib/knowledge-full-ingest-fallback.ts': 'its local installationIdForRepo(repo, workspaceId) goes through createTeamInstallationResolver().forWorkspace',
};

function sourceFiles(): string[] {
  const files: string[] = [];
  for (const root of ROOTS) {
    const glob = new Bun.Glob('**/*.{ts,tsx}');
    for (const f of glob.scanSync({ cwd: join(REPO, root) })) {
      const rel = `${root}/${f}`;
      if (/\.test\.tsx?$/.test(rel) || rel.includes('/node_modules/') || rel.includes('/drizzle/') || rel.includes('/testing/')) continue;
      files.push(rel);
    }
  }
  return files;
}

describe('repo-to-installation lookups are team-scoped everywhere', () => {
  it('scans a non-trivial set of files (a guard over nothing proves nothing)', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain('apps/web/src/lib/workspace-installation.ts');
  });

  it('has no unscoped lookup outside the pinned sites', () => {
    const offenders: string[] = [];
    for (const rel of sourceFiles()) {
      if (rel in ALLOWED) continue;
      readFileSync(join(REPO, rel), 'utf8').split('\n').forEach((line, i) => {
        if (PATTERNS.some(p => p.test(line))) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('every allowlisted file still exists and still has a hit (no stale entries)', () => {
    for (const rel of Object.keys(ALLOWED)) {
      const text = readFileSync(join(REPO, rel), 'utf8');
      expect({ rel, hit: PATTERNS.some(p => p.test(text)) }).toEqual({ rel, hit: true });
    }
  });
});
