import { describe, test, expect } from 'bun:test';
import type { SkillBundle } from '@buildd/shared';

// Extracted from WorkerManager.startSession() for testing
function extractSkillSlugs(context: any): string[] {
  const skillBundles = context?.skillBundles as SkillBundle[] | undefined;
  const skillSlugs: string[] = [...(context?.skillSlugs || [])];

  if (skillBundles && skillBundles.length > 0) {
    for (const bundle of skillBundles) {
      if (!skillSlugs.includes(bundle.slug)) {
        skillSlugs.push(bundle.slug);
      }
    }
  }

  return skillSlugs;
}

function buildAllowedTools(skillSlugs: string[], useSkillAgents = false): string[] {
  if (useSkillAgents) return [];
  return skillSlugs.map(slug => `Skill(${slug})`);
}

function buildSystemPromptAppend(skillSlugs: string[], useSkillAgents = false): string | undefined {
  if (skillSlugs.length === 0 || useSkillAgents) return undefined;
  if (skillSlugs.length === 1) {
    return `You MUST use the ${skillSlugs[0]} skill for this task. Invoke it with the Skill tool before starting work.`;
  }
  return `Use these skills for this task: ${skillSlugs.join(', ')}. Invoke them with the Skill tool as needed.`;
}

function buildAgentDefinitions(
  skillBundles: SkillBundle[] | undefined,
  useSkillAgents: boolean,
): Record<string, { description: string; prompt: string; tools: string[]; model: string }> | undefined {
  if (!useSkillAgents || !skillBundles || skillBundles.length === 0) return undefined;
  const agents: Record<string, { description: string; prompt: string; tools: string[]; model: string }> = {};
  for (const bundle of skillBundles) {
    agents[bundle.slug] = {
      description: bundle.description || bundle.name,
      prompt: bundle.content,
      tools: ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write'],
      model: 'inherit',
    };
  }
  return agents;
}

describe('extractSkillSlugs', () => {
  test('no context returns empty array', () => {
    expect(extractSkillSlugs(undefined)).toEqual([]);
    expect(extractSkillSlugs(null)).toEqual([]);
    expect(extractSkillSlugs({})).toEqual([]);
  });

  test('context.skillSlugs present returns those slugs', () => {
    const context = { skillSlugs: ['deploy'] };
    expect(extractSkillSlugs(context)).toEqual(['deploy']);
  });

  test('context.skillBundles includes bundle slugs', () => {
    const context = {
      skillBundles: [
        { slug: 'deploy', name: 'Deploy', content: '', contentHash: 'abc123' }
      ] as SkillBundle[]
    };
    expect(extractSkillSlugs(context)).toEqual(['deploy']);
  });

  test('skillSlugs and skillBundles with overlap deduplicates', () => {
    const context = {
      skillSlugs: ['deploy', 'test'],
      skillBundles: [
        { slug: 'deploy', name: 'Deploy', content: '', contentHash: 'abc123' },
        { slug: 'review', name: 'Review', content: '', contentHash: 'def456' }
      ] as SkillBundle[]
    };
    expect(extractSkillSlugs(context)).toEqual(['deploy', 'test', 'review']);
  });

  test('skillSlugs and skillBundles combined are merged and deduplicated', () => {
    const context = {
      skillSlugs: ['deploy'],
      skillBundles: [
        { slug: 'deploy', name: 'Deploy', content: '', contentHash: 'abc123' },
        { slug: 'test', name: 'Test', content: '', contentHash: 'def456' }
      ] as SkillBundle[],
    };
    expect(extractSkillSlugs(context)).toEqual(['deploy', 'test']);
  });

  test('multiple skillBundles all included', () => {
    const context = {
      skillBundles: [
        { slug: 'a', name: 'A', content: '', contentHash: '1' },
        { slug: 'b', name: 'B', content: '', contentHash: '2' },
        { slug: 'c', name: 'C', content: '', contentHash: '3' }
      ] as SkillBundle[]
    };
    expect(extractSkillSlugs(context)).toEqual(['a', 'b', 'c']);
  });
});

describe('buildAllowedTools', () => {
  test('empty array returns empty array', () => {
    expect(buildAllowedTools([])).toEqual([]);
  });

  test('single slug returns single Skill tool', () => {
    expect(buildAllowedTools(['deploy'])).toEqual(['Skill(deploy)']);
  });

  test('multiple slugs return multiple Skill tools', () => {
    expect(buildAllowedTools(['a', 'b'])).toEqual(['Skill(a)', 'Skill(b)']);
  });

  test('preserves slug order', () => {
    expect(buildAllowedTools(['deploy', 'test', 'review'])).toEqual([
      'Skill(deploy)',
      'Skill(test)',
      'Skill(review)'
    ]);
  });
});

describe('buildSystemPromptAppend', () => {
  test('empty array returns undefined', () => {
    expect(buildSystemPromptAppend([])).toBeUndefined();
  });

  test('single slug returns MUST use instruction', () => {
    const result = buildSystemPromptAppend(['deploy']);
    expect(result).toBe('You MUST use the deploy skill for this task. Invoke it with the Skill tool before starting work.');
  });

  test('multiple slugs return Use these skills instruction', () => {
    const result = buildSystemPromptAppend(['deploy', 'test']);
    expect(result).toBe('Use these skills for this task: deploy, test. Invoke them with the Skill tool as needed.');
  });

  test('multiple slugs joined with comma-space', () => {
    const result = buildSystemPromptAppend(['a', 'b', 'c']);
    expect(result).toBe('Use these skills for this task: a, b, c. Invoke them with the Skill tool as needed.');
  });

  test('single slug exact format matches source code', () => {
    const slug = 'my-skill';
    const result = buildSystemPromptAppend([slug]);
    expect(result).toBe(`You MUST use the ${slug} skill for this task. Invoke it with the Skill tool before starting work.`);
  });

  test('multiple slugs exact format matches source code', () => {
    const slugs = ['skill-one', 'skill-two'];
    const result = buildSystemPromptAppend(slugs);
    expect(result).toBe(`Use these skills for this task: ${slugs.join(', ')}. Invoke them with the Skill tool as needed.`);
  });
});

describe('buildAllowedTools with useSkillAgents', () => {
  test('returns empty when useSkillAgents is true', () => {
    expect(buildAllowedTools(['deploy', 'review'], true)).toEqual([]);
  });

  test('returns Skill tools when useSkillAgents is false', () => {
    expect(buildAllowedTools(['deploy'], false)).toEqual(['Skill(deploy)']);
  });

  test('defaults to false (normal behavior)', () => {
    expect(buildAllowedTools(['deploy'])).toEqual(['Skill(deploy)']);
  });
});

describe('buildSystemPromptAppend with useSkillAgents', () => {
  test('returns undefined when useSkillAgents is true', () => {
    expect(buildSystemPromptAppend(['deploy'], true)).toBeUndefined();
  });

  test('returns undefined when useSkillAgents is true with multiple slugs', () => {
    expect(buildSystemPromptAppend(['a', 'b', 'c'], true)).toBeUndefined();
  });

  test('returns normal prompt when useSkillAgents is false', () => {
    const result = buildSystemPromptAppend(['deploy'], false);
    expect(result).toContain('MUST use the deploy skill');
  });
});

describe('buildAgentDefinitions', () => {
  test('returns undefined when useSkillAgents is false', () => {
    const bundles: SkillBundle[] = [
      { slug: 'deploy', name: 'Deploy', content: 'Instructions' },
    ];
    expect(buildAgentDefinitions(bundles, false)).toBeUndefined();
  });

  test('returns undefined when no skill bundles', () => {
    expect(buildAgentDefinitions(undefined, true)).toBeUndefined();
    expect(buildAgentDefinitions([], true)).toBeUndefined();
  });

  test('converts bundles to agent definitions', () => {
    const bundles: SkillBundle[] = [
      { slug: 'deploy', name: 'Deploy', description: 'Deploy desc', content: 'Deploy instructions' },
      { slug: 'review', name: 'Review', content: 'Review instructions' },
    ];
    const agents = buildAgentDefinitions(bundles, true);

    expect(agents).toBeDefined();
    expect(Object.keys(agents!)).toEqual(['deploy', 'review']);

    expect(agents!.deploy.description).toBe('Deploy desc');
    expect(agents!.deploy.prompt).toBe('Deploy instructions');
    expect(agents!.deploy.tools).toEqual(['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write']);
    expect(agents!.deploy.model).toBe('inherit');

    // Falls back to name when description is missing
    expect(agents!.review.description).toBe('Review');
  });

  test('uses name as fallback when description is undefined', () => {
    const bundles: SkillBundle[] = [
      { slug: 'test', name: 'Test Skill', content: 'test' },
    ];
    const agents = buildAgentDefinitions(bundles, true);
    expect(agents!.test.description).toBe('Test Skill');
  });

  test('uses name as fallback when description is empty string', () => {
    const bundles: SkillBundle[] = [
      { slug: 'test', name: 'Test Skill', description: '', content: 'test' },
    ];
    const agents = buildAgentDefinitions(bundles, true);
    expect(agents!.test.description).toBe('Test Skill');
  });

  test('all agents get same tool set and model', () => {
    const bundles: SkillBundle[] = [
      { slug: 'a', name: 'A', content: 'a' },
      { slug: 'b', name: 'B', content: 'b' },
      { slug: 'c', name: 'C', content: 'c' },
    ];
    const agents = buildAgentDefinitions(bundles, true)!;
    for (const key of Object.keys(agents)) {
      expect(agents[key].tools).toEqual(['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write']);
      expect(agents[key].model).toBe('inherit');
    }
  });
});
