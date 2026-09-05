import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  SUBAGENT_DEFAULT_TOOLS,
  SUBAGENT_TOOLS_LABEL,
  SUBAGENT_TOOLS_NOTE,
  subagentToolsSummary,
} from './role-tool-scope';

const WEB_SRC = join(import.meta.dir, '..');
const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');

/**
 * The bug this replaces: three surfaces summarised `role.allowedTools` as
 * "N restricted" / "All allowed", asserting a restriction on the role's agent.
 * At runtime the list only ever becomes a skill subagent's `tools`
 * (`apps/runner/src/workers.ts`); the primary agent's allowlist is built from
 * `Skill(<slug>)` scoping alone, so a saved restriction changed nothing.
 */
describe('subagentToolsSummary', () => {
  test('never claims a restriction on the agent', () => {
    for (const tools of [[], ['Read'], ['Read', 'Grep', 'Bash']]) {
      const summary = subagentToolsSummary(tools);
      expect(summary).not.toContain('restricted');
      expect(summary).not.toContain('All allowed');
    }
  });

  test('names the subagent default set instead of "all tools" when empty', () => {
    expect(subagentToolsSummary([])).toBe('Subagent defaults');
    expect(subagentToolsSummary(null)).toBe('Subagent defaults');
    expect(subagentToolsSummary(undefined)).toBe('Subagent defaults');
  });

  test('scopes a non-empty selection to subagents, and counts it', () => {
    expect(subagentToolsSummary(['Read'])).toBe('1 subagent tool');
    expect(subagentToolsSummary(['Read', 'Grep', 'Bash'])).toBe('3 subagent tools');
  });
});

describe('the scope copy', () => {
  test('says what the list applies to and what it does not', () => {
    expect(SUBAGENT_TOOLS_NOTE).toContain('skill subagent');
    expect(SUBAGENT_TOOLS_NOTE).toContain('does not narrow the main agent');
  });

  test('lists the same default set the runner substitutes', () => {
    const runner = readFileSync(join(REPO_ROOT, 'apps/runner/src/workers.ts'), 'utf8');
    const literal = `['${SUBAGENT_DEFAULT_TOOLS.join("', '")}']`;
    expect(runner.includes(`const defaultTools = ${literal}`)).toBe(true);
    for (const tool of SUBAGENT_DEFAULT_TOOLS) {
      expect(SUBAGENT_TOOLS_NOTE).toContain(tool);
    }
  });
});

describe('no surface asserts an unqualified restriction', () => {
  // Asserted as booleans, not with toContain: a failed toContain prints the
  // whole source file into the test log.
  const has = (rel: string, needle: string) =>
    readFileSync(join(WEB_SRC, rel), 'utf8').includes(needle);

  const SURFACES = [
    'app/app/(protected)/workspaces/[id]/skills/[skillId]/RoleEditor.tsx',
    'app/app/(protected)/team/[slug]/settings/TeamRoleEditor.tsx',
    'app/app/(protected)/workspaces/[id]/skills/SkillList.tsx',
    'app/app/(protected)/workspaces/[id]/skills/SkillForm.tsx',
    'app/app/(protected)/team/new/TeamRoleForm.tsx',
  ];

  for (const surface of SURFACES) {
    test(`${surface} scopes its tool copy to subagents`, () => {
      expect(has(surface, 'restricted')).toBe(false);
      expect(has(surface, 'All allowed')).toBe(false);
      expect(has(surface, 'all tools allowed')).toBe(false);
      expect(has(surface, "'Allowed Tools'")).toBe(false);
      expect(has(surface, '@/lib/role-tool-scope')).toBe(true);
    });
  }

  test('the tool control is labelled by the shared constant', () => {
    expect(SUBAGENT_TOOLS_LABEL).toBe('Subagent Tools');
    for (const surface of SURFACES) {
      // SkillList shows a count, not the control, so it needs no heading.
      if (surface.endsWith('SkillList.tsx')) continue;
      expect(has(surface, 'SUBAGENT_TOOLS_LABEL')).toBe(true);
    }
  });
});
