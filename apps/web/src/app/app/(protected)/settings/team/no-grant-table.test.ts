import { describe, it, expect } from 'bun:test';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

// docs/specs/team-permissions.md → "No per-team grants" (AC-G1, AC-G2): which
// roles hold a permission is fixed in code, so nothing reads or writes a
// per-team grant, no route serves one, and the Members page has no table.
const WEB_SRC = join(import.meta.dir, '../../../../..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

describe('no per-team grants', () => {
  it('no source file reads or writes a per-team grant', () => {
    const hits = sourceFiles(WEB_SRC)
      .filter((f) => /permissionOverrides|permission_overrides|PermissionOverrides|PERMISSION_GROUPS/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(WEB_SRC, f));
    expect(hits).toEqual([]);
  });

  it('the Members page renders no permission grant table', () => {
    const page = readFileSync(join(import.meta.dir, 'page.tsx'), 'utf8');
    expect(page).not.toMatch(/PermissionsSection|\bPERMISSIONS\b|defaultRoles/);
    expect(existsSync(join(import.meta.dir, 'TeamPermissionsSection.tsx'))).toBe(false);
  });

  it('no team route serves or writes per-team grants', () => {
    expect(existsSync(join(WEB_SRC, 'app/api/teams/[id]/permissions/route.ts'))).toBe(false);
  });
});
