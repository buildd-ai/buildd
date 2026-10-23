/**
 * Activity's verification claims (spec 9430a28f R-6, AC-5): read only from a
 * task's governed outcome, never from its PR. Passed, failed, stale and
 * unverified are told apart, each with the criterion, the approved spec
 * revision and the commit when one is recorded.
 */
import { describe, expect, it } from 'bun:test';
import { verificationClaim, type VerificationOutcomeInput } from './activity-verification';

const H1 = 'a1b2c3d4e5f60718';
const H2 = 'd4e5f60718293a4b';
const spec = { title: 'Export email', approvedRevision: 2 };

const outcome = (over: Partial<VerificationOutcomeInput> = {}): VerificationOutcomeInput => ({
  specId: 'spec-1', revision: 2, outcome: 'unverified', currentHeadSha: H2,
  criteria: [
    { criterionId: 'R-1', text: 'Sends the export', verdict: null, stale: false, headSha: null },
    { criterionId: 'AC-1', text: 'Retries once', verdict: null, stale: false, headSha: null },
  ],
  ...over,
});

describe('R-6: a verification claim says criterion, approved revision and commit', () => {
  it('passed: every criterion passes on the current commit', () => {
    const c = verificationClaim(outcome({
      outcome: 'verified',
      criteria: [
        { criterionId: 'R-1', text: 'Sends the export', verdict: 'pass', stale: false, headSha: H2 },
        { criterionId: 'AC-1', text: 'Retries once', verdict: 'pass', stale: false, headSha: H2 },
      ],
    }), spec, Date.parse('2026-10-08T11:00:00Z'));
    expect(c.state).toBe('passed');
    expect(c.label).toBe('Verified');
    expect(c.revision).toBe(2);
    expect(c.approvedRevision).toBe(2);
    expect(c.headSha).toBe(H2.slice(0, 7));
    expect(c.href).toBe('/app/specs/spec-1');
    expect(c.criteria.map(x => [x.criterionId, x.label, x.headSha])).toEqual([['R-1', 'Passes', H2.slice(0, 7)], ['AC-1', 'Passes', H2.slice(0, 7)]]);
    expect(c.line).toBe('Verified against revision 2.');
  });

  it('failed: names the failing criterion', () => {
    const c = verificationClaim(outcome({
      outcome: 'fail',
      criteria: [
        { criterionId: 'R-1', text: 'Sends the export', verdict: 'fail', stale: false, headSha: H2 },
        { criterionId: 'AC-1', text: 'Retries once', verdict: 'pass', stale: false, headSha: H2 },
      ],
    }), spec, null);
    expect(c.state).toBe('failed');
    expect(c.label).toBe('Fails');
    expect(c.line).toBe('R-1 fails against revision 2.');
  });

  it('stale: a pass on an older commit is never shown as passed', () => {
    const c = verificationClaim(outcome({
      criteria: [
        { criterionId: 'R-1', text: 'Sends the export', verdict: 'pass', stale: true, headSha: H1 },
        { criterionId: 'AC-1', text: 'Retries once', verdict: 'pass', stale: true, headSha: H1 },
      ],
    }), spec, null);
    expect(c.state).toBe('stale');
    expect(c.label).not.toBe('Verified');
    expect(c.criteria[0].label).toBe('Passed on an older commit');
    expect(c.criteria[0].headSha).toBe(H1.slice(0, 7));
    expect(c.headSha).toBe(H2.slice(0, 7));
  });

  it('stale: work verified on revision 1 is not proof of approved revision 2', () => {
    const c = verificationClaim(outcome({
      revision: 1, outcome: 'verified',
      criteria: [{ criterionId: 'R-1', text: 'Sends the export', verdict: 'pass', stale: false, headSha: H2 }],
    }), spec, null);
    expect(c.state).toBe('stale');
    expect(c.line).toBe('Not verified against revision 2.');
  });

  it('unverified: no verdict recorded, whatever happened to the PR', () => {
    const c = verificationClaim(outcome(), spec, null);
    expect(c.state).toBe('unverified');
    expect(c.label).toBe('Not verified');
    expect(c.criteria.every(x => x.label === 'Not verified' && x.headSha === null)).toBe(true);
  });

  it('unverified: an inconclusive verdict never reads as passed', () => {
    const c = verificationClaim(outcome({
      criteria: [{ criterionId: 'R-1', text: 'Sends the export', verdict: 'inconclusive', stale: false, headSha: H2 }],
    }), spec, null);
    expect(c.state).toBe('unverified');
  });

  it('no current commit known: the claim shows none rather than inventing one', () => {
    const c = verificationClaim(outcome({ currentHeadSha: null }), spec, null);
    expect(c.headSha).toBeNull();
  });

  it('nothing approved yet: reads against the revision it was built to', () => {
    const c = verificationClaim(outcome({ outcome: 'verified', criteria: [{ criterionId: 'R-1', text: 'x', verdict: 'pass', stale: false, headSha: H2 }] }), { title: 'Draft', approvedRevision: null }, null);
    expect(c.state).toBe('passed');
    expect(c.approvedRevision).toBeNull();
  });
});
