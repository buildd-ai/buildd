import { describe, expect, it } from 'bun:test';
import { describeVisualPhase } from '@buildd/core/visual-review-text';
import { deriveMissionVisualReview, type VisualReviewStateInput } from './workflow/visual-review-state';
import { resolveVisualReviewPolicy } from './workflow/visual-review-policy';
import { visualCheck } from './mission-checks';

const stale = (): VisualReviewStateInput => ({
  policy: resolveVisualReviewPolicy({}),
  uiChange: { state: 'yes', source: 'diff', uiFiles: 2 },
  audit: { id: 'a1', createdAt: '2026-10-01T00:00:00Z', errorType: null } as never,
  review: { phase: 'reviewed', screens: 4, effectiveIssues: 0, awaitingHuman: 0, openFixes: 0, roundCapOpen: false, needsYouReason: null, captured: 0, expected: null } as never,
  waiver: null,
  auditedSha: 'aaaa1111',
  branch: { headSha: 'bbbb2222', base: 'dev', integrationPr: { number: 9, state: 'open', ready: false, blocked: false }, workLanded: true },
});

describe('an out-of-date visual check says what is true', () => {
  it('does not promise a check the system is not filing', () => {
    const owed = visualCheck(deriveMissionVisualReview(stale()), { mergeTier: 'human' });
    expect(owed.state).toBe('out of date');
    expect(owed.detail).toBe('The branch changed after the last check. A new check is being filed.');
    const noOne = visualCheck({ ...deriveMissionVisualReview(stale()), nextActor: 'none' }, { mergeTier: 'human' });
    expect(noOne.detail).toContain('None is scheduled; Check again starts one.');
  });

  it('the screens summary names the earlier commit when the check is out of date', () => {
    const summary = { shots: 4, ok: 4, effectiveOk: 4, issues: 0, effectiveIssues: 0, unsure: 0, reviewed: 0 } as never;
    const base = { phase: 'reviewed' as const, progress: null, summary };
    expect(describeVisualPhase(base).label).toBe('4 of 4 ok');
    expect(describeVisualPhase({ ...base, onEarlierCommit: true }).label).toBe('4 of 4 ok on an earlier commit');
  });
});
