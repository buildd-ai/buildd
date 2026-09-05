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

/**
 * Real `git diff` output, metadata lines and all — every other fixture here is
 * hand-written LF text with clean ASCII symbols, which is exactly the shape
 * that hid the bug below.
 *
 * The second hunk header carries a bare CR inside its enclosing-line text.
 * Git copies that line verbatim and strips only trailing whitespace, so the CR
 * survives mid-header. `(.*)$` could not match it — `.` excludes every
 * LineTerminator and `$` without `m` only matches end-of-input — so the header
 * fell through to the context branch, the new-side counter never reset to 42,
 * and `const LATE = 3;` (head line 43) rendered as line 7.
 */
const REAL_GIT_DIFF_WITH_CR = [
  'diff --git a/a.ts b/a.ts',
  'index 3b18e51..a1b2c3d 100644',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -2,2 +2,3 @@ function a() {',
  '   const m = 1;',
  '+  const EARLY = 2;',
  ' }',
  '@@ -41 +42,2 @@ export const CRLF = "a\rb";',
  '   const p = 1;',
  '+  const LATE = 3;',
  '',
].join('\n');

describe('renderReviewerPatch — line numbers must match the file at head', () => {
  test('parses a hunk header whose enclosing line contains a CR', () => {
    const { text, citableLines, countMismatches } = renderReviewerPatch([
      { filename: 'a.ts', status: 'modified', additions: 2, deletions: 0, patch: REAL_GIT_DIFF_WITH_CR },
    ]);

    // Both added lines get their real head line numbers.
    expect(citableLines['a.ts']).toEqual([3, 43]);
    expect(text).toContain('43 +  const LATE = 3;');
    expect(text).toContain(' 3 +  const EARLY = 2;');

    // The regression: the second hunk swallowed as context numbered this 7.
    expect(text).not.toContain('7 +  const LATE = 3;');
    // ...and the header text leaked into the reviewable body.
    expect(text).not.toContain('@@ -41 +42,2 @@');

    expect(countMismatches).toEqual([]);
  });

  test('discards the whole file when a later hunk header will not parse', () => {
    // The dangerous shape: hunk one is fine, hunk two is not. Skipping the bad
    // header instead of failing merges hunk two into hunk one, and every line
    // after it is numbered against hunk one's origin — confident, wrong, and
    // indistinguishable from a correct rendering.
    const { text, citableLines, omittedFiles } = renderReviewerPatch([
      {
        filename: 'a.ts',
        status: 'modified',
        additions: 2,
        deletions: 0,
        patch: ['@@ -1,2 +1,3 @@ f', ' ctx', '+one', '@@ -x,y +z @@ g', '+two'].join('\n'),
      },
    ]);

    expect(omittedFiles).toEqual([{ filename: 'a.ts', reason: 'parse-failed' }]);
    expect(citableLines).toEqual({});
    // Partial evidence with wrong anchors is worse than declared absence.
    expect(text).not.toContain('+one');
    expect(text).not.toContain('+two');
    expect(text).toContain('## Patch Not Parsed');
  });

  test('skips pre-hunk git metadata rather than rendering it as content', () => {
    const { text } = renderReviewerPatch([
      { filename: 'a.ts', status: 'modified', additions: 2, deletions: 0, patch: REAL_GIT_DIFF_WITH_CR },
    ]);
    expect(text).not.toContain('diff --git');
    expect(text).not.toContain('index 3b18e51');
    expect(text).not.toContain('+++ b/a.ts');
  });

  test('strips a trailing CR from content lines', () => {
    const { text } = renderReviewerPatch([
      {
        filename: 'a.ts',
        status: 'modified',
        additions: 1,
        deletions: 1,
        patch: ['@@ -1,1 +1,1 @@ f', '-const b = 2;\r', '+const b = 3;\r'].join('\n'),
      },
    ]);
    expect(text).toContain('1 +const b = 3;\n');
    expect(text).not.toContain('\r');
  });

  test('does not render a phantom context line for a trailing newline', () => {
    const { text } = renderReviewerPatch([
      {
        filename: 'a.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        patch: '@@ -1,1 +1,2 @@ f\n ctx\n+one\n',
      },
    ]);
    const body = text.slice(text.indexOf('__new hunk__')).split('\n').slice(1);
    expect(body).toEqual(['   ctx', '2 +one']);
  });

  test('never emits line 0 as an anchor', () => {
    const { citableLines } = renderReviewerPatch([
      {
        filename: 'a.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        patch: '@@ -1,2 +0,0 @@ f\n+ghost',
      },
    ]);
    // A `+0,0` hunk has no added lines in practice; this only guarantees that
    // no rendering can point at a line that cannot exist.
    expect(citableLines['a.ts']).not.toContain(0);
  });
});

describe('renderReviewerPatch — citable anchors', () => {
  test('citableLines is authoritative where the rendered text is forgeable', () => {
    // A context line whose content begins with digits and a `+` — every doc,
    // test or fixture in this repo that shows a rendered diff does this.
    const forger: ReviewerPatchFile = {
      filename: 'docs/diff.md',
      status: 'modified',
      additions: 1,
      deletions: 0,
      patch: ['@@ -1,2 +1,2 @@ heading', ' 42 +const evil = 1;', '+real'].join('\n'),
    };
    const { text, citableLines } = renderReviewerPatch([forger]);

    expect(citableLines['docs/diff.md']).toEqual([2]);

    // Demonstrates why a downstream filter must not re-parse `text`: scraping
    // it accepts 42, an anchor the PR author chose.
    const scraped = text
      .split('\n')
      .filter((l) => /^\s*\d+ \+/.test(l))
      .map((l) => Number(/^\s*(\d+)/.exec(l)![1]));
    expect(scraped).toContain(42);
    expect(citableLines['docs/diff.md']).not.toContain(42);
  });

  test('omits files that are not in the text from citableLines', () => {
    const { citableLines } = renderReviewerPatch([
      FOO,
      { filename: 'gone.ts', status: 'removed', additions: 0, deletions: 4, patch: null },
    ]);
    expect(Object.keys(citableLines)).toEqual(['apps/web/src/lib/foo.ts']);
  });

  test("warns in text when the added-line count disagrees with GitHub's", () => {
    const { text, countMismatches } = renderReviewerPatch([
      {
        filename: 'a.ts',
        status: 'modified',
        additions: 5, // GitHub says five; the patch below holds one
        deletions: 0,
        patch: '@@ -1,1 +1,2 @@ f\n ctx\n+one',
      },
    ]);
    expect(countMismatches).toEqual(['a.ts']);
    expect(text).toContain('## Rendering Warnings');
    // The patch is still shown — the discrepancy is smaller than the evidence.
    expect(text).toContain('2 +one');
  });
});

describe('renderReviewerPatch — file classification', () => {
  test('separates an unparseable patch from a missing one', () => {
    const { text, omittedFiles, truncated } = renderReviewerPatch([
      FOO,
      {
        filename: 'weird.ts',
        status: 'modified',
        additions: 1,
        deletions: 1,
        patch: '@@@ -1,2 -1,2 +1,3 @@@\n++x\n  ctx',
      },
    ]);

    expect(omittedFiles).toContainEqual({ filename: 'weird.ts', reason: 'parse-failed' });
    expect(text).toContain('## Patch Not Parsed');
    // Blaming GitHub for a payload it did send points the reader at the wrong
    // system and hides the parser bug that actually caused it.
    expect(text).not.toContain('## No Patch Available');
    expect(truncated).toBe(true);
  });

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
      deletions: 2,
      patch: [
        '@@ -1,4 +1,1 @@ doomed',
        ' ctx',
        `-${'y'.repeat(2000)}`,
        `-${'z'.repeat(2000)}`,
        '@@ -20,1 +18,2 @@ kept',
        '+const kept = 1;',
      ].join('\n'),
    };
    const full = renderReviewerPatch([file]);
    const packed = renderReviewerPatch([file], {
      tokenBudget: Math.ceil(estimatePatchTokens(full.text) * 0.5),
    });

    expect(packed.deletionsStripped).toEqual(['a.ts']);
    // Said in the text, not just on the return object: without this note the
    // rendering is byte-identical to a complete diff of an additions-only file.
    expect(packed.text).toContain('(deletions omitted for space');
    expect(full.text).not.toContain('(deletions omitted for space');
    expect(packed.text).toContain('@@ ... @@ kept');
    expect(packed.text).toContain('18 +const kept = 1;');
    // The deletion-only hunk carries no citable line once its `-` lines are
    // gone, so keeping its context costs budget and buys nothing.
    expect(packed.text).not.toContain('@@ ... @@ doomed');
    expect(packed.text).not.toContain('y'.repeat(2000));
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
