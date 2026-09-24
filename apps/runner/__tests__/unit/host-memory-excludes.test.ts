/**
 * The runner host's own `~/.claude/CLAUDE.md` must not reach worker sessions.
 *
 * Worker sessions load `settingSources: ['user', ...]` because buildd skills are
 * synced into `~/.claude/skills` and discovered through the user source. The
 * same source also loads the host operator's personal memory file — whatever
 * instructions the person who runs the runner keeps for their own sessions —
 * and workers followed them (e.g. calling reporting tools that only exist on
 * the operator's machine). `claudeMdExcludes` drops the user memory files while
 * keeping user skills and settings.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/host-memory-excludes.test.ts
 */
import { describe, test, expect } from 'bun:test';
import { hostUserMemoryExcludes } from '../../src/host-memory-excludes';

describe('hostUserMemoryExcludes', () => {
  test('excludes the host user CLAUDE.md and user rules', () => {
    const ex = hostUserMemoryExcludes('/home/op', undefined);
    expect(ex).toContain('/home/op/.claude/CLAUDE.md');
    expect(ex).toContain('/home/op/.claude/rules/**');
  });

  // The user memory type is read from CLAUDE_CONFIG_DIR when it is set — a
  // runner launched with one inherits it into the worker env.
  test('also excludes the memory in an inherited CLAUDE_CONFIG_DIR', () => {
    const ex = hostUserMemoryExcludes('/home/op', '/srv/claude-cfg');
    expect(ex).toContain('/srv/claude-cfg/CLAUDE.md');
    expect(ex).toContain('/srv/claude-cfg/rules/**');
    expect(ex).toContain('/home/op/.claude/CLAUDE.md');
  });

  test('never excludes skills or project memory', () => {
    const ex = hostUserMemoryExcludes('/home/op', '/srv/claude-cfg');
    for (const p of ex) {
      expect(p).not.toContain('skills');
      expect(p.startsWith('/home/op/.claude/') || p.startsWith('/srv/claude-cfg/')).toBe(true);
    }
  });

  // Windows paths are matched with forward slashes by the CLI.
  test('normalizes separators to forward slashes', () => {
    const ex = hostUserMemoryExcludes('C:\\Users\\op', undefined);
    expect(ex).toContain('C:/Users/op/.claude/CLAUDE.md');
  });
});

// Wiring into the session options is covered behaviourally in
// role-persona-system-prompt.test.ts ("excludes the host user CLAUDE.md").
