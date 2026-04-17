import { describe, it, expect } from 'bun:test';
import { DEFAULT_ROLES } from './default-roles';

describe('DEFAULT_ROLES', () => {
  const bySlug = Object.fromEntries(DEFAULT_ROLES.map(r => [r.slug, r]));

  it('seeds the full five-role set', () => {
    expect(Object.keys(bySlug).sort()).toEqual([
      'analyst', 'builder', 'organizer', 'researcher', 'writer',
    ]);
  });

  it('Organizer defaults to Opus (coordination tier)', () => {
    expect(bySlug.organizer.model).toBe('opus');
  });

  it('Builder defaults to Opus (router downshifts via complexity)', () => {
    expect(bySlug.builder.model).toBe('opus');
  });

  it('Researcher / Writer / Analyst default to Sonnet', () => {
    expect(bySlug.researcher.model).toBe('sonnet');
    expect(bySlug.writer.model).toBe('sonnet');
    expect(bySlug.analyst.model).toBe('sonnet');
  });

  it('no role defaults to `inherit` — model must be explicit for routing', () => {
    for (const role of DEFAULT_ROLES) {
      expect(role.model).not.toBe('inherit');
    }
  });

  it('Organizer can delegate to all execution roles', () => {
    const delegates = bySlug.organizer.canDelegateTo;
    for (const slug of ['builder', 'researcher', 'writer', 'analyst']) {
      expect(delegates).toContain(slug);
    }
  });

  it('every role has unique slug, name, description, and prompt content', () => {
    const slugs = new Set(DEFAULT_ROLES.map(r => r.slug));
    expect(slugs.size).toBe(DEFAULT_ROLES.length);
    for (const role of DEFAULT_ROLES) {
      expect(role.name.length).toBeGreaterThan(0);
      expect(role.description.length).toBeGreaterThan(0);
      expect(role.content.length).toBeGreaterThan(20);
    }
  });
});
