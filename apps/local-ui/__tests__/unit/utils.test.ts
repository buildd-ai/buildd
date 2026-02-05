/**
 * Unit tests for utility functions and helpers
 *
 * Tests various utility functions used across local-ui including
 * context building, summary generation, and file extraction.
 *
 * Run: bun test __tests__/unit
 */

import { describe, test, expect } from 'bun:test';

// --- File extraction from tool calls ---
// Mirrors extractFilesFromToolCalls in workers.ts

interface ToolCallForExtraction {
  name: string;
  input?: Record<string, unknown>;
}

function extractFilesFromToolCalls(toolCalls: ToolCallForExtraction[]): string[] {
  const files = new Set<string>();
  for (const tc of toolCalls) {
    if ((tc.name === 'Read' || tc.name === 'Edit' || tc.name === 'Write') && tc.input?.file_path) {
      files.add(tc.input.file_path as string);
    }
  }
  return Array.from(files).slice(0, 20);
}

describe('extractFilesFromToolCalls', () => {
  test('extracts Read file paths', () => {
    const calls = [
      { name: 'Read', input: { file_path: '/src/a.ts' } },
      { name: 'Read', input: { file_path: '/src/b.ts' } },
    ];
    const files = extractFilesFromToolCalls(calls);

    expect(files).toContain('/src/a.ts');
    expect(files).toContain('/src/b.ts');
  });

  test('extracts Edit file paths', () => {
    const calls = [
      { name: 'Edit', input: { file_path: '/src/edit.ts', old_string: 'a', new_string: 'b' } },
    ];
    const files = extractFilesFromToolCalls(calls);

    expect(files).toContain('/src/edit.ts');
  });

  test('extracts Write file paths', () => {
    const calls = [
      { name: 'Write', input: { file_path: '/src/new.ts', content: 'code' } },
    ];
    const files = extractFilesFromToolCalls(calls);

    expect(files).toContain('/src/new.ts');
  });

  test('ignores other tool types', () => {
    const calls = [
      { name: 'Bash', input: { command: 'ls -la' } },
      { name: 'Grep', input: { pattern: 'TODO', path: '/src' } },
      { name: 'Glob', input: { pattern: '**/*.ts' } },
    ];
    const files = extractFilesFromToolCalls(calls);

    expect(files).toHaveLength(0);
  });

  test('deduplicates files', () => {
    const calls = [
      { name: 'Read', input: { file_path: '/src/app.ts' } },
      { name: 'Read', input: { file_path: '/src/app.ts' } },
      { name: 'Edit', input: { file_path: '/src/app.ts' } },
    ];
    const files = extractFilesFromToolCalls(calls);

    expect(files).toHaveLength(1);
    expect(files[0]).toBe('/src/app.ts');
  });

  test('limits to 20 files', () => {
    const calls = Array(30).fill(null).map((_, i) =>
      ({ name: 'Read', input: { file_path: `/src/file${i}.ts` } })
    );
    const files = extractFilesFromToolCalls(calls);

    expect(files).toHaveLength(20);
  });

  test('handles tool calls without input', () => {
    const calls = [
      { name: 'Read' },
      { name: 'Edit', input: {} },
    ];
    const files = extractFilesFromToolCalls(calls);

    expect(files).toHaveLength(0);
  });

  test('handles empty array', () => {
    expect(extractFilesFromToolCalls([])).toHaveLength(0);
  });
});

// --- Session Summary Building ---
// Mirrors buildSessionSummary logic in workers.ts

interface SimplifiedWorker {
  milestones: Array<{ label: string }>;
  commits: Array<{ message: string }>;
  toolCalls: Array<{ name: string }>;
  output: string[];
}

function buildSessionSummary(worker: SimplifiedWorker): string {
  const parts: string[] = [];

  // Milestones summary
  const milestones = worker.milestones
    .filter(m => m.label !== 'Session started' && m.label !== 'Task completed')
    .map(m => m.label);
  if (milestones.length > 0) {
    parts.push(`Milestones: ${milestones.slice(-10).join(', ')}`);
  }

  // Commits summary
  if (worker.commits.length > 0) {
    const commitMsgs = worker.commits.map(c => c.message).slice(-5);
    parts.push(`Commits: ${commitMsgs.join('; ')}`);
  }

  // Tool usage stats
  const toolCounts: Record<string, number> = {};
  for (const tc of worker.toolCalls) {
    toolCounts[tc.name] = (toolCounts[tc.name] || 0) + 1;
  }
  const toolSummary = Object.entries(toolCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => `${name}(${count})`)
    .join(', ');
  if (toolSummary) {
    parts.push(`Tools used: ${toolSummary}`);
  }

  // Last output
  const lastOutput = worker.output.slice(-3).join(' ').trim();
  if (lastOutput) {
    const truncated = lastOutput.length > 200 ? lastOutput.slice(0, 200) + '...' : lastOutput;
    parts.push(`Result: ${truncated}`);
  }

  const summary = parts.join('\n');
  return summary.length > 500 ? summary.slice(0, 500) + '...' : summary;
}

describe('buildSessionSummary', () => {
  test('includes milestones', () => {
    const worker: SimplifiedWorker = {
      milestones: [
        { label: 'Session started' },
        { label: 'Read package.json' },
        { label: 'Edit src/index.ts' },
        { label: 'Task completed' },
      ],
      commits: [],
      toolCalls: [],
      output: [],
    };
    const summary = buildSessionSummary(worker);

    expect(summary).toContain('Milestones:');
    expect(summary).toContain('Read package.json');
    expect(summary).toContain('Edit src/index.ts');
    expect(summary).not.toContain('Session started');
    expect(summary).not.toContain('Task completed');
  });

  test('includes commits', () => {
    const worker: SimplifiedWorker = {
      milestones: [],
      commits: [
        { message: 'feat: add feature' },
        { message: 'fix: bug fix' },
      ],
      toolCalls: [],
      output: [],
    };
    const summary = buildSessionSummary(worker);

    expect(summary).toContain('Commits:');
    expect(summary).toContain('feat: add feature');
    expect(summary).toContain('fix: bug fix');
  });

  test('includes tool usage stats sorted by frequency', () => {
    const worker: SimplifiedWorker = {
      milestones: [],
      commits: [],
      toolCalls: [
        { name: 'Read' },
        { name: 'Read' },
        { name: 'Read' },
        { name: 'Grep' },
        { name: 'Edit' },
      ],
      output: [],
    };
    const summary = buildSessionSummary(worker);

    expect(summary).toContain('Tools used:');
    expect(summary).toContain('Read(3)');
    expect(summary).toContain('Grep(1)');
    expect(summary).toContain('Edit(1)');
  });

  test('includes last output lines', () => {
    const worker: SimplifiedWorker = {
      milestones: [],
      commits: [],
      toolCalls: [],
      output: ['Line 1', 'Line 2', 'Final result'],
    };
    const summary = buildSessionSummary(worker);

    expect(summary).toContain('Result:');
    expect(summary).toContain('Final result');
  });

  test('truncates long output', () => {
    const longOutput = 'x'.repeat(300);
    const worker: SimplifiedWorker = {
      milestones: [],
      commits: [],
      toolCalls: [],
      output: [longOutput],
    };
    const summary = buildSessionSummary(worker);

    expect(summary.length).toBeLessThan(600);
    expect(summary).toContain('...');
  });

  test('limits milestones to last 10', () => {
    const worker: SimplifiedWorker = {
      milestones: Array(15).fill(null).map((_, i) => ({ label: `Step ${i}` })),
      commits: [],
      toolCalls: [],
      output: [],
    };
    const summary = buildSessionSummary(worker);

    // Should have last 10 (Step 5 through Step 14)
    expect(summary).toContain('Step 14');
    expect(summary).toContain('Step 5');
    expect(summary).not.toContain('Step 0');
  });

  test('limits commits to last 5', () => {
    const worker: SimplifiedWorker = {
      milestones: [],
      commits: Array(10).fill(null).map((_, i) => ({ message: `Commit ${i}` })),
      toolCalls: [],
      output: [],
    };
    const summary = buildSessionSummary(worker);

    expect(summary).toContain('Commit 9');
    expect(summary).toContain('Commit 5');
    // Should not have earlier commits
    expect(summary).not.toContain('Commit 0');
  });

  test('handles empty worker', () => {
    const worker: SimplifiedWorker = {
      milestones: [],
      commits: [],
      toolCalls: [],
      output: [],
    };
    const summary = buildSessionSummary(worker);

    expect(summary).toBe('');
  });

  test('truncates overall summary to 500 chars', () => {
    const worker: SimplifiedWorker = {
      milestones: Array(20).fill(null).map((_, i) => ({ label: `This is a very long milestone label ${i}` })),
      commits: Array(10).fill(null).map((_, i) => ({ message: `This is commit number ${i}` })),
      toolCalls: Array(50).fill(null).map(() => ({ name: 'Read' })),
      output: ['Very long output '.repeat(20)],
    };
    const summary = buildSessionSummary(worker);

    expect(summary.length).toBeLessThanOrEqual(503); // 500 + '...'
  });
});

// --- Git Commit Message Extraction ---
// Mirrors the regex used in workers.ts for detecting commits

function extractCommitMessage(command: string): string | null {
  if (!command.includes('git commit')) {
    return null;
  }
  const match = command.match(/-m\s+["']([^"']+)["']/);
  return match ? match[1] : null;
}

describe('extractCommitMessage', () => {
  test('extracts double-quoted message', () => {
    expect(extractCommitMessage('git commit -m "feat: add feature"')).toBe('feat: add feature');
  });

  test('extracts single-quoted message', () => {
    expect(extractCommitMessage("git commit -m 'fix: bug'")).toBe('fix: bug');
  });

  test('handles commit with other flags', () => {
    expect(extractCommitMessage('git commit -a -m "update"')).toBe('update');
  });

  test('returns null for non-commit commands', () => {
    expect(extractCommitMessage('git push')).toBeNull();
    expect(extractCommitMessage('git status')).toBeNull();
  });

  test('returns null for commit without message flag', () => {
    expect(extractCommitMessage('git commit --amend')).toBeNull();
  });

  test('handles message with special characters', () => {
    expect(extractCommitMessage('git commit -m "fix: handle edge-case #123"')).toBe('fix: handle edge-case #123');
  });
});

// --- Stale Worker Detection ---
// Tests the stale check logic (120 seconds threshold)

const STALE_THRESHOLD_MS = 120_000;

function isWorkerStale(lastActivity: number, currentTime: number): boolean {
  return currentTime - lastActivity > STALE_THRESHOLD_MS;
}

describe('Stale Worker Detection', () => {
  const now = Date.now();

  test('worker is not stale within threshold', () => {
    expect(isWorkerStale(now - 60_000, now)).toBe(false);  // 60s ago
    expect(isWorkerStale(now - 119_000, now)).toBe(false); // 119s ago
    expect(isWorkerStale(now, now)).toBe(false);           // just now
  });

  test('worker is stale after threshold', () => {
    expect(isWorkerStale(now - 121_000, now)).toBe(true);  // 121s ago
    expect(isWorkerStale(now - 300_000, now)).toBe(true);  // 5min ago
  });

  test('worker at exactly threshold is not stale', () => {
    // > not >= so 120s exactly is not stale
    expect(isWorkerStale(now - 120_000, now)).toBe(false);
  });
});

// --- Message Queue Limit ---
// Tests the 200 message limit behavior

describe('Message Queue Limit', () => {
  test('keeps last 200 messages', () => {
    const messages: string[] = [];
    const MAX = 200;

    // Add 250 messages
    for (let i = 0; i < 250; i++) {
      messages.push(`msg-${i}`);
      if (messages.length > MAX) {
        messages.shift();
      }
    }

    expect(messages.length).toBe(200);
    expect(messages[0]).toBe('msg-50');
    expect(messages[199]).toBe('msg-249');
  });
});

// --- Output Line Limit ---
// Tests the 100 output line limit

describe('Output Line Limit', () => {
  test('keeps last 100 lines', () => {
    const output: string[] = [];
    const MAX = 100;

    for (let i = 0; i < 150; i++) {
      output.push(`line-${i}`);
      if (output.length > MAX) {
        output.shift();
      }
    }

    expect(output.length).toBe(100);
    expect(output[0]).toBe('line-50');
    expect(output[99]).toBe('line-149');
  });
});

// --- Tool Call Limit ---
// Tests the 200 tool call limit

describe('Tool Call Limit', () => {
  test('keeps last 200 tool calls', () => {
    const toolCalls: { name: string }[] = [];
    const MAX = 200;

    for (let i = 0; i < 300; i++) {
      toolCalls.push({ name: `tool-${i}` });
      if (toolCalls.length > MAX) {
        toolCalls.shift();
      }
    }

    expect(toolCalls.length).toBe(200);
    expect(toolCalls[0].name).toBe('tool-100');
    expect(toolCalls[199].name).toBe('tool-299');
  });
});
