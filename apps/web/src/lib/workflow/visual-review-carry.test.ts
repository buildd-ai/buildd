import { describe, expect, it } from 'bun:test';
import { resolveVisualReviewPolicy } from './visual-review-policy';
import { deriveMissionVisualReview, type VisualReviewStateInput } from './visual-review-state';
import { judgeReviewCarry, readReviewCarry, uiDeltaLine } from './visual-review-carry';

const ui = { path: 'apps/web/src/components/Card.tsx', patch: '@@ -1 +1 @@\n-<div className="a">Hi there</div>\n+<div className="b">Hi there</div>' };
const migration = { path: 'packages/core/drizzle/20261027_x/migration.sql', patch: '+ALTER TABLE t ADD c int;' };

describe('judgeReviewCarry', () => {
  it('a migration-only commit after the reviewed sha carries the review', () => {
    expect(judgeReviewCarry([ui], [ui, migration])).toEqual({ state: 'carried', files: [] });
  });
  it('a dev merge adds nothing to the branch-vs-trunk diff, so it carries', () => {
    expect(judgeReviewCarry([ui], [ui])).toEqual({ state: 'carried', files: [] });
  });
  it('a new UI file voids it and names the file', () => {
    const page = { path: 'apps/web/src/app/app/x/page.tsx', patch: '+<main>Hello there</main>' };
    expect(judgeReviewCarry([ui], [ui, page])).toEqual({ state: 'changed', files: [page.path] });
  });
  it('an edited UI file voids it', () => {
    expect(judgeReviewCarry([ui], [{ ...ui, patch: ui.patch + '\n+<p>more words</p>' }]).state).toBe('changed');
  });
  it('a UI file with no patch cannot be shown unchanged', () => {
    expect(judgeReviewCarry([{ ...ui, patch: null }], [{ ...ui, patch: null }]).state).toBe('changed');
  });
});

describe('a review across a migration-only commit', () => {
  const input = (carry: VisualReviewStateInput['carry']): VisualReviewStateInput => ({
    policy: resolveVisualReviewPolicy({}),
    uiChange: { state: 'yes', source: 'diff', uiFiles: 1 },
    audit: { id: 't1', createdAt: '2026-10-01T00:00:00Z', errorType: null, status: 'completed' },
    review: { phase: 'reviewed', screens: 4, effectiveIssues: 0, awaitingHuman: 0, openFixes: 0, roundCapOpen: false, needsYouReason: null, captured: 0, expected: null },
    waiver: null,
    auditedSha: '1b7fc6c',
    carry,
    branch: { headSha: 'f00dbab', base: 'dev', integrationPr: { number: 9, state: 'open', ready: true, blocked: false }, workLanded: true },
  });
  it('stays passed, recorded as carried from the reviewed sha', () => {
    const s = deriveMissionVisualReview(input({ headSha: 'f00dbab', from: '1b7fc6c', state: 'carried', files: [] }));
    expect(s).toMatchObject({ status: 'passed', staleEvidence: false, pendingVerification: false, carriedFrom: '1b7fc6c' });
  });
  it('is owed again, with the files, when the UI moved', () => {
    const s = deriveMissionVisualReview(input({ headSha: 'f00dbab', from: '1b7fc6c', state: 'changed', files: ['apps/web/src/components/Card.tsx'] }));
    expect(s).toMatchObject({ status: 'needed', staleEvidence: true, uiDelta: ['apps/web/src/components/Card.tsx'] });
  });
  it('a judgement for another head or another reviewed commit is ignored', () => {
    expect(deriveMissionVisualReview(input({ headSha: 'other00', from: '1b7fc6c', state: 'carried', files: [] })).status).toBe('needed');
    expect(deriveMissionVisualReview(input({ headSha: 'f00dbab', from: 'other00', state: 'carried', files: [] })).status).toBe('needed');
  });
  it('without a judgement it is owed as before', () => {
    expect(deriveMissionVisualReview(input(null))).toMatchObject({ status: 'needed', staleEvidence: true });
  });
});

describe('carry record and line', () => {
  it('reads a stored carry and rejects junk', () => {
    expect(readReviewCarry({ visualReview: { carry: { headSha: 'ABC', from: 'DEF', state: 'carried', files: [] } } })).toEqual({ headSha: 'abc', from: 'def', state: 'carried', files: [] });
    expect(readReviewCarry({ visualReview: { carry: { headSha: 'abc', state: 'carried' } } })).toBeNull();
    expect(readReviewCarry(null)).toBeNull();
  });
  it('names the files in one line', () => {
    expect(uiDeltaLine(['apps/web/src/components/A.tsx'])).toBe('New UI changes since your review: components/A.tsx');
    expect(uiDeltaLine(['a/1.tsx', 'a/2.tsx', 'a/3.tsx', 'a/4.tsx'])).toContain('and 1 more');
  });
});
