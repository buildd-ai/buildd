import { describe, test, expect } from 'bun:test';
import {
  renderReviewerPatch,
  estimatePatchTokens,
  REVIEWER_PATCH_TOKEN_BUDGET,
  type ReviewerPatchFile,
} from './reviewer-patch';

/**
 * A small modified file: one line replaced, one line added, two context lines.
 * New side starts at line 1, so the two added lines are new-file lines 2 and 3.
 */
const FOO: ReviewerPatchFile = {
  filename: 'apps/web/src/lib/foo.ts',
  status: 'modified',
  additions: 2,
  deletions: 1,
  patch: [
    '@@ -1,4 +1,5 @@ export function foo() {',
    ' const a = 1;',
    '-const b = 2;',
    '+const b = 3;',
    '+const c = 4;',
    ' return a;',
  ].join('\n'),
};

/** Pure addition — no `-` lines anywhere, so `__old hunk__` must not appear. */
const ADDED_ONLY: ReviewerPatchFile = {
  filename: 'apps/web/src/lib/bar.ts',
  status: 'added',
  additions: 2,
  deletions: 0,
  patch: ['@@ -0,0 +1,2 @@', '+export const bar = 1;', '+export const baz = 2;'].join('\n'),
};

function fileBlock(text: string, filename: string): string {
  const blocks = text.split(/\n(?=## File: )/);
  const match = blocks.find((b) => b.startsWith(`## File: '${filename}'`));
  if (!match) throw new Error(`no block for ${filename} in:\n${text}`);
  return match;
}

describe('renderReviewerPatch — hunk format', () => {
  test('renders a per-file header, a symbol-bearing hunk header and a __new hunk__', () => {
    const { text } = renderReviewerPatch([FOO]);
    const block = fileBlock(text, 'apps/web/src/lib/foo.ts');

    expect(block).toContain("## File: 'apps/web/src/lib/foo.ts'");
    // Ranges are replaced by `...` — the inline line numbers are the citable
    // coordinates, and duplicating them in the header invites the model to cite
    // the header's numbers instead.
    expect(block).toContain('@@ ... @@ export function foo() {');
    expect(block).not.toContain('@@ -1,4 +1,5 @@');
    expect(block).toContain('__new hunk__');
  });

  test('numbers only the added lines; context lines carry no number', () => {
    const { text } = renderReviewerPatch([FOO]);
    const lines = fileBlock(text, 'apps/web/src/lib/foo.ts').split('\n');

    // Added lines are numbered with their new-file line number.
    expect(lines).toContain('2 +const b = 3;');
    expect(lines).toContain('3 +const c = 4;');

    // Context lines are present, aligned, and unnumbered — a reviewer that
    // cites a line number is therefore citing a line this PR added.
    expect(lines).toContain('   const a = 1;');
    expect(lines).toContain('   return a;');

    const numbered = lines.filter((l) => /^\s*\d+\s/.test(l));
    expect(numbered.every((l) => /^\s*\d+ \+/.test(l))).toBe(true);
    expect(numbered).toHaveLength(2);
  });

  test('pads line numbers to a common width within a file', () => {
    const wide: ReviewerPatchFile = {
      filename: 'a.ts',
      status: 'modified',
      additions: 2,
      deletions: 0,
      patch: ['@@ -9,2 +9,4 @@ fn', ' ctx', '+nine', '@@ -100,1 +102,2 @@ fn2', '+onehundred'].join(
        '\n',
      ),
    };
    const lines = renderReviewerPatch([wide]).text.split('\n');
    expect(lines).toContain(' 10 +nine');
    expect(lines).toContain('102 +onehundred');
    expect(lines).toContain('     ctx');
  });

  test('renders __old hunk__ without line numbers, excluding added lines', () => {
    const { text } = renderReviewerPatch([FOO]);
    const block = fileBlock(text, 'apps/web/src/lib/foo.ts');
    const old = block.slice(block.indexOf('__old hunk__'));

    expect(old).toContain('-const b = 2;');
    expect(old).toContain(' const a = 1;');
    expect(old).not.toContain('const c = 4;');
    expect(old.split('\n').some((l) => /^\s*\d/.test(l))).toBe(false);
  });

  test('omits __old hunk__ entirely when the file only added lines', () => {
    const { text } = renderReviewerPatch([ADDED_ONLY]);
    const block = fileBlock(text, 'apps/web/src/lib/bar.ts');
    expect(block).toContain('__new hunk__');
    expect(block).not.toContain('__old hunk__');
  });

  test('names the previous path for a renamed file', () => {
    const { text } = renderReviewerPatch([
      { ...FOO, filename: 'new/foo.ts', status: 'renamed', previousFilename: 'old/foo.ts' },
    ]);
    expect(text).toContain("## File: 'new/foo.ts' (renamed from 'old/foo.ts')");
  });

  test('skips the no-newline marker rather than numbering it', () => {
    const { text } = renderReviewerPatch([
      {
        filename: 'a.ts',
        status: 'modified',
        additions: 1,
        deletions: 1,
        patch: ['@@ -1,1 +1,1 @@', '-old', '+new', '\\ No newline at end of file'].join('\n'),
      },
    ]);
    expect(text).not.toContain('No newline at end of file');
    expect(text).toContain('1 +new');
  });
});

describe('renderReviewerPatch — file classification', () => {
  test('collapses deleted files to a name list with no patch body', () => {
    const { text, omittedFiles } = renderReviewerPatch([
      FOO,
      { filename: 'gone.ts', status: 'removed', additions: 0, deletions: 40, patch: '@@ -1,40 +0,0 @@\n-x' },
    ]);

    expect(text).toContain('## Deleted Files');
    expect(text).toContain('- gone.ts');
    expect(text).not.toContain("## File: 'gone.ts'");
    expect(omittedFiles).toContainEqual({ filename: 'gone.ts', reason: 'deleted' });
  });

  test('lists files GitHub returned no patch for, and says they are unreviewed', () => {
    const { text, omittedFiles } = renderReviewerPatch([
      FOO,
      { filename: 'logo.png', status: 'modified', additions: 0, deletions: 0, patch: null },
    ]);

    expect(text).toContain('## No Patch Available');
    expect(text).toContain('- logo.png');
    expect(omittedFiles).toContainEqual({ filename: 'logo.png', reason: 'no-patch' });
  });

  test('returns an empty section for an empty file list', () => {
    const result = renderReviewerPatch([]);
    expect(result.text).toBe('');
    expect(result.includedFiles).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  test('reports totals across every file, including omitted ones', () => {
    const { text } = renderReviewerPatch([
      FOO,
      { filename: 'gone.ts', status: 'removed', additions: 0, deletions: 40, patch: null },
    ]);
    expect(text).toContain('## PR Diff (+2/-41 across 2 files)');
  });
});

describe('renderReviewerPatch — token budget', () => {
  function bigFile(name: string, addedLines: number): ReviewerPatchFile {
    const added = Array.from({ length: addedLines }, (_, i) => `+// added line ${i} ${'x'.repeat(60)}`);
    const removed = Array.from({ length: addedLines }, (_, i) => `-// removed line ${i} ${'x'.repeat(60)}`);
    return {
      filename: name,
      status: 'modified',
      additions: addedLines,
      deletions: addedLines,
      patch: [`@@ -1,${addedLines} +1,${addedLines} @@ fn`, ...removed, ...added].join('\n'),
    };
  }

  test('lists overflow by filename only, under an explicit budget heading', () => {
    const files = [bigFile('a.ts', 60), bigFile('b.ts', 60), bigFile('c.ts', 60)];
    const { text, omittedFiles, truncated } = renderReviewerPatch(files, { tokenBudget: 1200 });

    expect(truncated).toBe(true);
    const overflow = omittedFiles.filter((f) => f.reason === 'token-budget');
    expect(overflow.length).toBeGreaterThan(0);

    expect(text).toContain('## Not Reviewed — Token Budget');
    // The heading exists so absence cannot be read as cleanliness.
    expect(text).toMatch(/not reviewed/i);

    for (const f of overflow) {
      expect(text).toContain(`- ${f.filename}`);
      expect(text).not.toContain(`## File: '${f.filename}'`);
    }
  });

  test('drops __old hunk__ before it drops a whole file — additions win the budget', () => {
    // Sized so that both files fit with additions only, but not with deletions.
    const files = [bigFile('a.ts', 40), bigFile('b.ts', 40)];
    const full = renderReviewerPatch(files, { tokenBudget: REVIEWER_PATCH_TOKEN_BUDGET });
    expect(full.deletionsStripped).toEqual([]);

    const budget = Math.ceil(estimatePatchTokens(full.text) * 0.7);
    const packed = renderReviewerPatch(files, { tokenBudget: budget });

    expect(packed.includedFiles).toEqual(['a.ts', 'b.ts']);
    expect(packed.omittedFiles.filter((f) => f.reason === 'token-budget')).toEqual([]);
    expect(packed.deletionsStripped.length).toBeGreaterThan(0);
    expect(packed.truncated).toBe(true);
  });

  test('strips deletion-only hunks from a file whose deletions were dropped', () => {
    const file: ReviewerPatchFile = {
      filename: 'a.ts',
      status: 'modified',
      additions: 1,
      deletions: 3,
      patch: [
        '@@ -1,4 +1,1 @@ doomed',
        ' ctx',
        `-${'y'.repeat(300)}`,
        `-${'z'.repeat(300)}`,
        '@@ -20,1 +18,2 @@ kept',
        '+const kept = 1;',
      ].join('\n'),
    };
    const full = renderReviewerPatch([file]);
    const packed = renderReviewerPatch([file], {
      tokenBudget: Math.ceil(estimatePatchTokens(full.text) * 0.5),
    });

    expect(packed.deletionsStripped).toEqual(['a.ts']);
    expect(packed.text).toContain('@@ ... @@ kept');
    expect(packed.text).toContain('18 +const kept = 1;');
    // The deletion-only hunk carries no citable line once its `-` lines are
    // gone, so keeping its context costs budget and buys nothing.
    expect(packed.text).not.toContain('@@ ... @@ doomed');
    expect(packed.text).not.toContain('y'.repeat(300));
  });

  test('never exceeds the budget it was given', () => {
    const files = Array.from({ length: 12 }, (_, i) => bigFile(`f${i}.ts`, 30));
    for (const budget of [400, 1500, 6000]) {
      const { text } = renderReviewerPatch(files, { tokenBudget: budget });
      expect(estimatePatchTokens(text)).toBeLessThanOrEqual(budget);
    }
  });

  test('counts the omission manifest against the budget, not just the patch text', () => {
    // A long deleted-file list is a real cost: if the packer spends the whole
    // budget on patch text and then appends the manifest, the rendering blows
    // the ceiling by exactly the size of the manifest.
    const deleted = Array.from({ length: 30 }, (_, i) => ({
      filename: `apps/web/src/app/api/legacy/deep/nested/route-${i}.ts`,
      status: 'removed',
      additions: 0,
      deletions: 12,
      patch: null,
    }));
    const files = [bigFile('a.ts', 25), bigFile('b.ts', 25), bigFile('c.ts', 25), ...deleted];

    const budget = 1200;
    const result = renderReviewerPatch(files, { tokenBudget: budget });

    expect(estimatePatchTokens(result.text)).toBeLessThanOrEqual(budget);
    expect(result.estimatedTokens).toBeLessThanOrEqual(budget);
    // The manifest is not what got cut — patch text is.
    expect(result.text).toContain('## Deleted Files');
    expect(result.omittedFiles.some((f) => f.reason === 'token-budget')).toBe(true);
  });

  test('keeps the omission manifest even when it alone exceeds the budget', () => {
    const deleted = Array.from({ length: 40 }, (_, i) => ({
      filename: `apps/web/src/app/api/legacy/deep/nested/route-${i}.ts`,
      status: 'removed',
      additions: 0,
      deletions: 12,
      patch: null,
    }));
    const result = renderReviewerPatch([bigFile('a.ts', 20), ...deleted], { tokenBudget: 40 });

    // No patch text fits, but the reviewer is still told what changed —
    // silence here would read as "nothing else to review".
    expect(result.includedFiles).toEqual([]);
    expect(result.text).toContain('## Deleted Files');
    expect(result.text).toContain('## Not Reviewed — Token Budget');
    // And the overrun is reported rather than hidden.
    expect(result.estimatedTokens).toBe(estimatePatchTokens(result.text));
    expect(result.estimatedTokens).toBeGreaterThan(40);
  });

  test('caps each manifest list rather than listing an unbounded number of files', () => {
    const deleted = Array.from({ length: 120 }, (_, i) => ({
      filename: `pkg/gen/file-${i}.ts`,
      status: 'removed',
      additions: 0,
      deletions: 1,
      patch: null,
    }));
    const { text, omittedFiles } = renderReviewerPatch(deleted);

    expect(text).toContain('- pkg/gen/file-0.ts');
    expect(text).not.toContain('- pkg/gen/file-119.ts');
    expect(text).toContain('… and 70 more');
    // The result object still accounts for every file, capped or not.
    expect(omittedFiles).toHaveLength(120);
  });

  test('always renders the overflow list, even when no file fits at all', () => {
    const files = [bigFile('a.ts', 200)];
    const { text, includedFiles, omittedFiles } = renderReviewerPatch(files, { tokenBudget: 60 });
    expect(includedFiles).toEqual([]);
    expect(omittedFiles).toEqual([{ filename: 'a.ts', reason: 'token-budget' }]);
    expect(text).toContain('## Not Reviewed — Token Budget');
    expect(text).toContain('- a.ts');
  });
});
