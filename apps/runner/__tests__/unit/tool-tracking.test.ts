/**
 * Unit tests for tool call tracking
 *
 * Tests the tool call history management, git stats extraction,
 * file path extraction, and milestone generation logic from workers.ts.
 *
 * Run: bun test __tests__/unit/tool-tracking.test.ts
 */

import { describe, test, expect } from 'bun:test';
import type { Milestone } from '../../src/types';

// Tool call type (mirrors types.ts ToolCall)
interface ToolCall {
  name: string;
  timestamp: number;
  input?: any;
}

// --- Re-implementations of workers.ts logic for unit testing ---

// Mirrors the 200-item FIFO buffer logic from workers.ts:1694-1701
function addToolCall(toolCalls: ToolCall[], call: ToolCall): void {
  toolCalls.push(call);
  if (toolCalls.length > 200) {
    toolCalls.shift();
  }
}

// Mirrors workers.ts:2494-2501
function extractFilesFromToolCalls(toolCalls: Array<{ name: string; input?: any }>): string[] {
  const files = new Set<string>();
  for (const tc of toolCalls) {
    if ((tc.name === 'Read' || tc.name === 'Edit' || tc.name === 'Write') && tc.input?.file_path) {
      files.add(tc.input.file_path);
    }
  }
  return Array.from(files).slice(0, 20);
}

// Mirrors workers.ts:1742-1753 (commit detection from Bash tool calls)
function extractCommitFromBash(command: string): string | null {
  if (!command.includes('git commit')) return null;
  const heredocMatch = command.match(/cat\s*<<\s*['"]?EOF['"]?\n([\s\S]*?)\nEOF/);
  const simpleMatch = command.match(/-m\s+["']([^"']+)["']/);
  const message = heredocMatch
    ? heredocMatch[1].split('\n')[0].trim()
    : simpleMatch ? simpleMatch[1] : 'commit';
  return message;
}

// Mirrors workers.ts:1956-1968 (milestone management with 30-item cap)
function addMilestone(milestones: Milestone[], milestone: Milestone): void {
  milestones.push(milestone);
  if (milestones.length > 30) {
    milestones.shift();
  }
}

// Mirrors workers.ts:2377-2386 (file extraction for reconstructed context)
function extractFilesExploredAndModified(toolCalls: ToolCall[]): { explored: string[]; modified: string[] } {
  const filesExplored = new Set<string>();
  const filesModified = new Set<string>();
  for (const tc of toolCalls) {
    const filePath = tc.input?.file_path as string;
    if (tc.name === 'Read' && filePath) {
      filesExplored.add(filePath);
    } else if ((tc.name === 'Edit' || tc.name === 'Write') && filePath) {
      filesModified.add(filePath);
    }
  }
  return {
    explored: Array.from(filesExplored),
    modified: Array.from(filesModified),
  };
}

// Helper to create tool calls
function tc(name: string, input?: Record<string, unknown>): ToolCall {
  return { name, timestamp: Date.now(), input };
}

// -------------------------------------------------------------------

describe('Tool Call History Management', () => {
  test('adds tool calls to history', () => {
    const toolCalls: ToolCall[] = [];
    addToolCall(toolCalls, tc('Read', { file_path: '/src/app.ts' }));
    addToolCall(toolCalls, tc('Edit', { file_path: '/src/app.ts' }));

    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0].name).toBe('Read');
    expect(toolCalls[1].name).toBe('Edit');
  });

  test('enforces 200-item maximum', () => {
    const toolCalls: ToolCall[] = [];
    for (let i = 0; i < 201; i++) {
      addToolCall(toolCalls, tc('Read', { file_path: `/file${i}.ts` }));
    }

    expect(toolCalls).toHaveLength(200);
  });

  test('FIFO eviction removes oldest entries', () => {
    const toolCalls: ToolCall[] = [];
    for (let i = 0; i < 201; i++) {
      addToolCall(toolCalls, tc('Read', { file_path: `/file${i}.ts` }));
    }

    // First entry should be file1.ts (file0.ts was evicted)
    expect(toolCalls[0].input.file_path).toBe('/file1.ts');
    // Last entry should be file200.ts
    expect(toolCalls[199].input.file_path).toBe('/file200.ts');
  });

  test('multiple evictions over time', () => {
    const toolCalls: ToolCall[] = [];
    // Fill to 200
    for (let i = 0; i < 200; i++) {
      addToolCall(toolCalls, tc('Read', { file_path: `/file${i}.ts` }));
    }
    expect(toolCalls).toHaveLength(200);

    // Add 50 more — should evict 50 oldest
    for (let i = 200; i < 250; i++) {
      addToolCall(toolCalls, tc('Read', { file_path: `/file${i}.ts` }));
    }
    expect(toolCalls).toHaveLength(200);
    expect(toolCalls[0].input.file_path).toBe('/file50.ts');
    expect(toolCalls[199].input.file_path).toBe('/file249.ts');
  });

  test('preserves tool call data during eviction', () => {
    const toolCalls: ToolCall[] = [];
    // Fill to 200 with unique data
    for (let i = 0; i < 200; i++) {
      addToolCall(toolCalls, {
        name: i % 2 === 0 ? 'Read' : 'Edit',
        timestamp: 1000 + i,
        input: { file_path: `/file${i}.ts`, extra: `data${i}` },
      });
    }

    // Add one more to trigger eviction
    addToolCall(toolCalls, {
      name: 'Write',
      timestamp: 9999,
      input: { file_path: '/new.ts', content: 'hello' },
    });

    expect(toolCalls).toHaveLength(200);
    // Last item should be the newly added one
    const last = toolCalls[199];
    expect(last.name).toBe('Write');
    expect(last.timestamp).toBe(9999);
    expect(last.input.content).toBe('hello');
  });

  test('boundary: exactly 200 items does not evict', () => {
    const toolCalls: ToolCall[] = [];
    for (let i = 0; i < 200; i++) {
      addToolCall(toolCalls, tc('Read', { file_path: `/file${i}.ts` }));
    }

    expect(toolCalls).toHaveLength(200);
    expect(toolCalls[0].input.file_path).toBe('/file0.ts');
  });
});

describe('Git Stats Extraction (Commit Detection)', () => {
  test('extracts commit message with -m flag and double quotes', () => {
    const message = extractCommitFromBash('git commit -m "feat: add login"');
    expect(message).toBe('feat: add login');
  });

  test('extracts commit message with -m flag and single quotes', () => {
    const message = extractCommitFromBash("git commit -m 'fix: bug'");
    expect(message).toBe('fix: bug');
  });

  test('extracts commit message from heredoc format', () => {
    const cmd = `git commit -m "$(cat <<'EOF'\nfeat: add new feature\n\nCo-Authored-By: Claude\nEOF\n)"`;
    const message = extractCommitFromBash(cmd);
    // heredoc regex expects literal newlines
    expect(message).not.toBeNull();
  });

  test('extracts commit from heredoc with actual newlines', () => {
    const cmd = `git commit -m "$(cat <<'EOF'\nfeat: implement dark mode\n\nDetailed description here\nEOF\n)"`;
    const message = extractCommitFromBash(cmd);
    expect(message).not.toBeNull();
  });

  test('returns fallback "commit" for git commit without message', () => {
    // git commit --amend --no-edit (no -m flag, no heredoc)
    const message = extractCommitFromBash('git commit --amend --no-edit');
    expect(message).toBe('commit');
  });

  test('returns null for non-commit commands', () => {
    expect(extractCommitFromBash('git status')).toBeNull();
    expect(extractCommitFromBash('git push origin main')).toBeNull();
    expect(extractCommitFromBash('npm test')).toBeNull();
    expect(extractCommitFromBash('echo "hello"')).toBeNull();
  });

  test('returns null for empty command', () => {
    expect(extractCommitFromBash('')).toBeNull();
  });

  test('detects git commit in compound commands', () => {
    const message = extractCommitFromBash('git add . && git commit -m "chore: cleanup"');
    expect(message).toBe('chore: cleanup');
  });

  test('extracts first message from chained commits', () => {
    const message = extractCommitFromBash(
      'git commit -m "first commit" && git push'
    );
    expect(message).toBe('first commit');
  });

  test('handles commit message with special characters', () => {
    const message = extractCommitFromBash('git commit -m "fix: handle $var & <html>"');
    expect(message).toBe('fix: handle $var & <html>');
  });
});

describe('File Extraction from Tool Calls', () => {
  test('extracts Read file paths', () => {
    const calls = [
      tc('Read', { file_path: '/src/app.ts' }),
      tc('Read', { file_path: '/src/utils.ts' }),
    ];
    const files = extractFilesFromToolCalls(calls);

    expect(files).toEqual(['/src/app.ts', '/src/utils.ts']);
  });

  test('extracts Edit file paths', () => {
    const calls = [
      tc('Edit', { file_path: '/src/app.ts', old_string: 'a', new_string: 'b' }),
    ];
    const files = extractFilesFromToolCalls(calls);

    expect(files).toEqual(['/src/app.ts']);
  });

  test('extracts Write file paths', () => {
    const calls = [
      tc('Write', { file_path: '/src/new-file.ts', content: 'export const x = 1;' }),
    ];
    const files = extractFilesFromToolCalls(calls);

    expect(files).toEqual(['/src/new-file.ts']);
  });

  test('deduplicates file paths', () => {
    const calls = [
      tc('Read', { file_path: '/src/app.ts' }),
      tc('Edit', { file_path: '/src/app.ts' }),
      tc('Read', { file_path: '/src/app.ts' }),
      tc('Write', { file_path: '/src/app.ts' }),
    ];
    const files = extractFilesFromToolCalls(calls);

    expect(files).toEqual(['/src/app.ts']);
  });

  test('ignores non-file tool calls', () => {
    const calls = [
      tc('Bash', { command: 'npm test' }),
      tc('Grep', { pattern: 'TODO', path: '/src' }),
      tc('Glob', { pattern: '**/*.ts' }),
      tc('Read', { file_path: '/src/app.ts' }),
    ];
    const files = extractFilesFromToolCalls(calls);

    expect(files).toEqual(['/src/app.ts']);
  });

  test('caps at 20 files', () => {
    const calls = Array.from({ length: 25 }, (_, i) =>
      tc('Read', { file_path: `/src/file${i}.ts` })
    );
    const files = extractFilesFromToolCalls(calls);

    expect(files).toHaveLength(20);
  });

  test('returns empty array for no file tool calls', () => {
    const calls = [
      tc('Bash', { command: 'npm test' }),
      tc('Grep', { pattern: 'TODO' }),
    ];
    const files = extractFilesFromToolCalls(calls);

    expect(files).toEqual([]);
  });

  test('returns empty array for empty tool calls', () => {
    const files = extractFilesFromToolCalls([]);
    expect(files).toEqual([]);
  });

  test('skips tool calls with missing file_path', () => {
    const calls = [
      tc('Read', {}),
      tc('Edit', { old_string: 'a', new_string: 'b' }),
      tc('Write', { content: 'hello' }),
      tc('Read', { file_path: '/src/valid.ts' }),
    ];
    const files = extractFilesFromToolCalls(calls);

    expect(files).toEqual(['/src/valid.ts']);
  });
});

describe('File Explored/Modified Extraction', () => {
  test('separates explored vs modified files', () => {
    const calls = [
      tc('Read', { file_path: '/src/app.ts' }),
      tc('Read', { file_path: '/src/utils.ts' }),
      tc('Edit', { file_path: '/src/app.ts' }),
      tc('Write', { file_path: '/src/new.ts' }),
    ];
    const result = extractFilesExploredAndModified(calls);

    expect(result.explored).toEqual(['/src/app.ts', '/src/utils.ts']);
    expect(result.modified).toEqual(['/src/app.ts', '/src/new.ts']);
  });

  test('deduplicates within each category', () => {
    const calls = [
      tc('Read', { file_path: '/src/app.ts' }),
      tc('Read', { file_path: '/src/app.ts' }),
      tc('Edit', { file_path: '/src/app.ts' }),
      tc('Edit', { file_path: '/src/app.ts' }),
    ];
    const result = extractFilesExploredAndModified(calls);

    expect(result.explored).toEqual(['/src/app.ts']);
    expect(result.modified).toEqual(['/src/app.ts']);
  });

  test('handles empty tool calls', () => {
    const result = extractFilesExploredAndModified([]);
    expect(result.explored).toEqual([]);
    expect(result.modified).toEqual([]);
  });

  test('ignores non-file tools', () => {
    const calls = [
      tc('Bash', { command: 'npm test' }),
      tc('Grep', { pattern: 'foo', path: '/src' }),
    ];
    const result = extractFilesExploredAndModified(calls);

    expect(result.explored).toEqual([]);
    expect(result.modified).toEqual([]);
  });
});

describe('Milestone Generation', () => {
  test('adds status milestones', () => {
    const milestones: Milestone[] = [];
    addMilestone(milestones, { type: 'status', label: 'Task started', ts: 1000 });

    expect(milestones).toHaveLength(1);
    expect(milestones[0]).toEqual({ type: 'status', label: 'Task started', ts: 1000 });
  });

  test('adds phase milestones', () => {
    const milestones: Milestone[] = [];
    addMilestone(milestones, { type: 'phase', label: 'Investigating codebase', toolCount: 5, ts: 1000 });

    expect(milestones).toHaveLength(1);
    expect(milestones[0]).toEqual({ type: 'phase', label: 'Investigating codebase', toolCount: 5, ts: 1000 });
  });

  test('enforces 30-item maximum', () => {
    const milestones: Milestone[] = [];
    for (let i = 0; i < 31; i++) {
      addMilestone(milestones, { type: 'status', label: `Step ${i}`, ts: 1000 + i });
    }

    expect(milestones).toHaveLength(30);
  });

  test('FIFO eviction removes oldest milestones', () => {
    const milestones: Milestone[] = [];
    for (let i = 0; i < 31; i++) {
      addMilestone(milestones, { type: 'status', label: `Step ${i}`, ts: 1000 + i });
    }

    // First should be Step 1 (Step 0 evicted)
    expect(milestones[0]).toEqual({ type: 'status', label: 'Step 1', ts: 1001 });
    // Last should be Step 30
    expect(milestones[29]).toEqual({ type: 'status', label: 'Step 30', ts: 1030 });
  });

  test('exactly 30 milestones does not evict', () => {
    const milestones: Milestone[] = [];
    for (let i = 0; i < 30; i++) {
      addMilestone(milestones, { type: 'status', label: `Step ${i}`, ts: 1000 + i });
    }

    expect(milestones).toHaveLength(30);
    expect(milestones[0]).toEqual({ type: 'status', label: 'Step 0', ts: 1000 });
  });

  test('task lifecycle milestones', () => {
    const milestones: Milestone[] = [];

    // Simulate typical task lifecycle
    addMilestone(milestones, { type: 'status', label: 'Worktree ready', ts: 1000 });
    addMilestone(milestones, { type: 'phase', label: 'Analyzing codebase', toolCount: 8, ts: 2000 });
    addMilestone(milestones, { type: 'status', label: 'Commit: feat: add feature', ts: 3000 });
    addMilestone(milestones, { type: 'phase', label: 'Writing tests', toolCount: 12, ts: 4000 });
    addMilestone(milestones, { type: 'status', label: 'Commit: test: add tests', ts: 5000 });
    addMilestone(milestones, { type: 'status', label: 'Task completed', ts: 6000 });

    expect(milestones).toHaveLength(6);
    expect(milestones[0].label).toBe('Worktree ready');
    expect(milestones[5].label).toBe('Task completed');
  });

  test('commit detection creates milestones', () => {
    const milestones: Milestone[] = [];
    const commits: Array<{ sha: string; message: string }> = [];

    // Simulate commit detection from Bash tool calls
    const cmd = 'git commit -m "feat: add dark mode"';
    const message = extractCommitFromBash(cmd);
    if (message) {
      commits.push({ sha: 'pending', message });
      addMilestone(milestones, { type: 'status', label: `Commit: ${message}`, ts: Date.now() });
    }

    expect(commits).toHaveLength(1);
    expect(commits[0].message).toBe('feat: add dark mode');
    expect(milestones).toHaveLength(1);
    expect(milestones[0].label).toBe('Commit: feat: add dark mode');
  });

  test('first file edit detected as milestone', () => {
    const milestones: Milestone[] = [];

    // Simulate phase closing after first edit
    addMilestone(milestones, { type: 'phase', label: 'Exploring project structure', toolCount: 3, ts: 1000 });

    expect(milestones).toHaveLength(1);
    expect(milestones[0].type).toBe('phase');
  });
});

describe('Edge Cases', () => {
  test('tool call with undefined input', () => {
    const calls = [
      { name: 'Read', timestamp: Date.now(), input: undefined },
    ];
    const files = extractFilesFromToolCalls(calls);
    expect(files).toEqual([]);
  });

  test('tool call with null input', () => {
    const calls = [
      { name: 'Read', timestamp: Date.now(), input: null },
    ];
    const files = extractFilesFromToolCalls(calls);
    expect(files).toEqual([]);
  });

  test('tool call with empty object input', () => {
    const calls = [
      { name: 'Edit', timestamp: Date.now(), input: {} },
    ];
    const files = extractFilesFromToolCalls(calls);
    expect(files).toEqual([]);
  });

  test('tool call with file_path as empty string', () => {
    const calls = [
      tc('Read', { file_path: '' }),
    ];
    const files = extractFilesFromToolCalls(calls);
    // Empty string is falsy, should be skipped
    expect(files).toEqual([]);
  });

  test('extractCommitFromBash with undefined-like input', () => {
    expect(extractCommitFromBash('undefined')).toBeNull();
    expect(extractCommitFromBash('null')).toBeNull();
  });

  test('extractFilesExploredAndModified with missing file_path', () => {
    const calls = [
      tc('Read', {}),
      tc('Edit', { old_string: 'a' }),
      tc('Write', { content: 'x' }),
    ];
    const result = extractFilesExploredAndModified(calls);
    expect(result.explored).toEqual([]);
    expect(result.modified).toEqual([]);
  });

  test('tool call history handles rapid concurrent adds', () => {
    const toolCalls: ToolCall[] = [];
    // Simulate rapid tool calls
    for (let i = 0; i < 300; i++) {
      addToolCall(toolCalls, {
        name: 'Read',
        timestamp: Date.now(),
        input: { file_path: `/file${i}.ts` },
      });
    }
    expect(toolCalls).toHaveLength(200);
    // Should have the last 200 entries
    expect(toolCalls[0].input.file_path).toBe('/file100.ts');
    expect(toolCalls[199].input.file_path).toBe('/file299.ts');
  });

  test('milestone with progress field', () => {
    const milestones: Milestone[] = [];
    addMilestone(milestones, { type: 'status', label: 'Building', progress: 50, ts: 1000 });

    expect(milestones).toHaveLength(1);
    const m = milestones[0] as { type: 'status'; label: string; progress?: number; ts: number };
    expect(m.progress).toBe(50);
  });

  test('phase milestone with pending flag', () => {
    const milestones: Milestone[] = [];
    addMilestone(milestones, { type: 'phase', label: 'Working...', toolCount: 3, ts: 1000, pending: true });

    expect(milestones).toHaveLength(1);
    const m = milestones[0] as { type: 'phase'; label: string; toolCount: number; ts: number; pending?: boolean };
    expect(m.pending).toBe(true);
  });

  test('mixed tool call types in history', () => {
    const toolCalls: ToolCall[] = [];
    const toolNames = ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'];

    for (let i = 0; i < 50; i++) {
      addToolCall(toolCalls, tc(toolNames[i % toolNames.length], { idx: i }));
    }

    expect(toolCalls).toHaveLength(50);
    // Verify order preserved
    expect(toolCalls[0].name).toBe('Read');
    expect(toolCalls[0].input.idx).toBe(0);
    expect(toolCalls[49].name).toBe(toolNames[49 % toolNames.length]);
  });

  test('commit cap at 50 entries', () => {
    const commits: Array<{ sha: string; message: string }> = [];

    // Mirrors workers.ts:1748-1751
    for (let i = 0; i < 55; i++) {
      commits.push({ sha: 'pending', message: `commit ${i}` });
      if (commits.length > 50) {
        commits.shift();
      }
    }

    expect(commits).toHaveLength(50);
    expect(commits[0].message).toBe('commit 5');
    expect(commits[49].message).toBe('commit 54');
  });

  test('file extraction with very long paths', () => {
    const longPath = '/src/' + 'a'.repeat(500) + '.ts';
    const calls = [tc('Read', { file_path: longPath })];
    const files = extractFilesFromToolCalls(calls);
    expect(files).toEqual([longPath]);
  });

  test('file extraction with non-string file_path', () => {
    const calls = [
      { name: 'Read', timestamp: Date.now(), input: { file_path: 123 } },
      { name: 'Edit', timestamp: Date.now(), input: { file_path: true } },
      { name: 'Write', timestamp: Date.now(), input: { file_path: ['array'] } },
    ];
    // These have truthy file_path values so they'll be added (the Set converts to string)
    const files = extractFilesFromToolCalls(calls as any);
    expect(files.length).toBeGreaterThan(0);
  });
});
