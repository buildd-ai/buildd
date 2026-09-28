/**
 * What counts as "this reverts that": the reference parser behind the
 * pr_reverts ledger, which blocks candidate promotion (memory-lifecycle).
 */
import { describe, it, expect } from 'bun:test';
import { parseRevertReferences, prRevertRows } from '../pr-reverts';

const REPO = 'acme/widgets';

describe('parseRevertReferences', () => {
  it("reads GitHub's revert PR body: Reverts owner/repo#N", () => {
    expect(parseRevertReferences('Reverts acme/widgets#123', REPO)).toEqual({ prNumbers: [123], shas: [] });
  });

  it('reads a revert title that carries the original squash suffix', () => {
    expect(parseRevertReferences('Revert "feat: add thing (#88)"', REPO).prNumbers).toEqual([88]);
  });

  it('reads a PR URL on a revert line', () => {
    expect(parseRevertReferences('This PR reverts https://github.com/acme/widgets/pull/7 because it broke CI', REPO).prNumbers).toEqual([7]);
  });

  it('reads git revert commit messages: This reverts commit <sha>', () => {
    const msg = 'Revert "fix: thing"\n\nThis reverts commit 0123456789abcdef0123456789abcdef01234567.';
    expect(parseRevertReferences(msg, REPO).shas).toEqual(['0123456789abcdef0123456789abcdef01234567']);
  });

  it('keeps an abbreviated sha of 7+ hex chars, lowercased; ignores shorter ones', () => {
    expect(parseRevertReferences('This reverts commit ABCDEF1.', REPO).shas).toEqual(['abcdef1']);
    expect(parseRevertReferences('This reverts commit abc12.', REPO).shas).toEqual([]);
  });

  it('a reference on a line with no revert language is not a revert', () => {
    expect(parseRevertReferences('Follow-up to #123\n\nCloses #124', REPO)).toEqual({ prNumbers: [], shas: [] });
  });

  it("another repo's PR is not this repo's", () => {
    expect(parseRevertReferences('Reverts other/repo#5', REPO).prNumbers).toEqual([]);
    expect(parseRevertReferences('Reverts https://github.com/other/repo/pull/5', REPO).prNumbers).toEqual([]);
    expect(parseRevertReferences('Reverts ACME/Widgets#5', REPO).prNumbers).toEqual([5]);
  });

  it('dedupes and tolerates empty input', () => {
    expect(parseRevertReferences('Revert #3\nReverts acme/widgets#3', REPO).prNumbers).toEqual([3]);
    expect(parseRevertReferences(null, REPO)).toEqual({ prNumbers: [], shas: [] });
  });
});

describe('prRevertRows', () => {
  it('one row per reference, keyed so a redelivery inserts nothing new', () => {
    const rows = prRevertRows({
      workspaceId: 'ws-1', repo: REPO, revertedBy: 'pr#130',
      text: 'Reverts acme/widgets#123\n\nThis reverts commit abcdef1234567.',
    });
    expect(rows).toEqual([
      { workspaceId: 'ws-1', repo: REPO, revertedBy: 'pr#130', revertedPrNumber: 123, revertedSha: null, dedupeKey: 'pr#130>pr#123' },
      { workspaceId: 'ws-1', repo: REPO, revertedBy: 'pr#130', revertedPrNumber: null, revertedSha: 'abcdef1234567', dedupeKey: 'pr#130>abcdef1234567' },
    ]);
  });

  it('a PR never reverts itself', () => {
    expect(prRevertRows({ workspaceId: 'ws-1', repo: REPO, revertedBy: 'pr#9', revertingPrNumber: 9, text: 'Revert #9' })).toEqual([]);
  });

  it('a commit never reverts itself', () => {
    const sha = 'abcdef1234567890abcdef1234567890abcdef12';
    expect(prRevertRows({ workspaceId: 'ws-1', repo: REPO, revertedBy: sha, text: `This reverts commit ${sha.slice(0, 10)}.` })).toEqual([]);
  });
});
