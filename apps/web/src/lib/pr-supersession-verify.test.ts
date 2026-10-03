import { describe, it, expect } from 'bun:test';
import {
  parseSupersessionClaims,
  patchIdOf,
  significantAddedLines,
  verifyByContent,
  verifyByPatchId,
  CONTENT_MATCH,
  type DiffFile,
} from './pr-supersession-verify';

const patch = (...added: string[]) => ['@@ -0,0 +1,' + added.length + ' @@', ...added.map(l => `+${l}`)].join('\n');

const DOC_LINES = [
  '# Strategy',
  'The mission organizer plans tasks from goal criteria.',
  'Each task is claimed by a runner and reports progress.',
  'Supersession records where closed work actually landed.',
  'Nothing is recorded from a claim alone.',
];

describe('parseSupersessionClaims', () => {
  it('reads the common phrasings, with and without a repo', () => {
    const claims = parseSupersessionClaims(
      'Closing — superseded by #3366. Also duplicate of other-org/docs#12, replaced by https://github.com/acme/kb/pull/7, in favour of PR #40',
      'acme/web',
    );
    expect(claims).toEqual([
      { repo: 'acme/web', prNumber: 3366 },
      { repo: 'other-org/docs', prNumber: 12 },
      { repo: 'acme/kb', prNumber: 7 },
      { repo: 'acme/web', prNumber: 40 },
    ]);
  });

  it('ignores a bare PR mention with no supersession phrase', () => {
    expect(parseSupersessionClaims('See #12 for context', 'acme/web')).toEqual([]);
  });

  it('dedupes repeated claims', () => {
    expect(parseSupersessionClaims('superseded by #5. Superseded by #5', 'a/b')).toEqual([{ repo: 'a/b', prNumber: 5 }]);
  });
});

describe('significantAddedLines', () => {
  it('drops removed, context, blank and punctuation-only lines', () => {
    const p = ['@@ -1,3 +1,4 @@', ' context line here', '-old line removed', '+  new real line  ', '+}', '+', '+});'].join('\n');
    expect(significantAddedLines(p)).toEqual(['new real line']);
  });
});

describe('verifyByContent', () => {
  it('verifies when the candidate added the same lines at the same path (squash)', () => {
    const closed: DiffFile[] = [{ filename: 'docs/strategy.md', status: 'added', patch: patch(...DOC_LINES) }];
    const cand: DiffFile[] = [{ filename: 'docs/strategy.md', status: 'added', patch: patch(...DOC_LINES, 'One more line in the squash.') }];
    const r = verifyByContent(closed, cand);
    expect(r.verified).toBe(true);
    expect(r.ratio).toBe(1);
  });

  it('verifies a cross-repo move by path suffix', () => {
    const closed: DiffFile[] = [{ filename: 'design/strategy.md', status: 'added', patch: patch(...DOC_LINES) }];
    const cand: DiffFile[] = [{ filename: 'buildd/design/strategy.md', status: 'added', patch: patch(...DOC_LINES) }];
    expect(verifyByContent(closed, cand).verified).toBe(true);
  });

  it('verifies by identical blob sha even when patches are missing', () => {
    const closed: DiffFile[] = [{ filename: 'a/big.json', status: 'added', sha: 'abc123', patch: null }];
    const cand: DiffFile[] = [{ filename: 'b/moved-big.json', status: 'added', sha: 'abc123', patch: null }];
    const r = verifyByContent(closed, cand);
    expect(r.verified).toBe(true);
    expect(r.blobMatches).toBe(1);
  });

  it('does NOT verify when the candidate shares no content (the false-claim case)', () => {
    const closed: DiffFile[] = [{ filename: 'docs/strategy.md', status: 'added', patch: patch(...DOC_LINES) }];
    const cand: DiffFile[] = [{ filename: 'apps/web/src/lib/unrelated.ts', status: 'modified', patch: patch('export const unrelated = 1;', 'export function other() { return 2; }', 'const third = "x";') }];
    const r = verifyByContent(closed, cand);
    expect(r.verified).toBe(false);
    expect(r.ratio).toBe(0);
  });

  it('does NOT verify on partial overlap below the ratio', () => {
    const closed: DiffFile[] = [{ filename: 'docs/strategy.md', status: 'added', patch: patch(...DOC_LINES) }];
    const cand: DiffFile[] = [{ filename: 'docs/strategy.md', status: 'added', patch: patch(DOC_LINES[0], DOC_LINES[1]) }];
    const r = verifyByContent(closed, cand);
    expect(r.verified).toBe(false);
    expect(r.ratio).toBeLessThan(CONTENT_MATCH.minLineRatio);
  });

  it('does not credit lines the candidate did not add (attribution)', () => {
    // Same path, but the candidate's own diff added nothing of the closed PR's.
    const closed: DiffFile[] = [{ filename: 'docs/strategy.md', status: 'modified', patch: patch(...DOC_LINES) }];
    const cand: DiffFile[] = [{ filename: 'docs/strategy.md', status: 'modified', patch: ['@@ -1 +1 @@', '-typo', '+fixed typo in the heading'].join('\n') }];
    expect(verifyByContent(closed, cand).verified).toBe(false);
  });

  it('refuses to verify a change too small to tell apart from coincidence', () => {
    const closed: DiffFile[] = [{ filename: 'x.ts', status: 'modified', patch: patch('const enabled = true;') }];
    const cand: DiffFile[] = [{ filename: 'x.ts', status: 'modified', patch: patch('const enabled = true;') }];
    expect(verifyByContent(closed, cand).verified).toBe(false);
  });

  it('uses fetched candidate contents for a new file whose patch GitHub omitted', () => {
    const closed: DiffFile[] = [{ filename: 'docs/strategy.md', status: 'added', patch: patch(...DOC_LINES) }];
    const cand: DiffFile[] = [{ filename: 'docs/strategy.md', status: 'added', patch: null }];
    const contents = new Map([['docs/strategy.md', DOC_LINES.join('\n')]]);
    expect(verifyByContent(closed, cand, contents).verified).toBe(true);
  });
});

describe('patch-id', () => {
  const commitA: DiffFile[] = [{ filename: 'src/a.ts', patch: ['@@ -1,2 +1,2 @@', '-const a = 1;', '+const a = 2;'].join('\n') }];
  const commitASameDiffDifferentLines: DiffFile[] = [{ filename: 'src/a.ts', patch: ['@@ -10,2 +10,2 @@', '-const  a = 1;', '+const a =  2;'].join('\n') }];
  const commitB: DiffFile[] = [{ filename: 'src/b.ts', patch: ['@@ -1 +1 @@', '-x', '+y'].join('\n') }];

  it('ignores line numbers and whitespace, like git patch-id', () => {
    expect(patchIdOf(commitA)).toBe(patchIdOf(commitASameDiffDifferentLines));
    expect(patchIdOf(commitA)).not.toBe(patchIdOf(commitB));
  });

  it('is null when a file has no patch (cannot be computed)', () => {
    expect(patchIdOf([{ filename: 'bin.png', patch: null }])).toBeNull();
  });

  it('verifies when every closed commit has an equivalent candidate commit', () => {
    expect(verifyByPatchId([commitA], [commitB, commitASameDiffDifferentLines]).verified).toBe(true);
  });

  it('does not verify when one closed commit is missing from the candidate', () => {
    expect(verifyByPatchId([commitA, commitB], [commitA]).verified).toBe(false);
  });
});
