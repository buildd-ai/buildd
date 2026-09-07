/**
 * Unit tests for PR-mutation deny (pr-mutation-enforcement.ts).
 *
 * Covers: the role/hasApiKey gate, the shell deny list, the connector
 * tool-name deny list, and that an unrelated role/session is left alone.
 */

import { describe, test, expect } from 'bun:test';
import {
  shouldDenyPrMutation,
  applyPrMutationDeny,
  PR_MUTATION_BASH_DENY,
  GITHUB_MCP_PR_WRITE_TOOLS,
} from '../../src/pr-mutation-enforcement';

describe('shouldDenyPrMutation', () => {
  test('true for builder with an API key configured', () => {
    expect(shouldDenyPrMutation('builder', true)).toBe(true);
  });

  test('false for builder with no API key (gh pr create is the only fallback)', () => {
    expect(shouldDenyPrMutation('builder', false)).toBe(false);
  });

  test('false for organizer, even with an API key — explicitly out of scope', () => {
    expect(shouldDenyPrMutation('organizer', true)).toBe(false);
  });

  test('false for reviewer, researcher, and any other non-denied role', () => {
    expect(shouldDenyPrMutation('reviewer', true)).toBe(false);
    expect(shouldDenyPrMutation('researcher', true)).toBe(false);
    expect(shouldDenyPrMutation('analyst', true)).toBe(false);
  });

  test('false when roleSlug is undefined', () => {
    expect(shouldDenyPrMutation(undefined, true)).toBe(false);
  });
});

describe('applyPrMutationDeny', () => {
  test('no-op for a role the deny does not apply to', () => {
    const result = applyPrMutationDeny(['Bash(rm:*)'], {
      roleSlug: 'organizer',
      hasApiKey: true,
      mountedServerNames: ['buildd'],
    });
    expect(result).toEqual(['Bash(rm:*)']);
  });

  test('no-op for builder with no API key', () => {
    const result = applyPrMutationDeny(undefined, {
      roleSlug: 'builder',
      hasApiKey: false,
      mountedServerNames: ['buildd'],
    });
    expect(result).toEqual([]);
  });

  test('adds the full Bash subcommand deny list for builder with an API key', () => {
    const result = applyPrMutationDeny(undefined, {
      roleSlug: 'builder',
      hasApiKey: true,
      mountedServerNames: ['buildd'],
    });
    for (const rule of PR_MUTATION_BASH_DENY) {
      expect(result).toContain(rule);
    }
  });

  test('leaves read-only gh pr usage unaddressed (no rule for view/list/checks)', () => {
    const result = applyPrMutationDeny(undefined, {
      roleSlug: 'builder',
      hasApiKey: true,
      mountedServerNames: [],
    });
    expect(result.some(r => r.includes('gh pr view'))).toBe(false);
    expect(result.some(r => r.includes('gh pr list'))).toBe(false);
    expect(result.some(r => r.includes('gh pr checks'))).toBe(false);
  });

  test('denies known PR-write tool names on every mounted connector, by tool name not connector name', () => {
    const result = applyPrMutationDeny(undefined, {
      roleSlug: 'builder',
      hasApiKey: true,
      mountedServerNames: ['buildd', 'some-github-connector', 'codebase-memory'],
    });
    for (const server of ['some-github-connector', 'codebase-memory']) {
      for (const tool of GITHUB_MCP_PR_WRITE_TOOLS) {
        expect(result).toContain(`mcp__${server}__${tool}`);
      }
    }
  });

  test('never denies a buildd-namespaced tool', () => {
    const result = applyPrMutationDeny(undefined, {
      roleSlug: 'builder',
      hasApiKey: true,
      mountedServerNames: ['buildd'],
    });
    expect(result.some(r => r.startsWith('mcp__buildd__'))).toBe(false);
  });

  test('is idempotent / de-duplicates against an existing list', () => {
    const once = applyPrMutationDeny(undefined, {
      roleSlug: 'builder',
      hasApiKey: true,
      mountedServerNames: ['buildd'],
    });
    const twice = applyPrMutationDeny(once, {
      roleSlug: 'builder',
      hasApiKey: true,
      mountedServerNames: ['buildd'],
    });
    expect(new Set(twice).size).toBe(twice.length);
    expect(twice.length).toBe(once.length);
  });

  test('preserves an unrelated existing disallowedTools entry (e.g. CBM blocklist)', () => {
    const result = applyPrMutationDeny(['mcp__codebase-memory__delete_project'], {
      roleSlug: 'builder',
      hasApiKey: true,
      mountedServerNames: ['buildd'],
    });
    expect(result).toContain('mcp__codebase-memory__delete_project');
  });
});
