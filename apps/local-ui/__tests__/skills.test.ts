/**
 * Unit Tests for Skill Scanner (skills.ts)
 *
 * Tests the filesystem scanning of .claude/skills/ directories.
 * Uses temp directories — no external dependencies needed.
 *
 * Run: bun test apps/local-ui/__tests__/skills.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { scanSkills } from '../src/skills';

const TEST_DIR = join(tmpdir(), `buildd-skills-test-${Date.now()}`);

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

/** Helper to create a skill directory structure */
function createSkill(slug: string, content: string, extraFiles?: Record<string, string>) {
  const dir = join(TEST_DIR, '.claude', 'skills', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), content);
  if (extraFiles) {
    for (const [name, body] of Object.entries(extraFiles)) {
      writeFileSync(join(dir, name), body);
    }
  }
}

describe('scanSkills', () => {
  test('returns empty array when .claude/skills/ does not exist', () => {
    const emptyDir = join(TEST_DIR, 'empty-project');
    mkdirSync(emptyDir, { recursive: true });

    const result = scanSkills(emptyDir);
    expect(result).toEqual([]);
  });

  test('returns empty array when .claude/skills/ has no subdirectories', () => {
    const project = join(TEST_DIR, 'no-skills-project');
    const skillsDir = join(project, '.claude', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'random.txt'), 'not a skill');

    const result = scanSkills(project);
    expect(result).toEqual([]);
  });

  test('discovers a basic skill with no frontmatter', () => {
    createSkill('basic-skill', '# Basic Skill\n\nDo things.');

    const result = scanSkills(TEST_DIR);
    const skill = result.find(s => s.slug === 'basic-skill');

    expect(skill).toBeDefined();
    expect(skill!.slug).toBe('basic-skill');
    expect(skill!.name).toBe('basic-skill'); // Falls back to slug
    expect(skill!.description).toBe('');
    expect(skill!.content).toBe('# Basic Skill\n\nDo things.');
    expect(skill!.path).toContain('basic-skill/SKILL.md');
    expect(Object.keys(skill!.referenceFiles)).toHaveLength(0);
  });

  test('parses YAML frontmatter for name and description', () => {
    const content = `---
name: My Awesome Skill
description: Does awesome things
---

# Instructions

Follow these steps...`;

    createSkill('awesome-skill', content);

    const result = scanSkills(TEST_DIR);
    const skill = result.find(s => s.slug === 'awesome-skill');

    expect(skill).toBeDefined();
    expect(skill!.name).toBe('My Awesome Skill');
    expect(skill!.description).toBe('Does awesome things');
    expect(skill!.content).toBe(content);
  });

  test('handles quoted frontmatter values', () => {
    const content = `---
name: "Quoted Name"
description: 'Single quoted desc'
---

Content here.`;

    createSkill('quoted-skill', content);

    const result = scanSkills(TEST_DIR);
    const skill = result.find(s => s.slug === 'quoted-skill');

    expect(skill).toBeDefined();
    expect(skill!.name).toBe('Quoted Name');
    expect(skill!.description).toBe('Single quoted desc');
  });

  test('collects reference .md files', () => {
    createSkill('with-refs', '# Main skill', {
      'REFERENCE.md': '# Reference\n\nMore info.',
      'EXAMPLES.md': '# Examples\n\nHere are some.',
      'not-md.txt': 'This should be ignored',
    });

    const result = scanSkills(TEST_DIR);
    const skill = result.find(s => s.slug === 'with-refs');

    expect(skill).toBeDefined();
    expect(Object.keys(skill!.referenceFiles)).toHaveLength(2);
    expect(skill!.referenceFiles['REFERENCE.md']).toContain('# Reference');
    expect(skill!.referenceFiles['EXAMPLES.md']).toContain('# Examples');
    expect(skill!.referenceFiles['not-md.txt']).toBeUndefined();
  });

  test('skips directories without SKILL.md', () => {
    const dir = join(TEST_DIR, '.claude', 'skills', 'no-skillmd');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README.md'), '# Not a skill');

    const result = scanSkills(TEST_DIR);
    const skill = result.find(s => s.slug === 'no-skillmd');

    expect(skill).toBeUndefined();
  });

  test('skips hidden directories', () => {
    const dir = join(TEST_DIR, '.claude', 'skills', '.hidden-skill');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '# Hidden');

    const result = scanSkills(TEST_DIR);
    const skill = result.find(s => s.slug === '.hidden-skill');

    expect(skill).toBeUndefined();
  });

  test('discovers multiple skills', () => {
    createSkill('skill-a', '---\nname: Skill A\n---\nContent A');
    createSkill('skill-b', '---\nname: Skill B\n---\nContent B');

    const result = scanSkills(TEST_DIR);

    const slugs = result.map(s => s.slug);
    expect(slugs).toContain('skill-a');
    expect(slugs).toContain('skill-b');
  });

  test('returns absolute path in path field', () => {
    createSkill('abs-path-skill', '# Test');

    const result = scanSkills(TEST_DIR);
    const skill = result.find(s => s.slug === 'abs-path-skill');

    expect(skill).toBeDefined();
    expect(skill!.path.startsWith('/')).toBe(true);
    expect(skill!.path).toContain('abs-path-skill/SKILL.md');
  });

  test('handles frontmatter with extra fields gracefully', () => {
    const content = `---
name: Extended Skill
description: Has extra fields
version: 1.0.0
author: Test Author
tags: [one, two]
---

Body content.`;

    createSkill('extended-skill', content);

    const result = scanSkills(TEST_DIR);
    const skill = result.find(s => s.slug === 'extended-skill');

    expect(skill).toBeDefined();
    expect(skill!.name).toBe('Extended Skill');
    expect(skill!.description).toBe('Has extra fields');
  });

  test('handles SKILL.md with no frontmatter delimiters', () => {
    createSkill('no-delimiters', 'Just raw content, no frontmatter.');

    const result = scanSkills(TEST_DIR);
    const skill = result.find(s => s.slug === 'no-delimiters');

    expect(skill).toBeDefined();
    expect(skill!.name).toBe('no-delimiters'); // slug fallback
    expect(skill!.description).toBe('');
    expect(skill!.content).toBe('Just raw content, no frontmatter.');
  });

  test('handles empty SKILL.md file', () => {
    createSkill('empty-skill', '');

    const result = scanSkills(TEST_DIR);
    const skill = result.find(s => s.slug === 'empty-skill');

    expect(skill).toBeDefined();
    expect(skill!.name).toBe('empty-skill');
    expect(skill!.content).toBe('');
  });
});
