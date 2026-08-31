/**
 * CBM steering prompt.
 *
 * Measured on production workers: essentially every CBM-enforced task indexed
 * successfully and then made ZERO graph calls. The prompt named the tools and the
 * question shapes they answer, and agents still reached for Read/Grep first — a
 * capability list is not a procedure. These tests pin the procedural framing so a
 * future edit cannot quietly revert to "here are some tools you could use".
 */
import { describe, test, expect } from 'bun:test';
import { buildCbmSystemPromptBlock } from '../../src/cbm-enforcement';

const block = buildCbmSystemPromptBlock();

describe('buildCbmSystemPromptBlock', () => {
  test('tells the agent to open with a graph call before file navigation', () => {
    // The failure mode is ordering, not awareness: Read/Grep happened first and
    // answered the question well enough that the graph was never consulted.
    expect(block).toMatch(/first|before|start/i);
    expect(block).toMatch(/mcp__codebase-memory__(search_graph|get_architecture)/);
  });

  test('scopes the instruction to tasks that touch existing code', () => {
    // A greenfield file or a docs edit has no structural question to ask; the
    // instruction must not read as an unconditional tax on every task.
    expect(block).toMatch(/existing code|already exists|unfamiliar/i);
  });

  test('still names a tool for each question shape', () => {
    for (const tool of ['trace_path', 'search_graph', 'get_architecture', 'search_code']) {
      expect(block).toContain(`mcp__codebase-memory__${tool}`);
    }
  });

  test('keeps the graph an accelerator, not a gate', () => {
    // Read/Grep must stay available or the agent stalls when the graph is empty.
    expect(block).toMatch(/accelerator|never a gate|returns nothing/i);
    expect(block).toMatch(/Read\/Grep|Read, Grep|Read\b/);
  });

  test('does not claim the graph knows intent or history', () => {
    expect(block).toMatch(/structural/i);
    expect(block).toMatch(/recall/);
  });

  test('is a single appendable block with a heading and no leading blank line dependency', () => {
    expect(block.startsWith('\n')).toBe(false);
    expect(block).toContain('## Codebase graph');
  });
});
