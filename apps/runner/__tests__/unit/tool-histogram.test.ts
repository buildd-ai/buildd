/**
 * Unit tests for the per-worker tool-call histogram (src/tool-metrics.ts).
 *
 * Regression target: before this, only mcp__codebase-memory__* and
 * Read/Grep/Glob were counted, so Bash/Edit/Write/Task and non-CBM MCP servers
 * never reached the server at all.
 */

import { describe, test, expect } from 'bun:test';
import {
  recordToolCall,
  totalToolCalls,
  MAX_TOOL_KEYS,
  OTHER_TOOL_KEY,
} from '../../src/tool-metrics';

describe('recordToolCall', () => {
  test('counts built-in tools that the CBM counters ignored', () => {
    const counts: Record<string, number> = {};
    for (const t of ['Bash', 'Edit', 'Bash', 'Write', 'Task', 'Bash']) {
      recordToolCall(counts, t);
    }
    expect(counts).toEqual({ Bash: 3, Edit: 1, Write: 1, Task: 1 });
  });

  test('counts MCP tools under their full name so server+tool both survive', () => {
    const counts: Record<string, number> = {};
    recordToolCall(counts, 'mcp__buildd__buildd');
    recordToolCall(counts, 'mcp__buildd__recall');
    recordToolCall(counts, 'mcp__buildd__buildd');
    recordToolCall(counts, 'mcp__codebase-memory__search_code');
    expect(counts).toEqual({
      'mcp__buildd__buildd': 2,
      'mcp__buildd__recall': 1,
      'mcp__codebase-memory__search_code': 1,
    });
  });

  test('file-access tools are counted alongside everything else', () => {
    const counts: Record<string, number> = {};
    recordToolCall(counts, 'Read');
    recordToolCall(counts, 'Grep');
    recordToolCall(counts, 'Glob');
    recordToolCall(counts, 'Read');
    expect(counts.Read).toBe(2);
    expect(counts.Grep).toBe(1);
    expect(counts.Glob).toBe(1);
  });

  test('ignores an empty tool name rather than creating a blank key', () => {
    const counts: Record<string, number> = {};
    recordToolCall(counts, '');
    expect(counts).toEqual({});
  });

  test('collapses overflow beyond MAX_TOOL_KEYS into __other__', () => {
    const counts: Record<string, number> = {};
    for (let i = 0; i < MAX_TOOL_KEYS; i++) recordToolCall(counts, `tool_${i}`);
    expect(Object.keys(counts).length).toBe(MAX_TOOL_KEYS);

    recordToolCall(counts, 'overflow_a');
    recordToolCall(counts, 'overflow_b');
    expect(counts[OTHER_TOOL_KEY]).toBe(2);
    expect(counts.overflow_a).toBeUndefined();
    expect(Object.keys(counts).length).toBe(MAX_TOOL_KEYS + 1);
  });

  test('keeps counting a name already tracked once the cap is reached', () => {
    const counts: Record<string, number> = {};
    for (let i = 0; i < MAX_TOOL_KEYS; i++) recordToolCall(counts, `tool_${i}`);
    recordToolCall(counts, 'tool_0');
    expect(counts.tool_0).toBe(2);
    expect(counts[OTHER_TOOL_KEY]).toBeUndefined();
  });
});

describe('totalToolCalls', () => {
  test('sums every bucket', () => {
    expect(totalToolCalls({ Bash: 3, Read: 10, 'mcp__buildd__buildd': 2 })).toBe(15);
  });

  test('is 0 for a session that called no tools', () => {
    expect(totalToolCalls({})).toBe(0);
  });
});
