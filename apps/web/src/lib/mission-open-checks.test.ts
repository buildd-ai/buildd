// Spec 8e137fdb AC-7: an outcome spec that has not passed is an open check, so Next is never "Mission completes".
import { describe, expect, it } from 'bun:test';
import { openCriteriaCount, summarizeVisualReview } from './mission-open-checks';

const spec = { type: 'living_spec', specId: 's1', revision: 3, label: 'Outcome spec' };
const ctx = { branch: 'mission-branch' as const, prMerged: true, buildComplete: true };

describe('openCriteriaCount', () => {
  it('no criteria, none open', () => {
    expect(openCriteriaCount(null, null, ctx)).toBe(0);
  });
  it('an unchecked outcome spec is open, even under a stale overall pass', () => {
    expect(openCriteriaCount([spec], null, ctx)).toBe(1);
    expect(openCriteriaCount([spec], { overall: 'pass', criteria: [] }, ctx)).toBe(1);
  });
  it('a passed criterion is not open', () => {
    const c = { type: 'all_prs_merged' };
    expect(openCriteriaCount([c], { overall: 'pass', criteria: [{ index: 0, verdict: 'pass' }] }, ctx)).toBe(0);
  });
});

describe('summarizeVisualReview', () => {
  it('blocked on a browser names that one cause', () => {
    const s = summarizeVisualReview({ status: 'blocked', blocked: { cause: 'no_browser_runner', causeOwner: 'buildd', autoRetriesLeft: 0 }, holdReason: 'budget_paused' } as never);
    expect(s).toEqual({ status: 'blocked', blockedDetail: 'it needs a runner with a browser', holdReason: null });
  });
  it('queued carries the hold', () => {
    expect(summarizeVisualReview({ status: 'queued', holdReason: 'budget_paused' } as never)?.holdReason).toBe('budget_paused');
  });
});

describe('summarizeVisualReview: a recapture coming', () => {
  it('asks no one while the new screenshot is queued, and says so', () => {
    const s = summarizeVisualReview({
      status: 'queued', blocksMerge: true, nextActor: 'system', recapture: { next: 'queued', screens: ['/app/x'], routes: ['/app/x'] },
      policy: { mode: 'auto', origin: 'default', waiverAllowed: true, locked: false },
      branch: { headSha: 'a', base: 'dev', integrationPr: { number: 1, state: 'open', ready: false, blocked: false } },
    } as never);
    expect(s?.needsOwner).toBe(false);
    expect(s?.recaptureComing).toBe(true);
  });
});
