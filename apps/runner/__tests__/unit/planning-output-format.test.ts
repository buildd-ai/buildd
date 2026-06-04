/**
 * Contract test: the runner must request SDK structured output for planning
 * tasks so the orchestrator's plan comes back as validated JSON
 * (result.structured_output) rather than free-form text.
 *
 * Regression guard for the silent mission-loop stall: previously the runner only
 * passed outputFormat when a task carried an explicit outputSchema. Planning
 * tasks created by runMission() never set one, so no structured output was
 * requested, the plan was dropped as markdown text, no child tasks were created,
 * and the mission re-planned forever.
 *
 * Run: bun test apps/runner/__tests__/unit/planning-output-format.test.ts
 */
import { describe, it, expect } from 'bun:test';
import { resolveOutputFormat, planningOutputSchema } from '@buildd/shared';

describe('resolveOutputFormat — planning structured-output contract', () => {
  it('planning task with NO explicit schema still gets the planning schema', () => {
    const of = resolveOutputFormat({ mode: 'planning', outputSchema: null });
    expect(of).toBeDefined();
    expect(of!.type).toBe('json_schema');
    expect(of!.schema).toBe(planningOutputSchema as unknown as Record<string, unknown>);
  });

  it('planning schema requires plan/summary/missionComplete', () => {
    expect((planningOutputSchema as any).required).toEqual(['plan', 'summary', 'missionComplete']);
    expect((planningOutputSchema as any).properties.plan.type).toBe('array');
  });

  it('execution task with no schema gets no outputFormat', () => {
    expect(resolveOutputFormat({ mode: 'execution', outputSchema: null })).toBeUndefined();
    expect(resolveOutputFormat({ mode: undefined, outputSchema: undefined })).toBeUndefined();
  });

  it('an explicit task outputSchema always wins (even for planning)', () => {
    const custom = { type: 'object', properties: { foo: { type: 'string' } } };
    const exec = resolveOutputFormat({ mode: 'execution', outputSchema: custom });
    expect(exec!.schema).toBe(custom);

    const planning = resolveOutputFormat({ mode: 'planning', outputSchema: custom });
    expect(planning!.schema).toBe(custom);
  });
});
