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

  const skillRef = context?.skillRef as { skillId: string; slug: string; contentHash: string } | undefined;
  if (skillRef && !skillSlugs.includes(skillRef.slug)) {
    skillSlugs.push(skillRef.slug);
  }

  return skillSlugs;
}

function buildAllowedTools(skillSlugs: string[]): string[] {
  return skillSlugs.map(slug => `Skill(${slug})`);
}

function buildSystemPromptAppend(skillSlugs: string[]): string | undefined {
  if (skillSlugs.length === 0) return undefined;
  if (skillSlugs.length === 1) {
    return `You MUST use the ${skillSlugs[0]} skill for this task. Invoke it with the Skill tool before starting work.`;
  }
  return `Use these skills for this task: ${skillSlugs.join(', ')}. Invoke them with the Skill tool as needed.`;
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

  test('context.skillRef includes ref slug', () => {
    const context = {
      skillRef: { skillId: '123', slug: 'review', contentHash: 'xyz789' }
    };
    expect(extractSkillSlugs(context)).toEqual(['review']);
  });

  test('skillRef slug already in skillSlugs does not duplicate', () => {
    const context = {
      skillSlugs: ['review', 'deploy'],
      skillRef: { skillId: '123', slug: 'review', contentHash: 'xyz789' }
    };
    expect(extractSkillSlugs(context)).toEqual(['review', 'deploy']);
  });

  test('all three sources combined are merged and deduplicated', () => {
    const context = {
      skillSlugs: ['deploy'],
      skillBundles: [
        { slug: 'deploy', name: 'Deploy', content: '', contentHash: 'abc123' },
        { slug: 'test', name: 'Test', content: '', contentHash: 'def456' }
      ] as SkillBundle[],
      skillRef: { skillId: '123', slug: 'review', contentHash: 'xyz789' }
    };
    expect(extractSkillSlugs(context)).toEqual(['deploy', 'test', 'review']);
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
