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
import { buildCbmSystemPromptBlock, buildCbmGuidanceBody } from '../../src/cbm-enforcement';

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

// ── tool routing: symbols go to the graph, literal text to the grep wrapper ────
//
// search_code is CBM's grep wrapper; the server's own instructions route symbols
// to search_graph and callers/blast radius to trace_path. Guidance that sent
// "locating a symbol" to search_code steered agents to the text path, and the
// measured call mix followed the guidance.
describe('buildCbmGuidanceBody — tool routing', () => {
  const renderings = (['claude', 'codex'] as const).flatMap(dialect =>
    (['warm', 'building', 'unavailable'] as const).flatMap(bootstrapState => [
      { dialect, bootstrapState, sharedBaseIndex: false },
      { dialect, bootstrapState, sharedBaseIndex: true },
    ]),
  );

  test('locating a symbol routes to search_graph, not search_code, in both dialects', () => {
    for (const opts of renderings) {
      const body = buildCbmGuidanceBody({ ...opts, project: 'p' });
      const line = body.split('\n').find(l => /locating a symbol/i.test(l));
      expect(line).toBeDefined();
      expect(line).toContain('mcp__codebase-memory__search_graph');
      expect(line).not.toContain('search_code');
    }
  });

  test('search_code appears only on the literal-text line', () => {
    for (const opts of renderings) {
      const body = buildCbmGuidanceBody({ ...opts, project: 'p' });
      const lines = body.split('\n').filter(l => l.includes('search_code'));
      expect(lines.length).toBeGreaterThan(0);
      for (const l of lines) expect(l).toMatch(/literal|string|text/i);
    }
  });

  test('callers and blast-radius questions route to trace_path', () => {
    for (const opts of renderings) {
      const body = buildCbmGuidanceBody({ ...opts, project: 'p' });
      for (const shape of [/what calls X/i, /what breaks if I change X/i]) {
        const line = body.split('\n').find(l => shape.test(l));
        expect(line).toBeDefined();
        expect(line).toContain('mcp__codebase-memory__trace_path');
      }
    }
  });
});

// ── shared-seed mode: never tell the agent to index ───────────────────────────
//
// In shared mode the cache dir is the fleet-wide seed cache. An agent-issued
// index_repository there writes a project .db for its own worktree into the
// shared cache — a stray file no seed record owns.
describe('buildCbmGuidanceBody — shared seed does not suggest index_repository', () => {
  test('warm shared-seed guidance never names index_repository, in either dialect', () => {
    for (const dialect of ['claude', 'codex'] as const) {
      const body = buildCbmGuidanceBody({ dialect, project: 'p', sharedBaseIndex: true });
      expect(body).not.toContain('index_repository');
      expect(body).toMatch(/not indexed/i);
    }
  });

  // The 'building'/'unavailable' states are unreachable in shared mode today (a
  // shared-cache hit is reported as skipped_warm), but that invariant lives in
  // workers.ts, far from here. Key the rule on sharedBaseIndex alone so the
  // guidance stays safe if the combination ever becomes reachable.
  test('shared-seed guidance never names index_repository in any bootstrap state', () => {
    for (const dialect of ['claude', 'codex'] as const) {
      for (const bootstrapState of ['warm', 'building', 'unavailable'] as const) {
        const body = buildCbmGuidanceBody({ dialect, bootstrapState, project: 'p', sharedBaseIndex: true });
        expect(body).not.toContain('index_repository');
      }
    }
  });

  test('per-worktree guidance keeps the index_repository fallback', () => {
    for (const dialect of ['claude', 'codex'] as const) {
      expect(buildCbmGuidanceBody({ dialect })).toContain('mcp__codebase-memory__index_repository');
    }
  });
});
