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
