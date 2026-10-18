/**
 * AC-24 (spec r7 §7): each review round reads the same way on every surface, as
 * buildd's verdict at the head it judged, and says that GitHub lists buildd's own
 * reviews as Commented, so a reader on GitHub does not take "Commented" for "no
 * changes requested".
 */
import { describe, expect, test } from 'bun:test';
import { GITHUB_COMMENTED_NOTE, githubReviewStatesLine, reviewRoundsOf } from './delivery-rounds';
import type { RoundSnapshot } from './types';

const R = (n: number, o: Partial<RoundSnapshot> = {}): RoundSnapshot => ({
  id: `r${n}`, round: n, headSha: `${n}aaaaaaabbbbbbb`, kind: 'full', status: 'decided',
  verdict: 'request_changes', effectiveVerdict: 'request_changes', failureCount: 0, ...o,
});

describe('reviewRoundsOf', () => {
  test('null before the first round', () => {
    expect(reviewRoundsOf([])).toBeNull();
  });

  test('two decided rounds: one line, oldest first, with the GitHub note', () => {
    const r = reviewRoundsOf([R(2), R(1)])!;
    expect(r.line).toBe('Round 1 at 1aaaaaa: changes requested · Round 2 at 2aaaaaa: changes requested');
    expect(r.githubNote).toBe(GITHUB_COMMENTED_NOTE);
    expect(r.githubNote).toContain('Commented');
    expect(r.rounds.map((x) => x.verdict)).toEqual(['request_changes', 'request_changes']);
  });

  test('the effective verdict wins: an approval the kernel withdrew reads as changes requested', () => {
    const r = reviewRoundsOf([R(1, { verdict: 'approve', effectiveVerdict: 'request_changes' })])!;
    expect(r.line).toBe('Round 1 at 1aaaaaa: changes requested');
  });

  test('a round in flight or failed says so, and a superseded one is left out', () => {
    const r = reviewRoundsOf([
      R(1, { verdict: 'approve', effectiveVerdict: 'approve' }),
      R(2, { status: 'superseded', verdict: null, effectiveVerdict: null }),
      R(3, { status: 'reviewing', verdict: null, effectiveVerdict: null }),
    ])!;
    expect(r.line).toBe('Round 1 at 1aaaaaa: approved · Round 3 at 3aaaaaa: in review');
    expect(reviewRoundsOf([R(1, { status: 'queued', verdict: null, effectiveVerdict: null })])!.line).toBe('Round 1 at 1aaaaaa: waiting for review');
    expect(reviewRoundsOf([R(1, { status: 'failed', verdict: null, effectiveVerdict: null })])!.line).toBe('Round 1 at 1aaaaaa: review did not finish');
  });

  test('no note until buildd has posted a verdict', () => {
    expect(reviewRoundsOf([R(1, { status: 'queued', verdict: null, effectiveVerdict: null })])!.githubNote).toBeNull();
  });
});

describe('githubReviewStatesLine (AC-24): GitHub\'s formal states, kept apart from buildd\'s verdict', () => {
  test('counts in words, GitHub\'s own state names', () => {
    expect(githubReviewStatesLine({ approved: 0, changesRequested: 0, commented: 2 })).toBe('On GitHub: two reviews Commented');
    expect(githubReviewStatesLine({ approved: 1, changesRequested: 1, commented: 1 })).toBe('On GitHub: one review Approved, one Changes requested, one Commented');
  });
  test('null when GitHub has no review', () => {
    expect(githubReviewStatesLine({ approved: 0, changesRequested: 0, commented: 0 })).toBeNull();
    expect(githubReviewStatesLine(null)).toBeNull();
    expect(githubReviewStatesLine({ approved: 0, changesRequested: 0 })).toBeNull();
  });
});

test('one basis for every GitHub state: each reviewer once', async () => {
  const { githubReviewCounts } = await import('@buildd/shared');
  const c = githubReviewCounts([
    { user: { login: 'bot' }, state: 'COMMENTED' }, { user: { login: 'bot' }, state: 'COMMENTED' },
    { user: { login: 'a' }, state: 'APPROVED' }, { user: { login: 'a' }, state: 'COMMENTED' },
    { user: { login: 'b' }, state: 'CHANGES_REQUESTED' }, { user: { login: 'b' }, state: 'APPROVED' },
  ]);
  expect(c).toEqual({ approved: 2, changesRequested: 0, pending: 0, commented: 1 });
  expect(githubReviewStatesLine(c)).toBe('On GitHub: two reviews Approved, one Commented');
});
