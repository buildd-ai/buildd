import { describe, it, expect } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// docs/specs/team-permissions.md → "No per-team grants", AC-G2: which roles
// hold a permission is fixed in code, so the Members page has no grant table
// and no route serves or writes per-team grants.
const WEB_SRC = join(import.meta.dir, '../../../../..');

describe('no per-team grants (AC-G2)', () => {
  it('the Members page renders no permission grant table', () => {
    const page = readFileSync(join(import.meta.dir, 'page.tsx'), 'utf8');
    expect(page).not.toContain('PermissionsSection');
    expect(existsSync(join(import.meta.dir, 'TeamPermissionsSection.tsx'))).toBe(false);
  });

  it('no team route serves or writes per-team grants', () => {
    expect(existsSync(join(WEB_SRC, 'app/api/teams/[id]/permissions/route.ts'))).toBe(false);
  });
});
