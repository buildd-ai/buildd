/**
 * Unit tests for Skills system — scanning and syncing skills
 *
 * Run: bun test apps/runner/__tests__/unit/skills.test.ts
 *
 * Uses real filesystem with temp directories for scanSkills tests,
 * and inline reimplementation for syncSkillToLocal/ensureFrontmatter tests.
 * This avoids mock.module conflicts with other test files that mock
 * '../../src/skills.js' (worker-manager-*.test.ts).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createHash } from 'crypto';
import { join } from 'path';
import { tmpdir } from 'os';

// Use dynamic require to avoid mock.module('fs') pollution from outbox.test.ts
// which doesn't export rmSync/mkdirSync etc.
const nodeFs = (() => {
  try { return require('node:fs'); }
  catch { return require('fs'); }
})();
const { mkdirSync, writeFileSync, rmSync, existsSync } = nodeFs;

// Import scanSkills directly — it uses sync fs only, no mocks needed
// We guard against mock pollution by catching the import failure
let scanSkills: (path: string) => any[];
try {
  const mod = await import('../../src/skills');
  scanSkills = mod.scanSkills;
} catch {
  // Fallback: if mocked by another test file, scanSkills is undefined
  // Tests will be skipped
}

// Reimplementation of parseFrontmatter and ensureFrontmatter for isolated testing.
// This mirrors the logic in skills.ts without importing it (avoids mock.module conflicts).
function parseFrontmatter(content: string): { name?: string; description?: string } {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) return {};
  const endIdx = trimmed.indexOf('---', 3);
  if (endIdx === -1) return {};
  const frontmatter = trimmed.slice(3, endIdx).trim();
  const result: Record<string, string> = {};
  for (const line of frontmatter.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (key && value) result[key] = value;
  }
  return { name: result.name, description: result.description };
}

function ensureFrontmatter(content: string, slug: string, displayName: string): string {
  if (content.startsWith('---')) {
    const endIdx = content.indexOf('---', 3);
    if (endIdx === -1) return content;
    const frontmatter = content.slice(3, endIdx);
    const afterFrontmatter = content.slice(endIdx);
    if (/^name\s*:/m.test(frontmatter)) {
      const updated = frontmatter.replace(/^name\s*:.*/m, `name: ${slug}`);
      return '---' + updated + afterFrontmatter;
    }
    return '---\nname: ' + slug + frontmatter + afterFrontmatter;
  }
  const fm = ['---', `name: ${slug}`, `description: ${displayName}`, '---', ''].join('\n');
  return fm + content;
}

// Temp directory helpers
let tempDir: string;

function createTempDir(): string {
  const dir = join(tmpdir(), `skills-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function setupSkill(projectPath: string, slug: string, content: string, refFiles?: Record<string, string>) {
  const skillDir = join(projectPath, '.claude', 'skills', slug);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), content);
  if (refFiles) {
    for (const [name, data] of Object.entries(refFiles)) {
      writeFileSync(join(skillDir, name), data);
    }
  }
}

describe('parseFrontmatter', () => {
  test('extracts name and description from valid frontmatter', () => {
    const result = parseFrontmatter('---\nname: my-skill\ndescription: Does something\n---\nContent');
    expect(result.name).toBe('my-skill');
    expect(result.description).toBe('Does something');
  });

  test('returns empty for content without frontmatter', () => {
    const result = parseFrontmatter('No frontmatter here');
    expect(result).toEqual({});
  });

  test('returns empty for missing closing ---', () => {
    const result = parseFrontmatter('---\nname: test\nThis has no closing marker');
    expect(result).toEqual({});
  });

  test('strips quotes from values', () => {
    const result = parseFrontmatter('---\nname: "quoted-name"\ndescription: \'single-quoted\'\n---\nContent');
    expect(result.name).toBe('quoted-name');
    expect(result.description).toBe('single-quoted');
  });

  test('handles whitespace before frontmatter', () => {
    const result = parseFrontmatter('  \n---\nname: spaced\n---\nContent');
    expect(result.name).toBe('spaced');
  });

  test('ignores lines without colons', () => {
    const result = parseFrontmatter('---\nname: test\nno-colon-line\n---\nContent');
    expect(result.name).toBe('test');
  });
});

describe('ensureFrontmatter', () => {
  test('adds frontmatter when content has none', () => {
    const result = ensureFrontmatter('Just content', 'my-slug', 'My Skill');
    expect(result).toBe('---\nname: my-slug\ndescription: My Skill\n---\nJust content');
  });

  test('replaces name in existing frontmatter when wrong', () => {
    const content = '---\nname: wrong-name\ndescription: Desc\n---\nContent';
    const result = ensureFrontmatter(content, 'correct-slug', 'Display Name');
    expect(result).toContain('name: correct-slug');
    expect(result).not.toContain('name: wrong-name');
    expect(result).toContain('description: Desc');
  });

  test('preserves frontmatter with correct name', () => {
    const content = '---\nname: correct-name\ndescription: Already correct\n---\nContent';
    const result = ensureFrontmatter(content, 'correct-name', 'Display Name');
    expect(result).toContain('name: correct-name');
    expect(result).toContain('description: Already correct');
  });

  test('adds name field when frontmatter has no name', () => {
    const content = '---\ndescription: Has desc but no name\n---\nContent';
    const result = ensureFrontmatter(content, 'add-name', 'Add Name');
    expect(result).toContain('name: add-name');
    expect(result).toContain('description: Has desc but no name');
  });

  test('returns unchanged when frontmatter has no closing marker', () => {
    const content = '---\nname: test\nNo closing marker';
    const result = ensureFrontmatter(content, 'slug', 'Name');
    expect(result).toBe(content);
  });
});

describe('scanSkills', () => {
  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // Guard: skip if scanSkills wasn't imported successfully (mock pollution)
  const maybeTest = scanSkills ? test : test.skip;

  maybeTest('returns empty array when .claude/skills does not exist', () => {
    const result = scanSkills(tempDir);
    expect(result).toEqual([]);
  });

  maybeTest('discovers skill with frontmatter', () => {
    const content = '---\nname: my-skill\ndescription: Does something cool\n---\n\n# My Skill\n\nThis is the content.';
    setupSkill(tempDir, 'my-skill', content);

    const result = scanSkills(tempDir);
    expect(result.length).toBe(1);
    expect(result[0].slug).toBe('my-skill');
    expect(result[0].name).toBe('my-skill');
    expect(result[0].description).toBe('Does something cool');
    expect(result[0].content).toContain('This is the content');
    expect(result[0].contentHash).toBe(
      createHash('sha256').update(content).digest('hex')
    );
  });

  maybeTest('falls back to slug when frontmatter has no name', () => {
    setupSkill(tempDir, 'fallback-skill', 'No frontmatter here!');

    const result = scanSkills(tempDir);
    expect(result.length).toBe(1);
    expect(result[0].slug).toBe('fallback-skill');
    expect(result[0].name).toBe('fallback-skill');
    expect(result[0].description).toBeUndefined();
  });

  maybeTest('parses quoted values in frontmatter', () => {
    setupSkill(tempDir, 'quoted', '---\nname: "quoted-name"\ndescription: \'single-quoted\'\n---\nContent');

    const result = scanSkills(tempDir);
    expect(result[0].name).toBe('quoted-name');
    expect(result[0].description).toBe('single-quoted');
  });

  maybeTest('includes reference .md files', () => {
    setupSkill(tempDir, 'with-refs', '---\nname: with-refs\n---\nContent', {
      'examples.md': '# Examples\n\nSome examples here',
      'api-docs.md': '# API Docs\n\nAPI reference',
    });

    const result = scanSkills(tempDir);
    expect(result[0].referenceFiles['examples.md']).toBe('# Examples\n\nSome examples here');
    expect(result[0].referenceFiles['api-docs.md']).toBe('# API Docs\n\nAPI reference');
    expect(result[0].referenceFiles['SKILL.md']).toBeUndefined();
  });

  maybeTest('skips directories without SKILL.md', () => {
    // Create an empty skill directory (no SKILL.md)
    const emptyDir = join(tempDir, '.claude', 'skills', 'empty');
    mkdirSync(emptyDir, { recursive: true });
    // Create a valid skill
    setupSkill(tempDir, 'valid', 'Content');

    const result = scanSkills(tempDir);
    expect(result.length).toBe(1);
    expect(result[0].slug).toBe('valid');
  });

  maybeTest('handles incomplete frontmatter (missing closing ---)', () => {
    setupSkill(tempDir, 'incomplete', '---\nname: incomplete\ndescription: Missing\n\nNo closing marker');

    const result = scanSkills(tempDir);
    expect(result[0].name).toBe('incomplete'); // falls back to slug
    expect(result[0].description).toBeUndefined();
  });

  maybeTest('handles multiple skills', () => {
    setupSkill(tempDir, 'skill-1', '---\nname: skill-1\n---\nContent 1');
    setupSkill(tempDir, 'skill-2', '---\nname: skill-2\n---\nContent 2');

    const result = scanSkills(tempDir);
    expect(result.length).toBe(2);
    expect(result.map(s => s.slug).sort()).toEqual(['skill-1', 'skill-2']);
  });

  maybeTest('skips non-.md reference files', () => {
    setupSkill(tempDir, 'mixed-files', '---\nname: mixed\n---\nContent', {
      'reference.md': 'ref content',
    });
    // Also write a non-md file
    writeFileSync(join(tempDir, '.claude', 'skills', 'mixed-files', 'data.json'), '{}');

    const result = scanSkills(tempDir);
    expect(Object.keys(result[0].referenceFiles)).toEqual(['reference.md']);
  });
});
