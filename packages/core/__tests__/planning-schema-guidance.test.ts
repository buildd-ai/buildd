import { describe, it, expect } from 'bun:test';
import { planningOutputSchema } from '@buildd/shared';
import type { PlanStep, PlanningStructuredOutput } from '@buildd/shared';

/**
 * The planning contract is wired end to end — the runner requests structured
 * output, `PlanStep.dependsOn` carries refs, `approve-plan` resolves those refs
 * to real task IDs in a second pass, and the claim route refuses to hand out a
 * task whose `dependsOn` is unsatisfied.
 *
 * The one thing missing was telling the planning agent any of that. The schema
 * was pure structure with no `description` on a single field, so nothing
 * conveyed *when* an edge is required. Plans came back with sibling steps and no
 * edges, consumer tasks became claimable immediately, and agents burned real
 * attempts reporting the obvious: "PR not yet open — retry once builder ships",
 * "builder task <id> has not yet produced a PR", "DESIGN task not yet complete".
 * Each of those is recorded as a code_failure and consumes one of three retries.
 *
 * These assertions keep the guidance attached to the schema the agent actually
 * receives, rather than in a prompt that can drift away from it.
 */
describe('planningOutputSchema — agent-facing guidance', () => {
  const stepProps = (planningOutputSchema as any).properties.plan.items.properties;

  it('tells the agent what dependsOn means and when to use it', () => {
    const desc: string | undefined = stepProps.dependsOn.description;
    expect(typeof desc).toBe('string');
    // Must name the referent (refs of other steps), or the agent has to guess
    // whether these are task IDs.
    expect(desc!.toLowerCase()).toContain('ref');
  });

  it('warns that an undeclared dependency means the step runs immediately', () => {
    // This is the consequence the agent needs in order to care. Without it the
    // field reads as optional metadata.
    const desc: string = stepProps.dependsOn.description;
    expect(desc.toLowerCase()).toMatch(/immediately|same time|parallel|concurrent/);
  });

  it('describes ref, since dependsOn is meaningless without it', () => {
    expect(typeof stepProps.ref.description).toBe('string');
    expect(stepProps.ref.description.length).toBeGreaterThan(0);
  });

  it('keeps dependsOn an array of strings', () => {
    // Guard the shape the two-pass ref resolution in approve-plan relies on.
    expect(stepProps.dependsOn.type).toBe('array');
    expect(stepProps.dependsOn.items.type).toBe('string');
  });
});

/**
 * PlanStep.pathManifest and PlanningStructuredOutput.goalCriteria restore
 * fields an approved plan's child tasks currently skip: pathManifest is the
 * conflict-serialization metadata create_task normally attaches, and
 * goalCriteria lets the planning agent propose the mission-level completion
 * gates validateGoalCriteria (packages/core/mission-helpers.ts) checks. Both
 * are optional — a plan step without pathManifest and a structured output
 * without goalCriteria must stay valid, so existing plans keep working
 * unchanged.
 */
describe('planningOutputSchema — pathManifest and goalCriteria', () => {
  const stepProps = (planningOutputSchema as any).properties.plan.items.properties;
  const topProps = (planningOutputSchema as any).properties;

  it('declares pathManifest on a plan step as an array of strings', () => {
    expect(stepProps.pathManifest.type).toBe('array');
    expect(stepProps.pathManifest.items.type).toBe('string');
  });

  it('does not require pathManifest on a plan step', () => {
    expect((planningOutputSchema as any).properties.plan.items.required).not.toContain('pathManifest');
  });

  it('declares goalCriteria at the mission level, not per-step', () => {
    expect(topProps.goalCriteria).toBeDefined();
    expect(stepProps.goalCriteria).toBeUndefined();
    expect(topProps.goalCriteria.type).toBe('array');
    expect(topProps.goalCriteria.items.type).toBe('object');
  });

  it('does not require goalCriteria on the structured output', () => {
    expect((planningOutputSchema as any).required).not.toContain('goalCriteria');
  });

  it('requires type on each goalCriteria item, reusing the GoalCriterion vocabulary', () => {
    expect(topProps.goalCriteria.items.required).toEqual(['type']);
    expect(topProps.goalCriteria.items.properties.type.enum).toEqual([
      'all_prs_merged',
      'command',
      'no_open_tasks',
      'artifact_exists',
      'metric',
      'description',
    ]);
  });

  it('accepts a plan step without pathManifest and an output without goalCriteria', () => {
    // Type-level round-trip: this must compile unchanged for existing plans.
    const step: PlanStep = { ref: 'a', title: 'A', description: 'do a' };
    const output: PlanningStructuredOutput = { plan: [step], summary: 's', missionComplete: false };
    expect(output.plan[0]?.pathManifest).toBeUndefined();
    expect(output.goalCriteria).toBeUndefined();
  });

  it('accepts a plan step with pathManifest and an output with goalCriteria', () => {
    const step: PlanStep = {
      ref: 'a',
      title: 'A',
      description: 'do a',
      pathManifest: ['apps/web/src/lib/foo.ts'],
    };
    const output: PlanningStructuredOutput = {
      plan: [step],
      summary: 's',
      missionComplete: false,
      goalCriteria: [{ type: 'command', command: 'bun run test' }],
    };
    expect(output.plan[0]?.pathManifest).toEqual(['apps/web/src/lib/foo.ts']);
    expect(output.goalCriteria?.[0]?.type).toBe('command');
  });
});
