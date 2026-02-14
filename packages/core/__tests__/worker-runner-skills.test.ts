import { describe, expect, test } from 'bun:test';

/**
 * Helper functions extracted from WorkerRunner.start() for testing.
 * These mirror the skill extraction and configuration logic.
 */

/**
 * Builds skill configuration from task context.
 * Extracted from WorkerRunner.start() skill handling logic.
 */
function buildSkillConfig(taskContext: any): {
  allowedTools: string[];
  systemPromptAppend?: string;
} {
  const skillSlugs: string[] = taskContext?.skillSlugs || [];
  const allowedTools: string[] = [];
  if (skillSlugs.length > 0) {
    for (const slug of skillSlugs) {
      allowedTools.push(`Skill(${slug})`);
    }
  }

  let systemPromptAppend: string | undefined;
  if (skillSlugs.length > 0) {
    systemPromptAppend =
      skillSlugs.length === 1
        ? `You MUST use the ${skillSlugs[0]} skill for this task. Invoke it with the Skill tool before starting work.`
        : `Use these skills for this task: ${skillSlugs.join(', ')}. Invoke them with the Skill tool as needed.`;
  }

  return { allowedTools, systemPromptAppend };
}

/**
 * Builds query options with skill configuration.
 * Mirrors the conditional spreading logic in WorkerRunner.start().
 */
function buildQueryOptions(taskContext: any): {
  settingSources: string[];
  allowedTools?: string[];
} {
  const { allowedTools } = buildSkillConfig(taskContext);

  const options: {
    settingSources: string[];
    allowedTools?: string[];
  } = {
    settingSources: ['user', 'project'],
  };

  if (allowedTools.length > 0) {
    options.allowedTools = allowedTools;
  }

  return options;
}

describe('WorkerRunner skill configuration', () => {
  describe('allowedTools construction', () => {
    test('no skillSlugs returns empty allowedTools array', () => {
      const { allowedTools } = buildSkillConfig({});
      expect(allowedTools).toEqual([]);
    });

    test('undefined context returns empty allowedTools array', () => {
      const { allowedTools } = buildSkillConfig(undefined);
      expect(allowedTools).toEqual([]);
    });

    test('single skill slug creates correct allowedTools entry', () => {
      const { allowedTools } = buildSkillConfig({ skillSlugs: ['deploy'] });
      expect(allowedTools).toEqual(['Skill(deploy)']);
    });

    test('multiple skill slugs create multiple allowedTools entries', () => {
      const { allowedTools } = buildSkillConfig({ skillSlugs: ['deploy', 'test'] });
      expect(allowedTools).toEqual(['Skill(deploy)', 'Skill(test)']);
    });

    test('empty skillSlugs array returns empty allowedTools', () => {
      const { allowedTools } = buildSkillConfig({ skillSlugs: [] });
      expect(allowedTools).toEqual([]);
    });

    test('preserves skill slug order in allowedTools', () => {
      const { allowedTools } = buildSkillConfig({
        skillSlugs: ['alpha', 'beta', 'gamma']
      });
      expect(allowedTools).toEqual([
        'Skill(alpha)',
        'Skill(beta)',
        'Skill(gamma)',
      ]);
    });
  });

  describe('systemPrompt.append construction', () => {
    test('no skills returns undefined systemPromptAppend', () => {
      const { systemPromptAppend } = buildSkillConfig({});
      expect(systemPromptAppend).toBeUndefined();
    });

    test('empty skillSlugs array returns undefined systemPromptAppend', () => {
      const { systemPromptAppend } = buildSkillConfig({ skillSlugs: [] });
      expect(systemPromptAppend).toBeUndefined();
    });

    test('single skill creates MUST use prompt', () => {
      const { systemPromptAppend } = buildSkillConfig({ skillSlugs: ['deploy'] });
      expect(systemPromptAppend).toBe(
        'You MUST use the deploy skill for this task. Invoke it with the Skill tool before starting work.'
      );
    });

    test('multiple skills create list prompt', () => {
      const { systemPromptAppend } = buildSkillConfig({
        skillSlugs: ['deploy', 'test']
      });
      expect(systemPromptAppend).toBe(
        'Use these skills for this task: deploy, test. Invoke them with the Skill tool as needed.'
      );
    });

    test('three skills create comma-separated list', () => {
      const { systemPromptAppend } = buildSkillConfig({
        skillSlugs: ['deploy', 'test', 'monitor']
      });
      expect(systemPromptAppend).toBe(
        'Use these skills for this task: deploy, test, monitor. Invoke them with the Skill tool as needed.'
      );
    });

    test('single skill with special characters in name', () => {
      const { systemPromptAppend } = buildSkillConfig({
        skillSlugs: ['my-skill_v2']
      });
      expect(systemPromptAppend).toBe(
        'You MUST use the my-skill_v2 skill for this task. Invoke it with the Skill tool before starting work.'
      );
    });
  });

  describe('settingSources', () => {
    test('always includes user and project', () => {
      const options = buildQueryOptions({});
      expect(options.settingSources).toEqual(['user', 'project']);
    });

    test('includes user and project even with skills', () => {
      const options = buildQueryOptions({ skillSlugs: ['deploy'] });
      expect(options.settingSources).toEqual(['user', 'project']);
    });

    test('settingSources unchanged by multiple skills', () => {
      const options = buildQueryOptions({ skillSlugs: ['a', 'b', 'c'] });
      expect(options.settingSources).toEqual(['user', 'project']);
    });
  });

  describe('integration with query options', () => {
    test('no skills means allowedTools not present in options', () => {
      const options = buildQueryOptions({});
      expect(options).toEqual({
        settingSources: ['user', 'project'],
      });
      expect('allowedTools' in options).toBe(false);
    });

    test('empty skillSlugs means allowedTools not present in options', () => {
      const options = buildQueryOptions({ skillSlugs: [] });
      expect(options).toEqual({
        settingSources: ['user', 'project'],
      });
      expect('allowedTools' in options).toBe(false);
    });

    test('single skill adds allowedTools to options', () => {
      const options = buildQueryOptions({ skillSlugs: ['deploy'] });
      expect(options).toEqual({
        settingSources: ['user', 'project'],
        allowedTools: ['Skill(deploy)'],
      });
    });

    test('multiple skills add all allowedTools to options', () => {
      const options = buildQueryOptions({ skillSlugs: ['deploy', 'test', 'monitor'] });
      expect(options).toEqual({
        settingSources: ['user', 'project'],
        allowedTools: ['Skill(deploy)', 'Skill(test)', 'Skill(monitor)'],
      });
    });
  });

  describe('complete skill configuration flow', () => {
    test('end-to-end: no skills', () => {
      const taskContext = { title: 'Some task' };
      const config = buildSkillConfig(taskContext);
      const options = buildQueryOptions(taskContext);

      expect(config.allowedTools).toEqual([]);
      expect(config.systemPromptAppend).toBeUndefined();
      expect(options.settingSources).toEqual(['user', 'project']);
      expect('allowedTools' in options).toBe(false);
    });

    test('end-to-end: single skill', () => {
      const taskContext = { skillSlugs: ['deploy'] };
      const config = buildSkillConfig(taskContext);
      const options = buildQueryOptions(taskContext);

      expect(config.allowedTools).toEqual(['Skill(deploy)']);
      expect(config.systemPromptAppend).toBe(
        'You MUST use the deploy skill for this task. Invoke it with the Skill tool before starting work.'
      );
      expect(options.settingSources).toEqual(['user', 'project']);
      expect(options.allowedTools).toEqual(['Skill(deploy)']);
    });

    test('end-to-end: multiple skills', () => {
      const taskContext = { skillSlugs: ['deploy', 'test'] };
      const config = buildSkillConfig(taskContext);
      const options = buildQueryOptions(taskContext);

      expect(config.allowedTools).toEqual(['Skill(deploy)', 'Skill(test)']);
      expect(config.systemPromptAppend).toBe(
        'Use these skills for this task: deploy, test. Invoke them with the Skill tool as needed.'
      );
      expect(options.settingSources).toEqual(['user', 'project']);
      expect(options.allowedTools).toEqual(['Skill(deploy)', 'Skill(test)']);
    });
  });

  describe('edge cases', () => {
    test('null context behaves like empty context', () => {
      const { allowedTools, systemPromptAppend } = buildSkillConfig(null);
      expect(allowedTools).toEqual([]);
      expect(systemPromptAppend).toBeUndefined();
    });

    test('context with other properties but no skillSlugs', () => {
      const { allowedTools, systemPromptAppend } = buildSkillConfig({
        title: 'Task',
        description: 'Description',
        priority: 5,
      });
      expect(allowedTools).toEqual([]);
      expect(systemPromptAppend).toBeUndefined();
    });

    test('skillSlugs with whitespace in names', () => {
      const { allowedTools, systemPromptAppend } = buildSkillConfig({
        skillSlugs: ['skill with spaces'],
      });
      expect(allowedTools).toEqual(['Skill(skill with spaces)']);
      expect(systemPromptAppend).toBe(
        'You MUST use the skill with spaces skill for this task. Invoke it with the Skill tool before starting work.'
      );
    });

    test('duplicate skill slugs are preserved', () => {
      const { allowedTools } = buildSkillConfig({
        skillSlugs: ['deploy', 'deploy'],
      });
      expect(allowedTools).toEqual(['Skill(deploy)', 'Skill(deploy)']);
    });
  });
});
