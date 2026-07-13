import { describe, it, expect } from 'bun:test';
import {
  splitPatchHunks,
  chunkPrDiffFile,
  chunkPrDiff,
  PR_DIFF_CHUNK_OPTIONS,
} from '../knowledge-store/pr-diff-chunker';

const HUNK_A = [
  '@@ -1,4 +1,5 @@',
  ' import { a } from "./a";',
  '+import { b } from "./b";',
  ' export function main() {',
  '   return a();',
  ' }',
].join('\n');

const HUNK_B = [
  '@@ -20,3 +21,4 @@ export function helper() {',
  '   const x = 1;',
  '+  const y = 2;',
  '   return x;',
].join('\n');

const TWO_HUNK_PATCH = `${HUNK_A}\n${HUNK_B}`;

describe('splitPatchHunks', () => {
  it('splits a patch into one entry per @@ hunk header', () => {
    const hunks = splitPatchHunks(TWO_HUNK_PATCH);
    expect(hunks.length).toBe(2);
    expect(hunks[0]).toBe(HUNK_A);
    expect(hunks[1]).toBe(HUNK_B);
  });

  it('treats a patch without hunk headers as a single hunk', () => {
    const hunks = splitPatchHunks('just some text\nwithout headers');
    expect(hunks).toEqual(['just some text\nwithout headers']);
  });

  it('returns [] for empty input', () => {
    expect(splitPatchHunks('')).toEqual([]);
    expect(splitPatchHunks('   \n  ')).toEqual([]);
  });
});

describe('chunkPrDiffFile', () => {
  const meta = { prNumber: 42, sha: 'abc123' };

  it('produces a single chunk with the spec source_id for a small patch', () => {
    const chunks = chunkPrDiffFile({ path: 'src/app.ts', patch: TWO_HUNK_PATCH }, meta);
    expect(chunks.length).toBe(1);
    expect(chunks[0].id).toBe('pr:42#src/app.ts');
    expect(chunks[0].content).toContain('+import { b } from "./b";');
    expect(chunks[0].content).toContain('+  const y = 2;');
    expect(chunks[0].sourceType).toBe('pr');
    // sourcePath must be null: path-keyed supersession would otherwise mark
    // older PRs touching the same file as superseded (PR corpus is history).
    expect(chunks[0].sourcePath ?? null).toBeNull();
    expect(chunks[0].metadata).toMatchObject({ prNumber: 42, path: 'src/app.ts', sha: 'abc123' });
  });

  it('includes the file path and PR number in lexicalText for BM25', () => {
    const chunks = chunkPrDiffFile({ path: 'src/auth/login.ts', patch: HUNK_A }, meta);
    expect(chunks[0].lexicalText).toContain('src/auth/login.ts');
    expect(chunks[0].lexicalText).toContain('PR #42');
  });

  it('splits oversized patches into multiple chunks with deterministic ids', () => {
    const bigHunkLines = ['@@ -1,200 +1,200 @@'];
    for (let i = 0; i < 200; i++) bigHunkLines.push(`+const line${i} = ${'x'.repeat(40)};`);
    const chunks = chunkPrDiffFile(
      { path: 'src/big.ts', patch: bigHunkLines.join('\n') },
      meta,
    );
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].id).toBe('pr:42#src/big.ts');
    expect(chunks[1].id).toBe('pr:42#src/big.ts#2');
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(PR_DIFF_CHUNK_OPTIONS.maxChars * 1.2);
    }
    // Continuation chunks carry the hunk header for context
    expect(chunks[1].content.startsWith('@@')).toBe(true);
  });

  it('packs multiple small hunks into one chunk under the budget', () => {
    const chunks = chunkPrDiffFile({ path: 'src/app.ts', patch: TWO_HUNK_PATCH }, meta);
    expect(chunks.length).toBe(1);
  });

  it('returns [] when patch is missing or empty', () => {
    expect(chunkPrDiffFile({ path: 'a.bin' }, meta)).toEqual([]);
    expect(chunkPrDiffFile({ path: 'a.ts', patch: '' }, meta)).toEqual([]);
    expect(chunkPrDiffFile({ path: 'a.ts', patch: null }, meta)).toEqual([]);
  });

  it('passes through taskId/missionId/sourceTs and per-file sourceUrl', () => {
    const ts = new Date('2026-07-01T00:00:00Z');
    const chunks = chunkPrDiffFile(
      { path: 'src/app.ts', patch: HUNK_A, sourceUrl: 'https://example.com/raw.patch' },
      { prNumber: 7, taskId: 'task-1', missionId: 'mission-1', sourceTs: ts },
    );
    expect(chunks[0].metadata).toMatchObject({ prNumber: 7, taskId: 'task-1', missionId: 'mission-1' });
    expect(chunks[0].sourceTs).toBe(ts);
    expect(chunks[0].sourceUrl).toBe('https://example.com/raw.patch');
  });

  it('omits absent optional metadata keys', () => {
    const chunks = chunkPrDiffFile({ path: 'src/app.ts', patch: HUNK_A }, { prNumber: 7 });
    expect(chunks[0].metadata).not.toHaveProperty('taskId');
    expect(chunks[0].metadata).not.toHaveProperty('missionId');
    expect(chunks[0].metadata).not.toHaveProperty('sha');
  });
});

describe('chunkPrDiff', () => {
  it('chunks every file with a patch and skips files without one', () => {
    const chunks = chunkPrDiff(
      [
        { path: 'src/a.ts', patch: HUNK_A },
        { path: 'assets/logo.png' }, // binary — GitHub omits patch
        { path: 'src/b.ts', patch: HUNK_B },
      ],
      { prNumber: 9 },
    );
    const ids = chunks.map(c => c.id);
    expect(ids).toContain('pr:9#src/a.ts');
    expect(ids).toContain('pr:9#src/b.ts');
    expect(ids.some(id => id.includes('logo.png'))).toBe(false);
  });

  it('records the file status in metadata when provided', () => {
    const chunks = chunkPrDiff(
      [{ path: 'src/gone.ts', patch: HUNK_A, status: 'removed' }],
      { prNumber: 9 },
    );
    expect(chunks[0].metadata).toMatchObject({ status: 'removed' });
  });
});
