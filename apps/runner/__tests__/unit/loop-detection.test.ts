/**
 * Unit tests for infinite loop detection
 *
 * Tests the detectRepetitiveToolCalls logic that prevents agents
 * from getting stuck making the same tool calls repeatedly.
 *
 * Run: bun test __tests__/unit
 */

import { describe, test, expect } from 'bun:test';

// Constants matching workers.ts
const MAX_IDENTICAL_TOOL_CALLS = 5;
const MAX_SIMILAR_TOOL_CALLS = 15;

// Tool call type
interface ToolCall {
  name: string;
  timestamp: number;
  input?: Record<string, unknown>;
}

// ── Mirrors of the helpers in workers.ts ────────────────────────────────────

const BENIGN_BASH_FIRST_TOKENS = new Set([
  'cd', 'ls', 'pwd', 'cat', 'head', 'tail', 'grep', 'rg', 'find', 'echo',
]);
const BENIGN_GIT_SUBCOMMANDS = new Set([
  'diff', 'log', 'show', 'status', 'branch', 'checkout', 'fetch', 'rev-parse', 'cat-file',
]);

function stripCdPrefix(cmd: string): string {
  const m = cmd.match(/^cd\s+\S+\s*(?:&&|;)\s*([\s\S]*)/);
  return m ? m[1].trimStart() : cmd.trimStart();
}

function isBenignBashCommand(cmd: string): boolean {
  const effective = stripCdPrefix(cmd);
  const tokens = effective.split(/\s+/);
  const first = tokens[0];
  if (!first) return false;
  if (BENIGN_BASH_FIRST_TOKENS.has(first)) return true;
  if (first === 'git') {
    const sub = tokens[1];
    return sub !== undefined && BENIGN_GIT_SUBCOMMANDS.has(sub);
  }
  return false;
}

// Re-implement detectRepetitiveToolCalls for testing (mirrors workers.ts)
function detectRepetitiveToolCalls(toolCalls: ToolCall[]): {
  action: 'none' | 'nudge' | 'abort';
  reason?: string;
  nudgeMessage?: string;
} {
  // Exclude benign Bash commands from all repetition counting
  const calls = toolCalls.filter(tc => {
    if (tc.name === 'Bash') return !isBenignBashCommand((tc.input?.command as string) || '');
    return true;
  });

  if (calls.length < MAX_IDENTICAL_TOOL_CALLS) {
    return { action: 'none' };
  }

  const normalizeCallKey = (tc: ToolCall) => {
    if (tc.name === 'Read') {
      return JSON.stringify({
        name: tc.name,
        file_path: tc.input?.file_path,
        offset: tc.input?.offset,
        limit: tc.input?.limit,
      });
    }
    return JSON.stringify({ name: tc.name, input: tc.input });
  };

  // Abort at 2×
  if (calls.length >= 2 * MAX_IDENTICAL_TOOL_CALLS) {
    const last2x = calls.slice(-2 * MAX_IDENTICAL_TOOL_CALLS);
    const key = normalizeCallKey(last2x[0]);
    if (last2x.every(tc => normalizeCallKey(tc) === key)) {
      return {
        action: 'abort',
        reason: `Agent stuck: made ${2 * MAX_IDENTICAL_TOOL_CALLS} identical ${last2x[0].name} calls`,
      };
    }
  }

  // Nudge at 1×
  {
    const last1x = calls.slice(-MAX_IDENTICAL_TOOL_CALLS);
    const key = normalizeCallKey(last1x[0]);
    if (last1x.every(tc => normalizeCallKey(tc) === key)) {
      return {
        action: 'nudge',
        nudgeMessage: `You've repeated the same ${last1x[0].name} call ${MAX_IDENTICAL_TOOL_CALLS} times — vary your approach or signal completion.`,
      };
    }
  }

  // Similar non-benign Bash check (full command, no 50-char truncation)
  const nonBenignBash = calls.filter(tc => tc.name === 'Bash');

  if (nonBenignBash.length >= MAX_SIMILAR_TOOL_CALLS) {
    const normalizeCmd = (cmd: string) =>
      cmd.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");

    // Abort at 2×
    if (nonBenignBash.length >= 2 * MAX_SIMILAR_TOOL_CALLS) {
      const last2x = nonBenignBash.slice(-2 * MAX_SIMILAR_TOOL_CALLS);
      const firstPattern = normalizeCmd((last2x[0].input?.command as string) || '');
      if (last2x.every(tc => normalizeCmd((tc.input?.command as string) || '') === firstPattern)) {
        return {
          action: 'abort',
          reason: `Agent stuck: made ${2 * MAX_SIMILAR_TOOL_CALLS} similar Bash commands starting with "${firstPattern.slice(0, 30)}..."`,
        };
      }
    }

    // Nudge at 1×
    const last1x = nonBenignBash.slice(-MAX_SIMILAR_TOOL_CALLS);
    const firstPattern = normalizeCmd((last1x[0].input?.command as string) || '');
    if (last1x.every(tc => normalizeCmd((tc.input?.command as string) || '') === firstPattern)) {
      return {
        action: 'nudge',
        nudgeMessage: `You've repeated a near-identical Bash command ${MAX_SIMILAR_TOOL_CALLS} times — vary your approach or signal completion.`,
      };
    }
  }

  return { action: 'none' };
}

// Helper to create tool calls
function tc(name: string, input?: Record<string, unknown>): ToolCall {
  return { name, timestamp: Date.now(), input };
}

describe('detectRepetitiveToolCalls', () => {
  describe('identical call detection — nudge then abort', () => {
    test('5 identical Read calls emit nudge (not abort)', () => {
      const calls = Array(5).fill(null).map(() => tc('Read', { file_path: '/src/app.ts' }));
      const result = detectRepetitiveToolCalls(calls);

      expect(result.action).toBe('nudge');
      expect(result.nudgeMessage).toContain('Read');
    });

    test('10 identical Read calls emit abort', () => {
      const calls = Array(10).fill(null).map(() => tc('Read', { file_path: '/src/app.ts' }));
      const result = detectRepetitiveToolCalls(calls);

      expect(result.action).toBe('abort');
      expect(result.reason).toContain('10 identical Read calls');
    });

    test('5 identical Grep calls emit nudge', () => {
      const calls = Array(5).fill(null).map(() => tc('Grep', { pattern: 'TODO', path: '/src' }));
      const result = detectRepetitiveToolCalls(calls);

      expect(result.action).toBe('nudge');
    });

    test('10 identical Grep calls emit abort', () => {
      const calls = Array(10).fill(null).map(() => tc('Grep', { pattern: 'TODO', path: '/src' }));
      const result = detectRepetitiveToolCalls(calls);

      expect(result.action).toBe('abort');
    });

    test('5 identical non-benign Bash calls emit nudge', () => {
      const calls = Array(5).fill(null).map(() => tc('Bash', { command: 'npm install' }));
      const result = detectRepetitiveToolCalls(calls);

      expect(result.action).toBe('nudge');
    });

    test('10 identical non-benign Bash calls emit abort', () => {
      const calls = Array(10).fill(null).map(() => tc('Bash', { command: 'npm install' }));
      const result = detectRepetitiveToolCalls(calls);

      expect(result.action).toBe('abort');
    });

    test('4 identical calls do not trigger', () => {
      const calls = Array(4).fill(null).map(() => tc('Read', { file_path: '/src/app.ts' }));
      const result = detectRepetitiveToolCalls(calls);

      expect(result.action).toBe('none');
    });

    test('mixed tool calls do not trigger', () => {
      const calls = [
        tc('Read', { file_path: '/src/app.ts' }),
        tc('Grep', { pattern: 'TODO' }),
        tc('Read', { file_path: '/src/app.ts' }),
        tc('Grep', { pattern: 'FIXME' }),
        tc('Read', { file_path: '/src/app.ts' }),
      ];
      const result = detectRepetitiveToolCalls(calls);

      expect(result.action).toBe('none');
    });
  });

  describe('benign Bash command exclusion', () => {
    test('15+ cd /repo && git diff with different refs do NOT trip', () => {
      const calls = Array(20).fill(null).map((_, i) =>
        tc('Bash', { command: `cd /home/coder/project/buildd && git diff dev...branch-${i}` })
      );
      const result = detectRepetitiveToolCalls(calls);

      expect(result.action).toBe('none');
    });

    test('30+ cd /repo && git diff with different refs do NOT trip', () => {
      const calls = Array(30).fill(null).map((_, i) =>
        tc('Bash', { command: `cd /home/coder/project/buildd && git diff dev...branch-${i}` })
      );
      const result = detectRepetitiveToolCalls(calls);

      expect(result.action).toBe('none');
    });

    test('15+ identical ls calls do NOT trip', () => {
      const calls = Array(20).fill(null).map(() => tc('Bash', { command: 'ls -la' }));
      const result = detectRepetitiveToolCalls(calls);

      expect(result.action).toBe('none');
    });

    test('15+ identical cat calls do NOT trip', () => {
      const calls = Array(20).fill(null).map(() => tc('Bash', { command: 'cat /repo/file.ts' }));
      const result = detectRepetitiveToolCalls(calls);

      expect(result.action).toBe('none');
    });

    test('15+ identical git status calls do NOT trip', () => {
      const calls = Array(20).fill(null).map(() => tc('Bash', { command: 'git status' }));
      const result = detectRepetitiveToolCalls(calls);

      expect(result.action).toBe('none');
    });

    test('15+ identical git log calls do NOT trip', () => {
      const calls = Array(20).fill(null).map(() =>
        tc('Bash', { command: 'git log --oneline -10' })
      );
      const result = detectRepetitiveToolCalls(calls);

      expect(result.action).toBe('none');
    });

    test('15+ identical grep calls do NOT trip', () => {
      const calls = Array(20).fill(null).map(() =>
        tc('Bash', { command: 'grep -r "pattern" /src' })
      );
      const result = detectRepetitiveToolCalls(calls);

      expect(result.action).toBe('none');
    });

    test('cd prefix stripping — git diff after cd is benign', () => {
      const calls = Array(20).fill(null).map((_, i) =>
        tc('Bash', { command: `cd /some/long/path && git diff HEAD~${i} HEAD` })
      );
      const result = detectRepetitiveToolCalls(calls);

      expect(result.action).toBe('none');
    });

    test('cd prefix stripping — git commit after cd is NOT benign (nudges at 15)', () => {
      const calls = Array(15).fill(null).map((_, i) =>
        tc('Bash', { command: `cd /repo && git commit -m "attempt ${i}"` })
      );
      const result = detectRepetitiveToolCalls(calls);

      // quote-normalized to same pattern → nudge
      expect(result.action).toBe('nudge');
    });

    test('benign commands do not dilute identical-check for non-benign tools', () => {
      // 5 identical Read calls + 10 benign Bash calls
      const calls = [
        ...Array(5).fill(null).map(() => tc('Read', { file_path: '/src/app.ts' })),
        ...Array(10).fill(null).map(() => tc('Bash', { command: 'ls -la' })),
      ];
      const result = detectRepetitiveToolCalls(calls);

      // After filtering benign Bash, we have 5 identical Reads → nudge
      expect(result.action).toBe('nudge');
    });
  });

  describe('Read tool special handling', () => {
    test('allows reading different sections of same file', () => {
      const calls = [
        tc('Read', { file_path: '/src/big.ts', offset: 0, limit: 100 }),
        tc('Read', { file_path: '/src/big.ts', offset: 100, limit: 100 }),
        tc('Read', { file_path: '/src/big.ts', offset: 200, limit: 100 }),
        tc('Read', { file_path: '/src/big.ts', offset: 300, limit: 100 }),
        tc('Read', { file_path: '/src/big.ts', offset: 400, limit: 100 }),
      ];
      const result = detectRepetitiveToolCalls(calls);

      expect(result.action).toBe('none');
    });

    test('detects reading same section 5 times — nudge first', () => {
      const calls = Array(5).fill(null).map(() =>
        tc('Read', { file_path: '/src/big.ts', offset: 100, limit: 50 })
      );
      const result = detectRepetitiveToolCalls(calls);

      expect(result.action).toBe('nudge');
    });

    test('detects reading same section 10 times — abort', () => {
      const calls = Array(10).fill(null).map(() =>
        tc('Read', { file_path: '/src/big.ts', offset: 100, limit: 50 })
      );
      const result = detectRepetitiveToolCalls(calls);

      expect(result.action).toBe('abort');
    });

    test('allows reading different files', () => {
      const calls = [
        tc('Read', { file_path: '/src/a.ts' }),
        tc('Read', { file_path: '/src/b.ts' }),
        tc('Read', { file_path: '/src/c.ts' }),
        tc('Read', { file_path: '/src/d.ts' }),
        tc('Read', { file_path: '/src/e.ts' }),
      ];
      const result = detectRepetitiveToolCalls(calls);

      expect(result.action).toBe('none');
    });

    test('Read without offset/limit is distinct from Read with offset', () => {
      const calls = [
        tc('Read', { file_path: '/src/app.ts' }),
        tc('Read', { file_path: '/src/app.ts', offset: 0 }),
        tc('Read', { file_path: '/src/app.ts', limit: 100 }),
        tc('Read', { file_path: '/src/app.ts', offset: 0, limit: 100 }),
        tc('Read', { file_path: '/src/app.ts' }),
      ];
      const result = detectRepetitiveToolCalls(calls);

      expect(result.action).toBe('none');
    });
  });

  describe('similar Bash command detection — raised threshold + full comparison', () => {
    test('15 similar git commit commands emit nudge', () => {
      const calls = Array(15).fill(null).map((_, i) =>
        tc('Bash', { command: `git commit -m "fix: bug ${i}"` })
      );
      const result = detectRepetitiveToolCalls(calls);

      expect(result.action).toBe('nudge');
      expect(result.nudgeMessage).toContain('15');
    });

    test('30 similar git commit commands emit abort', () => {
      const calls = Array(30).fill(null).map((_, i) =>
        tc('Bash', { command: `git commit -m "fix: bug ${i}"` })
      );
      const result = detectRepetitiveToolCalls(calls);

      expect(result.action).toBe('abort');
      expect(result.reason).toContain('30 similar Bash commands');
    });

    test('14 similar Bash commands do not trigger', () => {
      const calls = Array(14).fill(null).map((_, i) =>
        tc('Bash', { command: `git commit -m "fix ${i}"` })
      );
      const result = detectRepetitiveToolCalls(calls);

      expect(result.action).toBe('none');
    });

    test('commands with quoted args normalize to same pattern → nudge at 15', () => {
      const calls = Array(15).fill(null).map((_, i) =>
        tc('Bash', { command: `npm install "package-${i}"` })
      );
      const result = detectRepetitiveToolCalls(calls);

      expect(result.action).toBe('nudge');
    });

    test('genuinely different npm install targets (unquoted) do not trip', () => {
      const calls = Array(15).fill(null).map((_, i) =>
        tc('Bash', { command: `npm install package-${i}` })
      );
      const result = detectRepetitiveToolCalls(calls);

      expect(result.action).toBe('none');
    });

    test('different Bash commands do not trigger', () => {
      const calls = [
        tc('Bash', { command: 'npm install' }),
        tc('Bash', { command: 'npm run build' }),
        tc('Bash', { command: 'npm test' }),
        tc('Bash', { command: 'git add .' }),
        tc('Bash', { command: 'git commit -m "fix"' }),
        tc('Bash', { command: 'git push' }),
        tc('Bash', { command: 'npm run lint' }),
        tc('Bash', { command: 'bun run typecheck' }),
      ];
      const result = detectRepetitiveToolCalls(calls);

      expect(result.action).toBe('none');
    });

    test('echo (benign) with single-quoted args: 15 calls do NOT trip', () => {
      const calls = Array(15).fill(null).map((_, i) =>
        tc('Bash', { command: `echo 'message ${i}'` })
      );
      const result = detectRepetitiveToolCalls(calls);

      // echo is BENIGN → excluded → none
      expect(result.action).toBe('none');
    });

    test('non-benign commands with single-quoted args that normalize to same pattern', () => {
      const calls = Array(15).fill(null).map((_, i) =>
        tc('Bash', { command: `git commit -m 'msg ${i}'` })
      );
      const result = detectRepetitiveToolCalls(calls);

      // Normalized to: git commit -m '' → all same → nudge
      expect(result.action).toBe('nudge');
    });

    test('full command comparison — commands differing beyond 50 chars are distinct (no truncation)', () => {
      // These share > 50 chars of common prefix but differ at the end
      const longPrefix = 'a'.repeat(40);
      const calls = Array(15).fill(null).map((_, i) =>
        tc('Bash', { command: `${longPrefix} extra-${i}` })
      );
      const result = detectRepetitiveToolCalls(calls);

      // Without truncation each command is different → no trip
      // (longPrefix starts with 'a' which is not a benign command, so these count)
      expect(result.action).toBe('none');
    });
  });

  describe('edge cases', () => {
    test('returns none for empty tool calls', () => {
      const result = detectRepetitiveToolCalls([]);
      expect(result.action).toBe('none');
    });

    test('returns none for single tool call', () => {
      const result = detectRepetitiveToolCalls([tc('Read', { file_path: '/a.ts' })]);
      expect(result.action).toBe('none');
    });

    test('5 tool calls without input → nudge', () => {
      const calls = Array(5).fill(null).map(() => tc('SomeTool'));
      const result = detectRepetitiveToolCalls(calls);

      expect(result.action).toBe('nudge');
    });

    test('10 tool calls without input → abort', () => {
      const calls = Array(10).fill(null).map(() => tc('SomeTool'));
      const result = detectRepetitiveToolCalls(calls);

      expect(result.action).toBe('abort');
    });

    test('identical detection uses last 5 of recent non-benign calls', () => {
      const calls = [
        tc('Grep', { pattern: 'a' }),
        tc('Grep', { pattern: 'b' }),
        tc('Grep', { pattern: 'c' }),
        tc('Read', { file_path: '/same.ts' }),
        tc('Read', { file_path: '/same.ts' }),
        tc('Read', { file_path: '/same.ts' }),
        tc('Read', { file_path: '/same.ts' }),
        tc('Read', { file_path: '/same.ts' }),
      ];
      const result = detectRepetitiveToolCalls(calls);

      expect(result.action).toBe('nudge');
    });

    test('benign-only history never triggers even at 50+ calls', () => {
      const calls = Array(50).fill(null).map((_, i) =>
        tc('Bash', { command: `ls /dir-${i}` })
      );
      const result = detectRepetitiveToolCalls(calls);

      expect(result.action).toBe('none');
    });
  });

  describe('realistic scenarios', () => {
    test('normal investigation workflow does not trigger', () => {
      const calls = [
        tc('Bash', { command: 'cd /repo && git log --oneline -20' }),
        tc('Read', { file_path: '/src/index.ts' }),
        tc('Bash', { command: 'cd /repo && git diff HEAD~1' }),
        tc('Read', { file_path: '/src/utils.ts' }),
        tc('Read', { file_path: '/src/types.ts' }),
        tc('Edit', { file_path: '/src/index.ts', old_string: 'a', new_string: 'b' }),
        tc('Bash', { command: 'bun test' }),
        tc('Read', { file_path: '/src/index.ts' }),
      ];
      const result = detectRepetitiveToolCalls(calls);

      expect(result.action).toBe('none');
    });

    test('recon worker exploring many branches via cd && git diff does NOT trigger', () => {
      // Exact reproduction of the false-positive that motivated this fix
      const calls = Array(20).fill(null).map((_, i) =>
        tc('Bash', { command: `cd /home/coder/project/buildd && git diff dev...buildd/branch-${i}` })
      );
      const result = detectRepetitiveToolCalls(calls);

      expect(result.action).toBe('none');
    });

    test('genuine commit retry loop: nudge at 15, abort at 30', () => {
      const allCalls = Array(30).fill(null).map((_, i) =>
        tc('Bash', { command: `git commit -m "retry ${i}"` })
      );

      const nudgeResult = detectRepetitiveToolCalls(allCalls.slice(0, 15));
      expect(nudgeResult.action).toBe('nudge');

      const abortResult = detectRepetitiveToolCalls(allCalls);
      expect(abortResult.action).toBe('abort');
    });

    test('stuck reading same error log: nudge at 5, abort at 10', () => {
      const allCalls = Array(10).fill(null).map(() =>
        tc('Read', { file_path: '/var/log/error.log' })
      );

      const nudgeResult = detectRepetitiveToolCalls(allCalls.slice(0, 5));
      expect(nudgeResult.action).toBe('nudge');

      const abortResult = detectRepetitiveToolCalls(allCalls);
      expect(abortResult.action).toBe('abort');
    });

    test('benign exploration interleaved with non-benign commits still triggers', () => {
      // 15 git commit calls (non-benign) interspersed with benign ls calls
      const commits = Array(15).fill(null).map((_, i) =>
        tc('Bash', { command: `git commit -m "stuck ${i}"` })
      );
      const explores = Array(30).fill(null).map(() => tc('Bash', { command: 'ls -la' }));
      // Interleave: commit, explore, explore, commit, …
      const calls: ToolCall[] = [];
      for (let i = 0; i < 15; i++) {
        calls.push(commits[i]);
        calls.push(explores[i * 2]);
        calls.push(explores[i * 2 + 1]);
      }
      const result = detectRepetitiveToolCalls(calls);

      // After filtering benign Bash, 15 identical-pattern commits remain → nudge
      expect(result.action).toBe('nudge');
    });
  });
});
