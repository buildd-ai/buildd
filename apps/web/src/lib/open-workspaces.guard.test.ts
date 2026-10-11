/**
 * "Open" means open within the owning team. Every read that treats
 * `accessMode: 'open'` as a grant goes through lib/open-workspaces.ts (or the
 * pure rule in lib/workspace-reach.ts), so the team predicate cannot be
 * dropped at one site while kept at another.
 *
 * This scans the source for the grant-shaped patterns. A new hit fails until
 * it either uses the helper or is listed below with the reason it is already
 * team-scoped and the test that pins that.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join, relative } from 'path';

const REPO = join(import.meta.dir, '..', '..', '..', '..');
const ROOTS = ['apps/web/src', 'packages/core'];

const PATTERNS = [
  /accessMode\s*(===|!==)\s*['"]open['"]/,
  /eq\(\s*workspaces\.accessMode\s*,\s*['"]open['"]\s*\)/,
  /access_mode"?\s*=\s*'open'/,
];

/** File → why its hits are already team-scoped (and what pins it). */
const ALLOWED: Record<string, string> = {
  'apps/web/src/lib/open-workspaces.ts': 'the helper itself',
  'apps/web/src/lib/workspace-reach.ts': 'the pure rule; compares workspace.teamId to account.teamId',
  'apps/web/src/lib/team-access.ts': 'verifyAccountWorkspaceAccess decides through accountReachesWorkspace',
  'apps/web/src/lib/workspace-access.ts': 'query ANDs eq(teamId, account.teamId); pinned in workspace-access.test.ts',
  'apps/web/src/app/api/workers/claim/route.ts': 'both queries AND the account team; pinned in claim/route.test.ts',
  'apps/web/src/lib/subscriptions.ts': 'raw SQL joins the owner to w."team_id" before the open arm',
  'apps/web/src/app/app/(protected)/settings/workspaces/new/page.tsx': 'form radio state',
};

function sourceFiles(): string[] {
  const files: string[] = [];
  for (const root of ROOTS) {
    const glob = new Bun.Glob('**/*.{ts,tsx}');
    for (const f of glob.scanSync({ cwd: join(REPO, root) })) {
      const rel = `${root}/${f}`;
      if (/\.test\.tsx?$/.test(rel) || rel.includes('/node_modules/') || rel.includes('/drizzle/')) continue;
      files.push(rel);
    }
  }
  return files;
}

describe('open workspaces are team-scoped everywhere', () => {
  it('scans a non-trivial set of files (a guard over nothing proves nothing)', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain('apps/web/src/lib/open-workspaces.ts');
  });

  it('has no grant-shaped use of open mode outside the helper and the pinned sites', () => {
    const offenders: string[] = [];
    for (const rel of sourceFiles()) {
      if (rel in ALLOWED) continue;
      const lines = readFileSync(join(REPO, rel), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (PATTERNS.some(p => p.test(line))) offenders.push(`${relative('.', rel)}:${i + 1}: ${line.trim()}`);
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
