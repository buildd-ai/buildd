import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { stripNulBytes, sanitizeChunkForInsert } from '../knowledge-store/pg-vector-store';
import type { UpsertChunk } from '../knowledge-store/types';

// ── Regression test for CI run 29193684601 / job 86652754635 ────────────────
//
// The "Ingest code corpus (apps/)" step crashed with:
//   NeonDbError: invalid byte sequence for encoding "UTF8": 0x00
//   where: "unnamed portal parameter $7"
// Postgres text columns reject literal NUL bytes. A stray NUL byte can end up
// in chunk content via a misclassified binary file or an upstream encoding
// artifact — the pipeline needs to sanitize defensively before insert rather
// than crash the whole ingest run.

// Built at runtime (not as a literal escape) so no raw NUL byte ends up
// embedded in this source file itself.
const NUL = String.fromCharCode(0);

describe('stripNulBytes', () => {
  it('removes a single embedded NUL byte', () => {
    const withNul = `const x = "hello${NUL}world";`;
    expect(stripNulBytes(withNul)).toBe('const x = "helloworld";');
  });

  it('removes multiple NUL bytes anywhere in the string', () => {
    const withNul = `${NUL}abc${NUL}def${NUL}`;
    expect(stripNulBytes(withNul)).toBe('abcdef');
  });

  it('returns the same string reference when there is no NUL byte (fast path)', () => {
    const clean = 'export function add(a: number, b: number) { return a + b; }';
    expect(stripNulBytes(clean)).toBe(clean);
  });

  it('leaves other whitespace/control characters untouched', () => {
    const text = 'line1\nline2\ttabbed\r\n';
    expect(stripNulBytes(text)).toBe(text);
  });
});

describe('sanitizeChunkForInsert', () => {
  let warnSpy: ReturnType<typeof mock>;
  let originalWarn: typeof console.warn;

  beforeEach(() => {
    originalWarn = console.warn;
    warnSpy = mock(() => {});
    console.warn = warnSpy as unknown as typeof console.warn;
  });

  afterEach(() => {
    console.warn = originalWarn;
  });

  function makeChunk(overrides: Partial<UpsertChunk> = {}): UpsertChunk {
    return {
      id: 'web/src/lib/schedule-health.ts#1',
      content: 'export function checkScheduleHealth() { /* ok */ }',
      sourceType: 'code',
      sourcePath: 'web/src/lib/schedule-health.ts',
      sourceUrl: null,
      ...overrides,
    };
  }

  it('strips a NUL byte from chunk content before it would hit the INSERT', () => {
    const chunk = makeChunk({ content: `export function f() {${NUL}${NUL} return 1; }` });
    const result = sanitizeChunkForInsert(chunk, chunk.content);

    expect(result.content).not.toContain(NUL);
    expect(result.content).toBe('export function f() { return 1; }');
  });

  it('strips a NUL byte from lexicalText independently of content', () => {
    const chunk = makeChunk();
    const lexicalText = `${chunk.sourcePath}\n\n${chunk.content}${NUL}`;
    const result = sanitizeChunkForInsert(chunk, lexicalText);

    expect(result.lexicalText).not.toContain(NUL);
    expect(result.content).not.toContain(NUL);
  });

  it('strips NUL bytes from sourceId, sourceType, sourcePath, and sourceUrl defensively', () => {
    const chunk = makeChunk({
      id: `bad${NUL}id#1`,
      sourceType: `co${NUL}de`,
      sourcePath: `web/src/lib/sched${NUL}ule-health.ts`,
      sourceUrl: `https://example.com/${NUL}x`,
    });
    const result = sanitizeChunkForInsert(chunk, chunk.content);

    expect(result.sourceId).toBe('badid#1');
    expect(result.sourceType).toBe('code');
    expect(result.sourcePath).toBe('web/src/lib/schedule-health.ts');
    expect(result.sourceUrl).toBe('https://example.com/x');
  });

  it('logs a warning identifying the offending chunk when a NUL byte is stripped', () => {
    const chunk = makeChunk({ content: `bad${NUL}content` });
    sanitizeChunkForInsert(chunk, chunk.content);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [message] = warnSpy.mock.calls[0] as [string];
    expect(message).toContain(chunk.id);
    expect(message).toContain(chunk.sourcePath!);
  });

  it('does not warn when content is already clean', () => {
    const chunk = makeChunk();
    sanitizeChunkForInsert(chunk, chunk.content);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('passes through null sourcePath/sourceUrl unchanged', () => {
    const chunk = makeChunk({ sourcePath: null, sourceUrl: null });
    const result = sanitizeChunkForInsert(chunk, chunk.content);
    expect(result.sourcePath).toBeNull();
    expect(result.sourceUrl).toBeNull();
  });
});
