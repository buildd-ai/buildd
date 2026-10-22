/**
 * Living Specs D-44 / D-45 over MCP: no description an agent reads offers
 * hand-written goal criteria or a mission-scope spec; each points at selecting
 * a spec instead. Readers of legacy criteria (get_criteria_state, evaluate)
 * stay.
 *
 * Run: bun run scripts/run-unit-tests.ts packages/core/__tests__/mcp-goal-criteria-retired.test.ts
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { actionHelp, actionSignature, MCP_GROUP_PARAMS } from '../mcp-tool-groups';

const root = join(import.meta.dir, '..', '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('manage_missions', () => {
  const help = actionHelp('manage_missions')!;

  it('says hand-written goalCriteria are retired and points at outcomeSpec', () => {
    expect(help).toContain('retired');
    expect(help).toContain('outcomeSpec');
  });

  it('no longer teaches how to write them', () => {
    expect(help).not.toContain('PREFER A MECHANICAL FORM');
    expect(help).not.toContain('notMechanizableReason');
    expect(help).not.toContain('Type-specific required fields');
  });

  it('still documents the readers for missions that carry them', () => {
    expect(help).toContain('get_criteria_state');
    expect(help).toContain('evaluate');
  });

  it('lists outcomeSpec, not goalCriteria, in the short signature and the group params', () => {
    const sig = actionSignature('manage_missions');
    expect(sig).toContain('outcomeSpec?');
    expect(sig).not.toContain('goalCriteria');
    const names = MCP_GROUP_PARAMS.missions.map(p => p.name);
    expect(names).toContain('outcomeSpec');
    expect(names).not.toContain('goalCriteria');
  });
});

describe('manage_initiatives', () => {
  it('points checkable outcomes at the spec a mission delivers, not at goalCriteria', () => {
    const help = actionHelp('manage_initiatives')!;
    expect(help).not.toContain('mission goalCriteria');
    expect(help).toContain('outcomeSpec');
  });
});

describe('manage_specs', () => {
  it('does not offer the mission scope on create_draft', () => {
    const help = actionHelp('manage_specs')!;
    expect(help).not.toContain('product|domain|feature|mission');
    expect(help).toContain('mission is retired');
  });
});

describe('guidance an agent loads', () => {
  it('the living-specs topic no longer lists mission as a scope to draft', () => {
    const md = read('packages/core/mcp-guidance/living-specs.md');
    expect(md).not.toMatch(/`feature` \(default\) or `mission`/);
    expect(md).toContain('`mission` is retired');
  });

  it('the consumer skill says goalCriteria are retired and a mission selects a spec', () => {
    const md = read('.claude/skills/buildd-mcp-consumer/SKILL.md');
    expect(md).toContain('`goalCriteria`: those are retired');
    expect(md).toContain('never write one for a');
  });
});
