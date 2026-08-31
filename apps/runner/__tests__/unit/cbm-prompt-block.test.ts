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
const shared = buildCbmSystemPromptBlock({ project: 'home-coder-project-buildd', sharedBaseIndex: true });

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

describe('buildCbmSystemPromptBlock — shared base index', () => {
  test('names the pre-seeded project so the agent can query it directly', () => {
    expect(shared).toContain('home-coder-project-buildd');
  });

  test('warns that content is the base checkout, not this branch', () => {
    // get_code_snippet serves the indexed copy — verified against 0.10.8, an edit
    // made in the worktree does not appear. An agent trusting a snippet of a file
    // it just edited would be working from stale code.
    expect(shared).toMatch(/base checkout/i);
    expect(shared).toMatch(/Read the file for current content/i);
  });

  test('does not claim the worktree itself is indexed', () => {
    expect(shared).not.toContain('This worktree is already indexed');
  });

  test('per-worker mode keeps its original wording', () => {
    expect(block).toContain('This worktree is already indexed');
    expect(block).not.toMatch(/base checkout/i);
  });
});
