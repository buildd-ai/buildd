import { describe, it, expect } from 'bun:test';
import { chunkMarkdown, chunkCode, chunkText } from '../knowledge-store/chunker';

// ── chunkText (generic overlap windower) ─────────────────────────────────────

describe('chunkText', () => {
  it('returns a single chunk when text fits within maxChars', () => {
    const chunks = chunkText('hello world', { maxChars: 100, overlap: 10 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('hello world');
    expect(chunks[0].startLine).toBe(1);
  });

  it('splits long text into multiple chunks with overlap', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const text = lines.join('\n');
    const chunks = chunkText(text, { maxChars: 30, overlap: 10 });
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should be within budget (allowing a single oversized line)
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(60);
    }
    // Overlap: consecutive chunks should share at least one line
    const firstLines = chunks[0].content.split('\n');
    const secondLines = chunks[1].content.split('\n');
    expect(secondLines.some(l => firstLines.includes(l))).toBe(true);
  });

  it('never drops content — concatenated unique lines cover the input', () => {
    const lines = Array.from({ length: 12 }, (_, i) => `unique-token-${i}`);
    const text = lines.join('\n');
    const chunks = chunkText(text, { maxChars: 25, overlap: 5 });
    const covered = new Set(chunks.flatMap(c => c.content.split('\n')));
    for (const l of lines) expect(covered.has(l)).toBe(true);
  });

  it('tracks startLine / endLine accurately', () => {
    const text = ['a', 'b', 'c', 'd'].join('\n');
    const chunks = chunkText(text, { maxChars: 3, overlap: 0 });
    expect(chunks[0].startLine).toBe(1);
    const last = chunks[chunks.length - 1];
    expect(last.endLine).toBe(4);
  });

  it('handles empty input', () => {
    expect(chunkText('', { maxChars: 100, overlap: 10 })).toEqual([]);
    expect(chunkText('   \n  ', { maxChars: 100, overlap: 10 })).toEqual([]);
  });
});

// ── chunkMarkdown (heading-aware) ────────────────────────────────────────────

describe('chunkMarkdown', () => {
  it('splits on headings and carries the heading path', () => {
    const md = [
      '# Title',
      'intro paragraph',
      '## Section A',
      'content a',
      '## Section B',
      'content b',
    ].join('\n');
    const chunks = chunkMarkdown(md, { maxChars: 1000, overlap: 0 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const sectionA = chunks.find(c => c.content.includes('content a'))!;
    expect(sectionA.headingPath).toContain('Section A');
    // Heading path should include ancestor heading
    expect(sectionA.headingPath).toContain('Title');
  });

  it('further splits an oversized section by size', () => {
    const big = Array.from({ length: 50 }, (_, i) => `paragraph line ${i}`).join('\n');
    const md = `# Big\n${big}`;
    const chunks = chunkMarkdown(md, { maxChars: 100, overlap: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    // All chunks under the same section share the heading path
    expect(chunks.every(c => c.headingPath.includes('Big'))).toBe(true);
  });

  it('handles markdown with no headings', () => {
    const chunks = chunkMarkdown('just some prose with no headings', { maxChars: 1000, overlap: 0 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain('just some prose');
  });

  it('returns empty for empty input', () => {
    expect(chunkMarkdown('', { maxChars: 1000, overlap: 0 })).toEqual([]);
  });
});

// ── chunkCode ────────────────────────────────────────────────────────────────

describe('chunkCode', () => {
  it('keeps a small file as one chunk', () => {
    const code = 'export function add(a, b) {\n  return a + b;\n}';
    const chunks = chunkCode(code, { maxChars: 1000, overlap: 0 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain('add');
  });

  it('splits a large file into overlapping windows', () => {
    const fn = (n: number) => `export function fn${n}() {\n  return ${n};\n}`;
    const code = Array.from({ length: 40 }, (_, i) => fn(i)).join('\n\n');
    const chunks = chunkCode(code, { maxChars: 200, overlap: 40 });
    expect(chunks.length).toBeGreaterThan(1);
    // Coverage: every function definition appears in some chunk
    const joined = chunks.map(c => c.content).join('\n');
    expect(joined).toContain('fn0');
    expect(joined).toContain('fn39');
  });
});

// ── chunkCodeSymbols ─────────────────────────────────────────────────────────

import { chunkCodeSymbols } from '../knowledge-store/chunker';

describe('chunkCodeSymbols', () => {
  // Fixture: imports header (lines 1-2), three declarations with a gap.
  const LINES = [
    "import { a } from './a';",   // 1
    "import { b } from './b';",   // 2
    '',                           // 3
    'export function one() {',    // 4
    '  return 1;',                // 5
    '}',                          // 6
    '',                           // 7
    'const LOOSE = 1;',           // 8  (not a tracked symbol — gap statement)
    '',                           // 9
    'export function two() {',    // 10
    '  return 2;',                // 11
    '}',                          // 12
    '',                           // 13
    'export function three() {',  // 14
    '  return 3;',                // 15
    '}',                          // 16
  ];
  const SRC = LINES.join('\n');
  const SYMS = [
    { name: 'one', kind: 'function', startLine: 4, endLine: 6, exported: true },
    { name: 'two', kind: 'function', startLine: 10, endLine: 12, exported: true },
    { name: 'three', kind: 'function', startLine: 14, endLine: 16, exported: true },
  ];

  it('aligns chunk boundaries to declaration ends', () => {
    // Budget fits any single declaration segment but never two adjacent ones.
    const pieces = chunkCodeSymbols(SRC, SYMS, { maxChars: 95, overlap: 0 });
    expect(pieces.length).toBe(3);
    // First chunk absorbs the imports header (leading gap attaches forward).
    expect(pieces[0].startLine).toBe(1);
    expect(pieces[0].endLine).toBe(6);
    expect(pieces[0].content).toContain("import { a }");
    expect(pieces[0].content).toContain('function one');
    // Gap lines (LOOSE) attach to the following declaration's chunk.
    expect(pieces[1].startLine).toBe(7);
    expect(pieces[1].endLine).toBe(12);
    expect(pieces[1].content).toContain('LOOSE');
    expect(pieces[1].content).toContain('function two');
    // No declaration is split across chunks.
    for (const p of pieces) {
      const opens = (p.content.match(/function (one|two|three)/g) ?? []).length;
      const closes = (p.content.match(/^\}$/gm) ?? []).length;
      expect(opens).toBe(closes);
    }
  });

  it('packs consecutive declarations into one chunk under a generous budget', () => {
    const pieces = chunkCodeSymbols(SRC, SYMS, { maxChars: 4000, overlap: 0 });
    expect(pieces.length).toBe(1);
    expect(pieces[0].startLine).toBe(1);
    expect(pieces[0].endLine).toBe(16);
  });

  it('attaches trailing lines after the last declaration to the last chunk', () => {
    const src = SRC + '\n\n// trailing comment';
    const pieces = chunkCodeSymbols(src, SYMS, { maxChars: 4000, overlap: 0 });
    expect(pieces.length).toBe(1);
    expect(pieces[0].endLine).toBe(18);
    expect(pieces[0].content).toContain('trailing comment');
  });

  it('falls back to line-window splitting inside an oversized declaration', () => {
    const bigBody = Array.from({ length: 50 }, (_, i) => `  const v${i} = ${i};`);
    const src = ['export function big() {', ...bigBody, '}'].join('\n');
    const syms = [{ name: 'big', kind: 'function', startLine: 1, endLine: 52, exported: true }];
    const pieces = chunkCodeSymbols(src, syms, { maxChars: 200, overlap: 20 });
    expect(pieces.length).toBeGreaterThan(1);
    // Full coverage: every body line appears somewhere.
    const joined = pieces.map(p => p.content).join('\n');
    expect(joined).toContain('v0');
    expect(joined).toContain('v49');
    // Line ranges stay within the file and are ordered.
    for (const p of pieces) {
      expect(p.startLine).toBeGreaterThanOrEqual(1);
      expect(p.endLine).toBeLessThanOrEqual(52);
    }
  });

  it('degrades to plain line-window chunking when no symbols are provided', () => {
    const withSyms = chunkCodeSymbols(SRC, [], { maxChars: 200, overlap: 40 });
    const plain = chunkText(SRC, { maxChars: 200, overlap: 40 });
    expect(withSyms).toEqual(plain);
  });

  it('returns [] for empty content', () => {
    expect(chunkCodeSymbols('', SYMS, { maxChars: 200, overlap: 0 })).toEqual([]);
  });
});
