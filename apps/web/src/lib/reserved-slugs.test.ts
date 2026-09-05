import { describe, it, expect } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { RESERVED_TEAM_SLUGS, isReservedTeamSlug } from './reserved-slugs';

describe('isReservedTeamSlug', () => {
  it('rejects the static segments that sit beside /app/team/[slug]', () => {
    expect(isReservedTeamSlug('new')).toBe(true);
  });

  it('accepts an ordinary slug', () => {
    expect(isReservedTeamSlug('acme')).toBe(false);
    expect(isReservedTeamSlug('platform-eng')).toBe(false);
  });

  it('is case-insensitive, since slugs are lowercased downstream', () => {
    expect(isReservedTeamSlug('NEW')).toBe(true);
  });
});

/**
 * The hazard this guards: `app/app/(protected)/team/new/` is a static segment
 * sitting beside the dynamic `team/[slug]/`. Next.js resolves static first, so
 * a team slugged "new" would render the New Role form forever instead of its
 * own page. Deriving the expectation from the directory listing means adding
 * another static sibling fails here rather than silently stranding a team.
 */
describe('RESERVED_TEAM_SLUGS covers every static sibling of [slug]', () => {
  it('has an entry for each static directory under team/', () => {
    const teamDir = join(import.meta.dir, '../app/app/(protected)/team');
    const staticSegments = readdirSync(teamDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('[') && !e.name.startsWith('('))
      .map(e => e.name);

    expect(staticSegments.length).toBeGreaterThan(0);
    for (const segment of staticSegments) {
      expect(RESERVED_TEAM_SLUGS).toContain(segment);
    }
  });
});
