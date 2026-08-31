import { describe, it, expect } from 'bun:test';
import { DEFAULT_ROLES } from './default-roles';

describe('DEFAULT_ROLES', () => {
  const bySlug = Object.fromEntries(DEFAULT_ROLES.map(r => [r.slug, r]));

  it('seeds the full seven-role set', () => {
    expect(Object.keys(bySlug).sort()).toEqual([
      'analyst', 'builder', 'organizer', 'researcher', 'reviewer', 'spec-validator', 'writer',
    ]);
  });

  // Visual QA is a CI workflow only (visual-qa.yml) — NOT a routable agent role.
  // If this fails, remove the 'visual-qa' entry from DEFAULT_ROLES.
  it('does NOT seed a visual-qa role (CI-only workflow, not an agent role)', () => {
    expect(bySlug['visual-qa']).toBeUndefined();
  });

  it('Organizer defaults to Sonnet (router upshifts to Opus for complex coordination)', () => {
    expect(bySlug.organizer.model).toBe('sonnet');
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

  it('Builder prompt uses recall (not buildd_memory query_knowledge) for pull gates', () => {
    const c = bySlug.builder.content;
    // Migrated from buildd_memory query_knowledge → recall
    expect(c).toContain('recall');
    // Must gate on both memory (error diagnosis) and code (before editing)
    expect(c).toContain('scope=code');
  });

  it('Organizer prompt uses recall for spec and memory pull gates', () => {
    const c = bySlug.organizer.content;
    // Migrated from buildd_memory query_knowledge → recall
    expect(c).toContain('recall');
    expect(c).toContain('scope=spec');
  });

  it('every role prompt includes a recall-based save-dedup gate', () => {
    for (const role of DEFAULT_ROLES) {
      // Every role must gate memory saves with a prior recall dedup check
      expect(role.content).toContain('recall');
    }
  });
  // The Organizer prompt used to order the agent to "Always set `kind` and
  // `complexity` — they drive how much Claude-horsepower the task gets". Neither
  // half was true: plan approval (approve-plan.ts) does not copy those fields
  // onto the task row, so they change nothing about routing on that path.
  it('Organizer prompt does not claim plan-level kind/complexity drive model choice', () => {
    const c = bySlug.organizer.content;
    expect(c).not.toContain('Always set `kind` and `complexity`');
    expect(c).not.toContain('how much Claude-horsepower the task gets');
  });

  it('Organizer prompt names roleSlug as the real routing lever and documents tier', () => {
    const c = bySlug.organizer.content;
    // roleSlug is what actually selects a model for a planned task.
    expect(c).toMatch(/`roleSlug`[^\n]*model/);
    // tier is the working override on the direct-creation surface.
    expect(c).toContain('`tier`');
    expect(c).toContain('premium');
    expect(c).toContain('budget');
  });
});
