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

  // The seeded prompt is what every organizer plans against, so a stale branch
  // model here means organizers keep planning for a shape the machinery does not
  // implement. Two shapes exist: per-task PRs into trunk (the default), and
  // per-task PRs based on the mission integration branch when the mission opts in.
  // "ONE task = ONE branch = ONE PR" is true in both — what changes is the base.
  describe('Organizer sequencing rules', () => {
    const c = () => bySlug.organizer.content;

    it('keeps ONE task = ONE branch = ONE PR and says the base is what varies', () => {
      expect(c()).toContain('ONE task = ONE branch = ONE PR');
      // NOT /base/ — the word appears in the `baseBranch` field list above this
      // section, so that assertion stayed green with the whole section deleted.
      // Match a phrase only the rewritten section contains.
      expect(c()).toMatch(/the platform picks the base, not you/);
      // The clause must not read as a prohibition on the integration branch.
      expect(c()).not.toContain('Never fan out parallel tasks that touch the same files.');
    });

    it('names the mission integration branch and the single mission PR', () => {
      expect(c()).toContain('mission/<slug>-<id8>');
      expect(c()).toContain('integration branch');
      // One PR from the integration branch into trunk — not one PR standing in
      // for the mission's task PRs.
      expect(c()).toMatch(/\*{0,2}one\*{0,2} PR from the integration branch/i);
    });

    it('states that the integration branch is opt-in and off by default', () => {
      expect(c()).toMatch(/opt-in/i);
      expect(c()).toMatch(/off by default|unless the mission has explicitly opted in/i);
    });

    it('makes path overlap the reason to chain, in both shapes', () => {
      expect(c()).toContain('Serialize on path overlap');
      expect(c()).toContain('in both shapes');
      // Blanket "same repo => chain" survives only as the non-opted-in rule.
      expect(c()).toMatch(/Without an integration branch, tasks on the \*\*same repo\*\* MUST be chained/);
    });

    it('keeps DONE = MERGED and scopes "merged" to the integration branch when there is one', () => {
      expect(c()).toContain('DONE = MERGED');
      expect(c()).toContain('cannot be claimed until the upstream PR is actually merged');
      expect(c()).toMatch(/merged into the integration branch/);
    });

    it('does not claim mission tasks share a branch or a single PR', () => {
      // The false Option-A assertion the mission-delivery audit found in five
      // artifacts. Tasks never shared a branch, and under the integration-branch
      // shape that branch is their shared *base*, not their shared head.
      expect(c()).not.toMatch(/share (one|a single|the same) branch/i);
      expect(c()).not.toMatch(/push (commits )?to (one|the same|a shared) branch/i);
    });

    it('does not promise parallelism the platform will not deliver', () => {
      // A plan step cannot declare its file scope (`PlanStep` has no
      // `pathManifest` and approve-plan sets none), so claim time serializes
      // same-mission siblings whatever the plan says. The prompt used to tell
      // the organizer that disjoint-path steps run in parallel, which made it
      // drop `dependsOn` and buy nothing but lost ordering.
      expect(c()).not.toMatch(/run in parallel in the same repo/);
      expect(c()).toMatch(/shorter wait per link/);
    });

    it('keeps the example plan valid JSON and consistent with the rules', () => {
      const block = c().match(/Example plan for a code mission[^\n]*\n```json\n([\s\S]*?)```/);
      expect(block).not.toBeNull();
      const plan = JSON.parse(block![1]) as Array<Record<string, unknown>>;
      expect(plan).toHaveLength(2);
      expect(plan[0].dependsOn).toBeUndefined();
      // Same-repo chain: the default (trunk-based) shape's rule.
      expect(plan[1].dependsOn).toEqual(['step-1']);
      expect(plan[1].baseBranch).toBe('step-1');
      for (const step of plan) {
        expect(typeof step.ref).toBe('string');
        expect(step.outputRequirement).toBe('pr_required');
      }
    });
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
