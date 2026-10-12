import { describe, expect, it } from 'bun:test';
import { resolveVisualReviewPolicy } from './visual-review-policy';
import { integrationPrFromDeliveryState, deriveMissionVisualReview, type VisualReviewStateInput } from './visual-review-state';

const base = (over: Partial<VisualReviewStateInput> = {}): VisualReviewStateInput => ({
  policy: resolveVisualReviewPolicy({}),
  uiChange: { state: 'yes', source: 'diff', uiFiles: 3 },
  audit: null,
  review: null,
  waiver: null,
  branch: { headSha: 'abc123', base: 'dev', integrationPr: null, workLanded: true },
  ...over,
});
const audit = (over: Record<string, unknown> = {}) => ({ id: 't1', createdAt: '2026-10-01T00:00:00Z', errorType: null, ...over });
const review = (over: Record<string, unknown> = {}) => ({
  phase: 'reviewed' as const, screens: 4, effectiveIssues: 0, awaitingHuman: 0, openFixes: 0, roundCapOpen: false,
  needsYouReason: null, captured: 0, expected: null, ...over,
});
const ready = { number: 9, state: 'open' as const, ready: true, blocked: false };

describe('deriveMissionVisualReview status', () => {
  it('not_applicable when no UI changed and nothing ran', () => {
    const s = deriveMissionVisualReview(base({ uiChange: { state: 'no', source: null, uiFiles: 0 } }));
    expect(s).toMatchObject({ status: 'not_applicable', blocksCompletion: false, nextActor: 'none', pendingVerification: false });
  });
  it('optional when the diff is unreadable and nothing ran', () => {
    expect(deriveMissionVisualReview(base({ uiChange: { state: 'unknown', source: null, uiFiles: 0 } })).status).toBe('optional');
  });
  it('optional (not blocking) when policy is off and UI changed', () => {
    const s = deriveMissionVisualReview(base({ policy: resolveVisualReviewPolicy({ workspace: 'off' }) }));
    expect(s).toMatchObject({ status: 'optional', blocksCompletion: false, nextActor: 'none' });
  });
  it('needed + system under automatic', () => {
    expect(deriveMissionVisualReview(base())).toMatchObject({ status: 'needed', blocksCompletion: true, nextActor: 'system', pendingVerification: true });
  });
  it('needed + owner under ask', () => {
    expect(deriveMissionVisualReview(base({ policy: resolveVisualReviewPolicy({ workspace: 'ask' }) }))).toMatchObject({ status: 'needed', nextActor: 'owner' });
  });
  it('queued while waiting, running while capturing', () => {
    for (const phase of ['waiting_deps', 'queued'] as const) {
      expect(deriveMissionVisualReview(base({ audit: audit(), review: review({ phase }) }))).toMatchObject({ status: 'queued', nextActor: 'system' });
    }
    expect(deriveMissionVisualReview(base({ audit: audit(), review: review({ phase: 'capturing', captured: 2, expected: 5 }) })))
      .toMatchObject({ status: 'running', progress: { captured: 2, expected: 5 } });
  });
  it('passed when reviewed with nothing open', () => {
    expect(deriveMissionVisualReview(base({ audit: audit(), review: review() }))).toMatchObject({ status: 'passed', blocksCompletion: false, pendingVerification: false, nextActor: 'none' });
  });
  it('findings while fixes run belong to the system', () => {
    const s = deriveMissionVisualReview(base({ audit: audit(), review: review({ phase: 'fixing', effectiveIssues: 2, openFixes: 2 }) }));
    expect(s).toMatchObject({ status: 'findings', nextActor: 'system', blocksCompletion: true });
    expect(s.findings).toMatchObject({ issues: 2, stage: 'fixing' });
  });
  it('findings with undecided cells go to Jev, never straight to the owner', () => {
    const s = deriveMissionVisualReview(base({ audit: audit(), review: review({ phase: 'needs_you', awaitingHuman: 1, needsYouReason: 'unsure' }) }));
    expect(s).toMatchObject({ status: 'findings', nextActor: 'jev' });
    expect(s.findings?.stage).toBe('needs_decision');
  });
  it('issues with no fix and no undecided cell still read as findings', () => {
    expect(deriveMissionVisualReview(base({ audit: audit(), review: review({ effectiveIssues: 1 }) })).status).toBe('findings');
  });
  it('an issue is findings even when its text is about a browser (never blocked)', () => {
    expect(deriveMissionVisualReview(base({ audit: audit(), review: review({ effectiveIssues: 1 }) })).blocked).toBeUndefined();
  });
});

describe('blocked is the review system failing, not product findings', () => {
  const cases: Array<[string, string, string]> = [
    ['boot_failed', 'app_boot_failed', 'unknown'],
    ['stalled', 'stalled', 'buildd'],
    ['failed', 'auditor_failed', 'buildd'],
    ['no_browser_runner', 'no_browser_runner', 'buildd'],
  ];
  for (const [phase, cause, causeOwner] of cases) {
    it(`${phase} -> blocked/${cause}`, () => {
      const s = deriveMissionVisualReview(base({ audit: audit(), review: review({ phase: phase as never }) }));
      expect(s.status).toBe('blocked');
      expect(s.blocked).toMatchObject({ cause, causeOwner });
      expect(s.blocksCompletion).toBe(true);
    });
  }
  it('a workspace-caused capture config error is the owner’s to fix', () => {
    const s = deriveMissionVisualReview(base({ audit: audit(), review: review({ phase: 'failed' }), captureConfigError: 'protection_bypass_missing' }));
    expect(s.blocked).toMatchObject({ cause: 'capture_auth', causeOwner: 'workspace' });
    expect(s.nextActor).toBe('owner');
  });
  it('system failure keeps the system as actor until retries are used up', () => {
    expect(deriveMissionVisualReview(base({ audit: audit(), review: review({ phase: 'stalled' }) })).nextActor).toBe('system');
    expect(deriveMissionVisualReview(base({ audit: audit(), review: review({ phase: 'stalled' }), autoRetriesLeft: 0 })).nextActor).toBe('owner');
  });
  it('blocked does not block when policy is off', () => {
    expect(deriveMissionVisualReview(base({ policy: resolveVisualReviewPolicy({ workspace: 'off' }), audit: audit(), review: review({ phase: 'failed' }) })).blocksCompletion).toBe(false);
  });
});

describe('waiver', () => {
  const waiver = { reason: 'copy only change', actorLabel: 'Max', at: '2026-10-02T00:00:00Z' };
  it('waived when a person skipped and no newer audit exists', () => {
    expect(deriveMissionVisualReview(base({ waiver }))).toMatchObject({ status: 'waived', blocksCompletion: false, nextActor: 'none' });
  });
  it('a later audit supersedes the waiver', () => {
    const s = deriveMissionVisualReview(base({ waiver, audit: audit({ createdAt: '2026-10-03T00:00:00Z' }), review: review({ phase: 'queued' }) }));
    expect(s.status).toBe('queued');
    expect(s.waiver?.supersededBy).toBeTruthy();
  });
  it('strict ignores a waiver', () => {
    expect(deriveMissionVisualReview(base({ waiver, policy: resolveVisualReviewPolicy({ workspace: 'strict' }) })).status).toBe('needed');
  });
});

describe('branch stage', () => {
  it('carries head sha, base and integration PR state', () => {
    const s = deriveMissionVisualReview(base({ audit: audit(), review: review(), branch: { headSha: 'deadbeef', base: 'dev', integrationPr: ready, workLanded: true } }));
    expect(s.branch).toMatchObject({ headSha: 'deadbeef', base: 'dev', integrationPr: { number: 9, stage: 'ready' }, postMergeRecovery: false });
  });
  it('pending verification blocks the merge while the PR is open', () => {
    const s = deriveMissionVisualReview(base({ branch: { headSha: 'a', base: 'dev', integrationPr: ready, workLanded: true } }));
    expect(s).toMatchObject({ pendingVerification: true, blocksMerge: true });
    expect(s.branch.postMergeRecovery).toBe(false);
  });
  it('maps draft/blocked/merged PR stages', () => {
    const stage = (pr: never) => deriveMissionVisualReview(base({ branch: { headSha: 'a', base: 'dev', integrationPr: pr, workLanded: true } })).branch.integrationPr?.stage;
    expect(stage({ number: 1, state: 'open', ready: false, blocked: false } as never)).toBe('open');
    expect(stage({ number: 1, state: 'open', ready: true, blocked: true } as never)).toBe('blocked');
    expect(stage({ number: 1, state: 'merged', ready: true, blocked: false } as never)).toBe('merged');
  });
  it('flags post-merge recovery when the PR already merged and verification is still owed', () => {
    const s = deriveMissionVisualReview(base({ branch: { headSha: 'a', base: 'dev', integrationPr: { number: 1, state: 'merged', ready: true, blocked: false }, workLanded: true } }));
    expect(s).toMatchObject({ blocksMerge: false, pendingVerification: true });
    expect(s.branch.postMergeRecovery).toBe(true);
  });
  it('no recovery flag once passed', () => {
    const s = deriveMissionVisualReview(base({ audit: audit(), review: review(), branch: { headSha: 'a', base: 'dev', integrationPr: { number: 1, state: 'merged', ready: true, blocked: false }, workLanded: true } }));
    expect(s.branch.postMergeRecovery).toBe(false);
  });
  it('the owner is never named for a routine pass: merge-now/wait is a merge-policy concern', () => {
    expect(deriveMissionVisualReview(base({ audit: audit(), review: review() })).nextActor).toBe('none');
  });
});

describe('integrationPrFromDeliveryState', () => {
  it('maps kernel delivery states to the PR fact', () => {
    expect(integrationPrFromDeliveryState(1, 'MERGED')).toMatchObject({ state: 'merged' });
    expect(integrationPrFromDeliveryState(1, 'ABANDONED')).toMatchObject({ state: 'closed' });
    expect(integrationPrFromDeliveryState(1, 'APPROVED')).toMatchObject({ state: 'open', ready: true, blocked: false });
    expect(integrationPrFromDeliveryState(1, 'ESCALATED')).toMatchObject({ blocked: true });
    expect(integrationPrFromDeliveryState(1, 'AWAITING_REVIEW')).toMatchObject({ ready: false, blocked: false });
  });
});
