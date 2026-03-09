import { describe, it, expect } from 'bun:test';
import {
  MODEL_OPTIONS,
  normalizeSkillSlug,
  validateSkillSlug,
  validateOutputSchema,
  buildWorkspaceOptions,
  hasWorkspaceChanged,
} from './config-helpers';

describe('config-helpers', () => {
  describe('MODEL_OPTIONS', () => {
    it('has a default (empty string) option first', () => {
      expect(MODEL_OPTIONS[0]).toEqual({ value: '', label: 'Default' });
    });

    it('contains only valid model IDs', () => {
      for (const opt of MODEL_OPTIONS) {
        expect(typeof opt.value).toBe('string');
        expect(typeof opt.label).toBe('string');
        expect(opt.label.length).toBeGreaterThan(0);
      }
    });

    it('has unique values', () => {
      const values = MODEL_OPTIONS.map((o) => o.value);
      // '' appears once for default; all non-empty should be unique
      const nonEmpty = values.filter(Boolean);
      expect(new Set(nonEmpty).size).toBe(nonEmpty.length);
    });
  });

  describe('normalizeSkillSlug', () => {
    it('lowercases and trims input', () => {
      expect(normalizeSkillSlug('  My Skill  ')).toBe('my-skill');
    });

    it('replaces non-alphanumeric chars with dashes', () => {
      expect(normalizeSkillSlug('hello_world!')).toBe('hello-world');
    });

    it('strips one leading and one trailing dash', () => {
      // The regex /^-|-$/g strips a single leading and trailing dash
      expect(normalizeSkillSlug('-foo-')).toBe('foo');
      // Multiple leading/trailing dashes: only outermost removed
      expect(normalizeSkillSlug('--foo--')).toBe('-foo-');
    });

    it('handles special characters', () => {
      expect(normalizeSkillSlug('my@skill#v2')).toBe('my-skill-v2');
    });

    it('returns empty string for whitespace-only input', () => {
      expect(normalizeSkillSlug('   ')).toBe('');
    });

    it('returns empty string for empty input', () => {
      expect(normalizeSkillSlug('')).toBe('');
    });

    it('preserves numbers and dashes', () => {
      expect(normalizeSkillSlug('skill-123')).toBe('skill-123');
    });

    it('collapses multiple special chars into dashes', () => {
      expect(normalizeSkillSlug('a!!b')).toBe('a--b');
    });
  });

  describe('validateSkillSlug', () => {
    it('returns null for a valid, new slug', () => {
      expect(validateSkillSlug('my-skill', [])).toBeNull();
    });

    it('returns error for empty input', () => {
      expect(validateSkillSlug('', [])).toBe('Skill slug cannot be empty');
    });

    it('returns error for whitespace-only input', () => {
      expect(validateSkillSlug('   ', [])).toBe('Skill slug cannot be empty');
    });

    it('returns error for duplicate slug', () => {
      expect(validateSkillSlug('my-skill', ['my-skill'])).toBe(
        'Skill already exists'
      );
    });

    it('normalizes before checking duplicates', () => {
      // 'My Skill' normalizes to 'my-skill'
      expect(validateSkillSlug('My Skill', ['my-skill'])).toBe(
        'Skill already exists'
      );
    });

    it('allows a slug that is not in the existing list', () => {
      expect(validateSkillSlug('new-skill', ['existing-skill'])).toBeNull();
    });
  });

  describe('validateOutputSchema', () => {
    it('returns valid with null parsed for empty string', () => {
      const result = validateOutputSchema('');
      expect(result).toEqual({ valid: true, parsed: null, formatted: '' });
    });

    it('returns valid with null parsed for whitespace-only string', () => {
      const result = validateOutputSchema('   ');
      expect(result).toEqual({ valid: true, parsed: null, formatted: '' });
    });

    it('parses and re-formats valid JSON object', () => {
      const result = validateOutputSchema('{"type":"object"}');
      expect(result).toEqual({
        valid: true,
        parsed: { type: 'object' },
        formatted: JSON.stringify({ type: 'object' }, null, 2),
      });
    });

    it('parses valid JSON array', () => {
      const result = validateOutputSchema('[1, 2, 3]');
      expect(result).toEqual({
        valid: true,
        parsed: [1, 2, 3],
        formatted: JSON.stringify([1, 2, 3], null, 2),
      });
    });

    it('parses valid JSON with nested structure', () => {
      const input = '{"properties": {"name": {"type": "string"}}}';
      const result = validateOutputSchema(input);
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.parsed).toEqual({
          properties: { name: { type: 'string' } },
        });
      }
    });

    it('returns error for invalid JSON', () => {
      const result = validateOutputSchema('{not valid json}');
      expect(result).toEqual({ valid: false, error: 'Invalid JSON' });
    });

    it('returns error for truncated JSON', () => {
      const result = validateOutputSchema('{"type":');
      expect(result).toEqual({ valid: false, error: 'Invalid JSON' });
    });

    it('trims whitespace before parsing', () => {
      const result = validateOutputSchema('  {"a": 1}  ');
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.parsed).toEqual({ a: 1 });
      }
    });

    it('handles JSON primitives', () => {
      expect(validateOutputSchema('"hello"').valid).toBe(true);
      expect(validateOutputSchema('42').valid).toBe(true);
      expect(validateOutputSchema('true').valid).toBe(true);
      expect(validateOutputSchema('null').valid).toBe(true);
    });
  });

  describe('buildWorkspaceOptions', () => {
    it('returns only "No workspace" option for empty list', () => {
      expect(buildWorkspaceOptions([])).toEqual([
        { value: '', label: 'No workspace' },
      ]);
    });

    it('prepends "No workspace" to workspace list', () => {
      const workspaces = [
        { id: 'ws-1', name: 'Workspace 1' },
        { id: 'ws-2', name: 'Workspace 2' },
      ];
      const result = buildWorkspaceOptions(workspaces);
      expect(result).toEqual([
        { value: '', label: 'No workspace' },
        { value: 'ws-1', label: 'Workspace 1' },
        { value: 'ws-2', label: 'Workspace 2' },
      ]);
    });

    it('preserves workspace order', () => {
      const workspaces = [
        { id: 'b', name: 'Beta' },
        { id: 'a', name: 'Alpha' },
      ];
      const result = buildWorkspaceOptions(workspaces);
      expect(result[1].value).toBe('b');
      expect(result[2].value).toBe('a');
    });
  });

  describe('hasWorkspaceChanged', () => {
    it('returns false when selected matches original', () => {
      expect(hasWorkspaceChanged('ws-1', 'ws-1')).toBe(false);
    });

    it('returns true when selected differs from original', () => {
      expect(hasWorkspaceChanged('ws-2', 'ws-1')).toBe(true);
    });

    it('returns false when both are empty/null', () => {
      expect(hasWorkspaceChanged('', null)).toBe(false);
    });

    it('returns true when selecting a workspace from null', () => {
      expect(hasWorkspaceChanged('ws-1', null)).toBe(true);
    });

    it('returns true when clearing a workspace', () => {
      expect(hasWorkspaceChanged('', 'ws-1')).toBe(true);
    });
  });
});
