/**
 * The claim-time memory index renderer (task caa30c0f). Pure: one line per
 * memory, one header, a token budget, dedupe across surfaces.
 */
import { describe, it, expect } from 'bun:test';
import {
  buildMemoryIndex,
  estimateTokens,
  isMemoryIndexEnabled,
  memoryIndexTokenBudget,
  memoryIndexEntriesTokens,
  parseMemoryIdRef,
  readMemoryIndexEntries,
  renderMemoryIndexLine,
  MEMORY_INDEX_HEADER,
  MEMORY_INDEX_CONTEXT_KEY,
  DEFAULT_MEMORY_INDEX_TOKEN_BUDGET,
  type MemoryIndexEntry,
} from '../memory-claim-index';

const A = '1a2b3c4d-0000-4000-8000-000000000001';
const B = '2b3c4d5e-0000-4000-8000-000000000002';
const C = '3c4d5e6f-0000-4000-8000-000000000003';

const entry = (id: string, over: Partial<MemoryIndexEntry> = {}): MemoryIndexEntry => ({
  id, type: 'gotcha', title: 'Neon has no transactions', why: 'path', ...over,
});

describe('flag', () => {
  it('is on only for a literal true', () => {
    expect(isMemoryIndexEnabled({ memoryIndexInjection: true })).toBe(true);
    for (const v of [undefined, null, {}, { memoryIndexInjection: 'true' }, { memoryIndexInjection: 1 }, { memoryIndexInjection: false }]) {
      expect(isMemoryIndexEnabled(v)).toBe(false);
    }
  });

  it('budget defaults to 800 and takes a positive override', () => {
    expect(memoryIndexTokenBudget(undefined)).toBe(DEFAULT_MEMORY_INDEX_TOKEN_BUDGET);
    expect(DEFAULT_MEMORY_INDEX_TOKEN_BUDGET).toBe(800);
    expect(memoryIndexTokenBudget({ memoryIndexTokenBudget: 200 })).toBe(200);
    expect(memoryIndexTokenBudget({ memoryIndexTokenBudget: -5 })).toBe(800);
    expect(memoryIndexTokenBudget({ memoryIndexTokenBudget: 'lots' })).toBe(800);
  });
});

describe('line shape', () => {
  it('is `- <type> m:<8-char id> <title> (<why>)`', () => {
    expect(renderMemoryIndexLine(entry(A))).toBe('- gotcha m:1a2b3c4d Neon has no transactions (path)');
  });

  it('flattens a multi-line or heading title and caps it', () => {
    expect(renderMemoryIndexLine(entry(A, { title: '## Heading\nbody' }))).toBe('- gotcha m:1a2b3c4d Heading (path)');
    const long = renderMemoryIndexLine(entry(A, { title: 'x'.repeat(300) }));
    expect(long.length).toBeLessThan(130);
    expect(long).toContain('...');
  });
});

describe('buildMemoryIndex', () => {
  it('renders one header then one line per entry', () => {
    const idx = buildMemoryIndex([entry(A), entry(B, { type: 'pattern', title: 'Use bun run test', why: 'title' })]);
    expect(idx.lines).toEqual([
      MEMORY_INDEX_HEADER,
      '- gotcha m:1a2b3c4d Neon has no transactions (path)',
      '- pattern m:2b3c4d5e Use bun run test (title)',
    ]);
    expect(idx.tokens).toBe(estimateTokens(idx.lines.join('\n')));
    expect(MEMORY_INDEX_HEADER).toContain('recall');
  });

  it('dedupes by id and against exclude (full or short ids)', () => {
    const idx = buildMemoryIndex([entry(A), entry(A), entry(B), entry(C)], { exclude: [B.slice(0, 8)] });
    expect(idx.shown.map(e => e.id)).toEqual([A, C]);
    expect(buildMemoryIndex([entry(A)], { exclude: [A] }).lines).toEqual([]);
  });

  it('stops at the budget, never skipping a stronger hit for a weaker one', () => {
    const many = Array.from({ length: 200 }, (_, i) => entry(`${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`));
    const idx = buildMemoryIndex(many);
    expect(idx.tokens).toBeLessThanOrEqual(800);
    expect(idx.shown.length).toBeGreaterThan(5);
    expect(idx.shown.length + idx.dropped.length).toBe(200);
    expect(idx.shown).toEqual(many.slice(0, idx.shown.length));

    const tight = buildMemoryIndex([entry(A, { title: 'short' }), entry(B, { title: 'y'.repeat(90) }), entry(C, { title: 'z' })], {
      budgetTokens: estimateTokens(`${MEMORY_INDEX_HEADER}\n- gotcha m:1a2b3c4d short (path)`) + 5,
    });
    expect(tight.shown.map(e => e.id)).toEqual([A]);
    expect(tight.dropped.map(e => e.id)).toEqual([B, C]);
  });

  it('a budget too small for the header and one line is an empty index', () => {
    expect(buildMemoryIndex([entry(A)], { budgetTokens: 5 }).lines).toEqual([]);
  });

  it('continued omits the header', () => {
    expect(buildMemoryIndex([entry(A)], { continued: true }).lines).toEqual(['- gotcha m:1a2b3c4d Neon has no transactions (path)']);
  });

  it('memoryIndexEntriesTokens is what the full index for those entries costs', () => {
    const entries = [entry(A), entry(B)];
    expect(memoryIndexEntriesTokens(entries)).toBe(buildMemoryIndex(entries).tokens);
    expect(memoryIndexEntriesTokens([])).toBe(0);
  });
});

describe('readMemoryIndexEntries', () => {
  it('reads valid entries from task.context and drops malformed ones', () => {
    const got = readMemoryIndexEntries({
      [MEMORY_INDEX_CONTEXT_KEY]: [entry(A), { id: 3 }, null, { id: B, type: 'pattern', title: 't', why: 'bogus' }],
    });
    expect(got).toEqual([entry(A), { id: B, type: 'pattern', title: 't', why: 'title' }]);
    expect(readMemoryIndexEntries(undefined)).toEqual([]);
    expect(readMemoryIndexEntries({ [MEMORY_INDEX_CONTEXT_KEY]: 'nope' })).toEqual([]);
  });
});

describe('parseMemoryIdRef', () => {
  it('reads full ids, 8+ char prefixes, and the m: form', () => {
    expect(parseMemoryIdRef(A)).toEqual({ kind: 'full', value: A });
    expect(parseMemoryIdRef(A.toUpperCase())).toEqual({ kind: 'full', value: A });
    expect(parseMemoryIdRef('1a2b3c4d')).toEqual({ kind: 'prefix', value: '1a2b3c4d' });
    expect(parseMemoryIdRef('m:1A2B3C4D')).toEqual({ kind: 'prefix', value: '1a2b3c4d' });
    expect(parseMemoryIdRef(`m:${A}`)).toEqual({ kind: 'full', value: A });
  });

  it('is null for anything not id-shaped', () => {
    for (const v of ['1a2b3c', 'not-an-id', '', 42, null, 'zzzzzzzz']) expect(parseMemoryIdRef(v)).toBeNull();
  });
});
