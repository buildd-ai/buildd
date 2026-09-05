import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESERVED_ROLE_SLUGS, isReservedRoleSlug } from './reserved-slugs';

const SRC = join(import.meta.dir, '..');

describe('isReservedRoleSlug', () => {
  it('rejects the static segments that sit beside /app/team/[slug]', () => {
    expect(isReservedRoleSlug('new')).toBe(true);
  });

  it('accepts an ordinary role slug', () => {
    expect(isReservedRoleSlug('builder')).toBe(false);
    expect(isReservedRoleSlug('ui-audit')).toBe(false);
  });

  it('is case-insensitive, since slugs are lowercased downstream', () => {
    expect(isReservedRoleSlug('NEW')).toBe(true);
  });
});

/**
 * The hazard: `app/app/(protected)/team/new/` is a static segment beside the
 * dynamic `team/[slug]/`. Next.js resolves static first, so a role slugged
 * "new" would render the New Role form forever instead of that role's page,
 * with no error explaining why.
 *
 * The first version of this guard was pointed at `teams.slug` — which appears
 * in no URL in this app, since teams route by id at `/app/teams/[id]`. It
 * therefore rejected valid team names while leaving the real hazard open. The
 * three checks below exist so that mistake cannot repeat silently: they pin
 * which entity the route consumes, and which endpoints enforce the guard.
 */
describe('the guard is anchored to the slug /app/team/[slug] actually resolves', () => {
  it('resolves a role (workspaceSkills), not a team', () => {
    const route = readFileSync(join(SRC, 'app/app/(protected)/team/[slug]/page.tsx'), 'utf8');
    expect(route).toContain('workspaceSkills.slug');
    // If this route ever resolves teams instead, the guard must move with it.
    expect(route).not.toContain('teams.slug');
  });

  it('is enforced on every endpoint that mints a role slug', () => {
    const creators = [
      'app/api/roles/route.ts',
      'app/api/workspaces/[id]/skills/route.ts',
    ];
    for (const rel of creators) {
      const src = readFileSync(join(SRC, rel), 'utf8');
      expect(src).toContain('isReservedRoleSlug');
    }
  });

  it('covers every static sibling of [slug]', () => {
    const teamDir = join(SRC, 'app/app/(protected)/team');
    const staticSegments = readdirSync(teamDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('[') && !e.name.startsWith('('))
      .map(e => e.name);

    expect(staticSegments.length).toBeGreaterThan(0);
    for (const segment of staticSegments) {
      expect(RESERVED_ROLE_SLUGS).toContain(segment);
    }
  });
});
