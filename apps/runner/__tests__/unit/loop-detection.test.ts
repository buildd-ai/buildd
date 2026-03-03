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
const MAX_SIMILAR_TOOL_CALLS = 8;

// Tool call type
interface ToolCall {
  name: string;
  timestamp: number;
  input?: Record<string, unknown>;
}

// Re-implement detectRepetitiveToolCalls for testing (mirrors workers.ts)
function detectRepetitiveToolCalls(toolCalls: ToolCall[]): { isRepetitive: boolean; reason?: string } {
  const recentCalls = toolCalls.slice(-MAX_SIMILAR_TOOL_CALLS);
  if (recentCalls.length < MAX_IDENTICAL_TOOL_CALLS) {
    return { isRepetitive: false };
  }

  // Check for identical consecutive tool calls
  const lastCalls = recentCalls.slice(-MAX_IDENTICAL_TOOL_CALLS);

  const normalizeCallKey = (tc: ToolCall) => {
    if (tc.name === 'Read') {
      // For Read, include offset+limit so different sections are distinct
      return JSON.stringify({
        name: tc.name,
        file_path: tc.input?.file_path,
        offset: tc.input?.offset,
        limit: tc.input?.limit,
      });
    }
    return JSON.stringify({ name: tc.name, input: tc.input });
  };

  const lastCallKey = normalizeCallKey(lastCalls[0]);
  const allIdentical = lastCalls.every(tc => normalizeCallKey(tc) === lastCallKey);

  if (allIdentical) {
    return {
      isRepetitive: true,
      reason: `Agent stuck: made ${MAX_IDENTICAL_TOOL_CALLS} identical ${lastCalls[0].name} calls`,
    };
  }

  // Check for similar consecutive Bash commands
  if (recentCalls.length >= MAX_SIMILAR_TOOL_CALLS) {
    const toolName = recentCalls[0].name;
    const allSameTool = recentCalls.every(tc => tc.name === toolName);
    if (allSameTool && toolName === 'Bash') {
      const commands = recentCalls.map(tc => (tc.input?.command as string) || '');
      const patterns = commands.map(cmd => {
        return cmd
          .replace(/"[^"]*"/g, '""')
          .replace(/'[^']*'/g, "''")
          .slice(0, 50);
      });
      const firstPattern = patterns[0];
      const allSimilar = patterns.every(p => p === firstPattern);
      if (allSimilar) {
        return {
          isRepetitive: true,
          reason: `Agent stuck: made ${MAX_SIMILAR_TOOL_CALLS} similar Bash commands starting with "${firstPattern.slice(0, 30)}..."`,
        };
      }
    }
  }

  return { isRepetitive: false };
}

// Helper to create tool calls
function tc(name: string, input?: Record<string, unknown>): ToolCall {
  return { name, timestamp: Date.now(), input };
}

describe('detectRepetitiveToolCalls', () => {
  describe('identical call detection', () => {
    test('detects 5 identical Read calls to same file', () => {
      const calls = Array(5).fill(null).map(() => tc('Read', { file_path: '/src/app.ts' }));
      const result = detectRepetitiveToolCalls(calls);

      expect(result.isRepetitive).toBe(true);
      expect(result.reason).toContain('5 identical Read calls');
    });

    test('detects 5 identical Grep calls', () => {
      const calls = Array(5).fill(null).map(() => tc('Grep', { pattern: 'TODO', path: '/src' }));
      const result = detectRepetitiveToolCalls(calls);

      expect(result.isRepetitive).toBe(true);
      expect(result.reason).toContain('5 identical Grep calls');
    });

    test('detects 5 identical Glob calls', () => {
      const calls = Array(5).fill(null).map(() => tc('Glob', { pattern: '**/*.ts' }));
      const result = detectRepetitiveToolCalls(calls);

      expect(result.isRepetitive).toBe(true);
      expect(result.reason).toContain('5 identical Glob calls');
    });

    test('does not trigger for 4 identical calls', () => {
      const calls = Array(4).fill(null).map(() => tc('Read', { file_path: '/src/app.ts' }));
      const result = detectRepetitiveToolCalls(calls);

      expect(result.isRepetitive).toBe(false);
    });

    test('does not trigger for mixed tool calls', () => {
      const calls = [
        tc('Read', { file_path: '/src/app.ts' }),
        tc('Grep', { pattern: 'TODO' }),
        tc('Read', { file_path: '/src/app.ts' }),
        tc('Grep', { pattern: 'FIXME' }),
        tc('Read', { file_path: '/src/app.ts' }),
      ];
      const result = detectRepetitiveToolCalls(calls);

      expect(result.isRepetitive).toBe(false);
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

      expect(result.isRepetitive).toBe(false);
    });

    test('detects reading same section repeatedly', () => {
      const calls = Array(5).fill(null).map(() =>
        tc('Read', { file_path: '/src/big.ts', offset: 100, limit: 50 })
      );
      const result = detectRepetitiveToolCalls(calls);

      expect(result.isRepetitive).toBe(true);
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

      expect(result.isRepetitive).toBe(false);
    });

    test('Read without offset/limit treated as distinct from Read with offset', () => {
      const calls = [
        tc('Read', { file_path: '/src/app.ts' }),
        tc('Read', { file_path: '/src/app.ts', offset: 0 }),
        tc('Read', { file_path: '/src/app.ts', limit: 100 }),
        tc('Read', { file_path: '/src/app.ts', offset: 0, limit: 100 }),
        tc('Read', { file_path: '/src/app.ts' }),
      ];
      const result = detectRepetitiveToolCalls(calls);

      // These are all different because offset/limit values differ
      expect(result.isRepetitive).toBe(false);
    });
  });

  describe('similar Bash command detection', () => {
    test('detects 8 similar git commit commands', () => {
      const calls = [
        tc('Bash', { command: 'git commit -m "fix: bug 1"' }),
        tc('Bash', { command: 'git commit -m "fix: bug 2"' }),
        tc('Bash', { command: 'git commit -m "fix: bug 3"' }),
        tc('Bash', { command: 'git commit -m "fix: bug 4"' }),
        tc('Bash', { command: 'git commit -m "fix: bug 5"' }),
        tc('Bash', { command: 'git commit -m "fix: bug 6"' }),
        tc('Bash', { command: 'git commit -m "fix: bug 7"' }),
        tc('Bash', { command: 'git commit -m "fix: bug 8"' }),
      ];
      const result = detectRepetitiveToolCalls(calls);

      expect(result.isRepetitive).toBe(true);
      expect(result.reason).toContain('8 similar Bash commands');
    });

    test('detects repeated npm install with same prefix', () => {
      // Use quoted strings so they get normalized to same pattern
      const calls = Array(8).fill(null).map((_, i) =>
        tc('Bash', { command: `npm install "package-${i}"` })
      );
      const result = detectRepetitiveToolCalls(calls);

      // Quoted strings normalized to "" so patterns match
      expect(result.isRepetitive).toBe(true);
    });

    test('different npm install targets not detected as loop', () => {
      // Without quotes, these are genuinely different commands
      const calls = Array(8).fill(null).map((_, i) =>
        tc('Bash', { command: `npm install package-${i}` })
      );
      const result = detectRepetitiveToolCalls(calls);

      // Each has different suffix, so first 50 chars differ
      expect(result.isRepetitive).toBe(false);
    });

    test('does not trigger for 7 similar Bash commands', () => {
      const calls = Array(7).fill(null).map((_, i) =>
        tc('Bash', { command: `git commit -m "fix ${i}"` })
      );
      const result = detectRepetitiveToolCalls(calls);

      expect(result.isRepetitive).toBe(false);
    });

    test('does not trigger for different Bash commands', () => {
      const calls = [
        tc('Bash', { command: 'npm install' }),
        tc('Bash', { command: 'npm run build' }),
        tc('Bash', { command: 'npm test' }),
        tc('Bash', { command: 'git status' }),
        tc('Bash', { command: 'git add .' }),
        tc('Bash', { command: 'git commit -m "fix"' }),
        tc('Bash', { command: 'git push' }),
        tc('Bash', { command: 'npm run lint' }),
      ];
      const result = detectRepetitiveToolCalls(calls);

      expect(result.isRepetitive).toBe(false);
    });

    test('handles commands with single quotes', () => {
      const calls = Array(8).fill(null).map((_, i) =>
        tc('Bash', { command: `echo 'message ${i}'` })
      );
      const result = detectRepetitiveToolCalls(calls);

      // Single quotes normalized to ''
      expect(result.isRepetitive).toBe(true);
    });
  });

  describe('edge cases', () => {
    test('returns false for empty tool calls', () => {
      const result = detectRepetitiveToolCalls([]);
      expect(result.isRepetitive).toBe(false);
    });

    test('returns false for single tool call', () => {
      const result = detectRepetitiveToolCalls([tc('Read', { file_path: '/a.ts' })]);
      expect(result.isRepetitive).toBe(false);
    });

    test('handles tool calls without input', () => {
      const calls = Array(5).fill(null).map(() => tc('SomeTool'));
      const result = detectRepetitiveToolCalls(calls);

      expect(result.isRepetitive).toBe(true);
    });

    test('only checks last 8 calls for similar detection', () => {
      // 10 different calls followed by 7 similar - should not trigger
      const differentCalls = Array(10).fill(null).map((_, i) =>
        tc('Read', { file_path: `/file${i}.ts` })
      );
      const similarCalls = Array(7).fill(null).map((_, i) =>
        tc('Bash', { command: `git commit -m "msg ${i}"` })
      );
      const result = detectRepetitiveToolCalls([...differentCalls, ...similarCalls]);

      expect(result.isRepetitive).toBe(false);
    });

    test('identical detection uses last 5 of recent 8', () => {
      // Some different calls, then 5 identical at the end
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

      expect(result.isRepetitive).toBe(true);
    });

    test('bash command comparison uses first 50 chars', () => {
      // Long commands that differ after first 50 chars
      const prefix = 'a'.repeat(50);
      const calls = [
        tc('Bash', { command: `${prefix}aaa` }),
        tc('Bash', { command: `${prefix}bbb` }),
        tc('Bash', { command: `${prefix}ccc` }),
        tc('Bash', { command: `${prefix}ddd` }),
        tc('Bash', { command: `${prefix}eee` }),
        tc('Bash', { command: `${prefix}fff` }),
        tc('Bash', { command: `${prefix}ggg` }),
        tc('Bash', { command: `${prefix}hhh` }),
      ];
      const result = detectRepetitiveToolCalls(calls);

      // All have same first 50 chars
      expect(result.isRepetitive).toBe(true);
    });
  });

  describe('realistic scenarios', () => {
    test('normal investigation workflow does not trigger', () => {
      const calls = [
        tc('Glob', { pattern: '**/*.ts' }),
        tc('Read', { file_path: '/src/index.ts' }),
        tc('Grep', { pattern: 'function main' }),
        tc('Read', { file_path: '/src/utils.ts' }),
        tc('Read', { file_path: '/src/types.ts' }),
        tc('Edit', { file_path: '/src/index.ts', old_string: 'a', new_string: 'b' }),
        tc('Bash', { command: 'npm test' }),
        tc('Read', { file_path: '/src/index.ts' }),
      ];
      const result = detectRepetitiveToolCalls(calls);

      expect(result.isRepetitive).toBe(false);
    });

    test('stuck reading same error file triggers', () => {
      // Agent keeps reading error log trying to understand
      const calls = [
        tc('Read', { file_path: '/var/log/error.log' }),
        tc('Bash', { command: 'npm test' }),
        tc('Read', { file_path: '/var/log/error.log' }),
        tc('Bash', { command: 'npm test' }),
        tc('Read', { file_path: '/var/log/error.log' }),
        tc('Read', { file_path: '/var/log/error.log' }),
        tc('Read', { file_path: '/var/log/error.log' }),
        tc('Read', { file_path: '/var/log/error.log' }),
        tc('Read', { file_path: '/var/log/error.log' }),
      ];
      const result = detectRepetitiveToolCalls(calls);

      expect(result.isRepetitive).toBe(true);
    });

    test('retry loop with failed commits triggers', () => {
      // Agent keeps trying to commit after failures
      const calls = [
        tc('Bash', { command: 'git add .' }),
        tc('Bash', { command: 'git commit -m "attempt 1"' }),
        tc('Bash', { command: 'git commit -m "attempt 2"' }),
        tc('Bash', { command: 'git commit -m "attempt 3"' }),
        tc('Bash', { command: 'git commit -m "attempt 4"' }),
        tc('Bash', { command: 'git commit -m "attempt 5"' }),
        tc('Bash', { command: 'git commit -m "attempt 6"' }),
        tc('Bash', { command: 'git commit -m "attempt 7"' }),
        tc('Bash', { command: 'git commit -m "attempt 8"' }),
      ];
      const result = detectRepetitiveToolCalls(calls);

      expect(result.isRepetitive).toBe(true);
    });
  });
});
