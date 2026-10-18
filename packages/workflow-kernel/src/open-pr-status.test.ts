import { describe, expect, test } from 'bun:test';
import { LANDING_STATUS_CONTEXT } from './landing-gate';
import { releaseCandidateStatus, statusCoverage, unownedPrStatus, type CandidateCheckState } from './open-pr-status';

const H = 'abcdef1234567890abcdef1234567890abcdef12';
const passing = (...names: string[]) => names.map((name) => ({ name, state: 'passing' as CandidateCheckState }));

describe('a PR no delivery owns (spec §4, R-43)', () => {
  test('no review asked for: pending "Review not requested", never success or failure', () => {
    const s = unownedPrStatus(H, 'not_requested');
    expect(s).toEqual({ state: 'pending', sha: H, description: 'Review not requested: no buildd review covers abcdef1 yet' });
  });

  test('a review asked for and not finished: pending "Review in progress"', () => {
    const s = unownedPrStatus(H, 'in_progress');
    expect(s.state).toBe('pending');
    expect(s.description.startsWith('Review in progress: ')).toBe(true);
  });

  test('the description never uses the kernel\'s own word "land"', () => {
    for (const r of ['not_requested', 'in_progress'] as const) expect(unownedPrStatus(H, r).description).not.toMatch(/\bland/i);
  });
});

describe('a frozen release candidate: the release gate\'s answer at its exact SHA', () => {
  const required = ['build', 'release candidate verified'];

  test('every required check passed and the review gate passes: success', () => {
    const s = releaseCandidateStatus({ sha: H, checks: passing(...required), review: { verdict: 'pass' } });
    expect(s).toEqual({ state: 'success', sha: H, description: 'Ready to merge: release candidate abcdef1 is verified' });
  });

  test('a required check still running or not reported: pending, never success', () => {
    const running = releaseCandidateStatus({ sha: H, checks: [{ name: 'build', state: 'passing' }, { name: 'release candidate verified', state: 'pending' }], review: { verdict: 'pass' } });
    expect(running.state).toBe('pending');
    expect(running.description).toContain('release candidate verified');
    const missing = releaseCandidateStatus({ sha: H, checks: [{ name: 'build', state: 'passing' }, { name: 'release candidate verified', state: 'missing' }], review: { verdict: 'pass' } });
    expect(missing.state).toBe('pending');
  });

  test('no checks at all is never verified (a green over nothing does not count)', () => {
    expect(releaseCandidateStatus({ sha: H, checks: [], review: { verdict: 'pass' } }).state).toBe('pending');
  });

  test('a failed required check: failure naming it', () => {
    const s = releaseCandidateStatus({ sha: H, checks: [{ name: 'build', state: 'failing' }, { name: 'release candidate verified', state: 'pending' }], review: { verdict: 'pass' } });
    expect(s.state).toBe('failure');
    expect(s.description).toBe('Merge blocked: release candidate abcdef1 failed build');
  });

  test('verified, but the review gate holds it: success is withheld', () => {
    const changes = releaseCandidateStatus({ sha: H, checks: passing(...required), review: { verdict: 'changes_requested', reason: 'the migration drops a column' } });
    expect(changes).toMatchObject({ state: 'failure', description: 'Changes requested: the migration drops a column' });
    const blocked = releaseCandidateStatus({ sha: H, checks: passing(...required), review: { verdict: 'blocked', reason: 'a person has to decide' } });
    expect(blocked).toMatchObject({ state: 'failure', description: 'Merge blocked: a person has to decide' });
    const pending = releaseCandidateStatus({ sha: H, checks: passing(...required), review: { verdict: 'pending' } });
    expect(pending.state).toBe('pending');
    expect(pending.description.startsWith('Review in progress')).toBe(true);
  });

  test('a description is clipped to GitHub\'s 140 characters', () => {
    const s = releaseCandidateStatus({ sha: H, checks: passing(...required), review: { verdict: 'changes_requested', reason: 'x'.repeat(300) } });
    expect(s.description.length).toBe(140);
  });
});

describe('coverage: can it fail?', () => {
  const head = (n: number, shown: boolean) => ({ repoFullName: 'acme/app', prNumber: n, sha: `${n}`.padEnd(40, '0'), shown });

  test('every open head carries the context: covered', () => {
    expect(statusCoverage([head(1, true), head(2, true)])).toEqual({ context: LANDING_STATUS_CONTEXT, checked: 2, missing: [], verdict: 'covered' });
  });

  test('a head without it: gaps, listing that head', () => {
    const c = statusCoverage([head(1, true), head(2, false)]);
    expect(c.verdict).toBe('gaps');
    expect(c.missing).toEqual([{ repoFullName: 'acme/app', prNumber: 2, sha: head(2, false).sha }]);
  });

  test('nothing checked is not covered', () => {
    expect(statusCoverage([]).verdict).toBe('nothing_checked');
  });
});
