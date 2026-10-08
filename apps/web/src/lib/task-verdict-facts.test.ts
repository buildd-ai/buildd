import { describe, expect, it } from 'bun:test';
import { deriveTaskVerdict } from './task-verdict';
import { buildVerdictInput, checkSourcesOf, traceOutcomeOf, type VerdictFactsInput } from './task-verdict-facts';

const PR = { id: 'w1', status: 'completed', prUrl: 'https://github.com/acme/app/pull/12', prNumber: 12, prLifecycleStatus: 'ci_failed', mergedAt: null };

const facts = (over: Partial<VerdictFactsInput> = {}): VerdictFactsInput => ({
  task: {
    status: 'completed',
    result: {
      summary: 'All green.',
      summarySource: 'agent',
      mismatch: [{ kind: 'success_with_red_check', detail: 'Reported success while a check was failing: check.' }],
      evidence: {
        errorClass: 'test_failure', keyLines: ['grep: x: No such file'], diff: { files: 3, added: 1, removed: 1 }, links: {},
        keyLinesSource: 'traces', capturedAt: '2026-01-01T00:00:00.000Z',
        ciChecks: [{ name: 'check', state: 'failed', url: 'https://ci/1' }, { name: 'build', state: 'passed', url: null }],
      },
    },
  },
  workers: [PR],
  ciAttempts: [{
    id: 'a2', status: 'completed', createdAt: '2026-01-01T01:00:00.000Z',
    context: { failureContext: { job: 'check', excerpt: 'PR body lint: the body contains a forbidden identifier\nmore' }, ciRunUrl: 'https://ci/run/2' },
    result: { summary: 'Edited the PR body. Tier-2 passing.', mismatch: [{ kind: 'fix_check_still_red', detail: 'Reported success, but check … is still failing.' }] },
  }],
  openAttempt: null,
  openQuestion: false,
  inRelease: false,
  ...over,
});

describe('buildVerdictInput', () => {
  it('the repro: open PR, red check, fix attempt claimed success → blocked on the named check with its own error line', () => {
    const v = deriveTaskVerdict(buildVerdictInput(facts()))!;
    expect(v.state).toBe('blocked');
    expect(v.headline).toBe('PR blocked · 1 check failing: check');
    expect(v.failingChecks[0]).toMatchObject({ name: 'check', line: 'PR body lint: the body contains a forbidden identifier', url: 'https://ci/run/2' });
    // The cause is the check, never the exploration grep from the evidence key lines.
    expect(v.cause).not.toContain('grep');
    expect(v.cause).toContain('The agent reported success; the check says otherwise.');
  });

  it('the line for a check comes from the failure the CI digest recorded for it', () => {
    const sources = checkSourcesOf(facts());
    const own = sources.find(s => s.checks.some(c => c.name === 'build'))!;
    expect(own.checks.find(c => c.name === 'check')!.line).toBe('PR body lint: the body contains a forbidden identifier');
  });

  it('a merged PR is shipped whatever the attempts said', () => {
    expect(deriveTaskVerdict(buildVerdictInput(facts({ workers: [{ ...PR, prLifecycleStatus: 'merged', mergedAt: new Date() }] })))!.state).toBe('shipped');
  });

  it('a kernel-owned PR reads the delivery state, not the worker columns (§17.5)', () => {
    const merged = buildVerdictInput(facts({ deliveryPrState: 'merged' }));
    expect(merged.pr).toMatchObject({ lifecycle: 'merged', merged: true });
    expect(deriveTaskVerdict(merged)!.state).toBe('shipped');
    const green = buildVerdictInput(facts({ deliveryPrState: 'ci_passed' }));
    expect(green.pr).toMatchObject({ lifecycle: 'ci_green', merged: false });
    // No delivery: the columns as before.
    expect(buildVerdictInput(facts({ deliveryPrState: null })).pr).toMatchObject({ lifecycle: 'ci_failed', merged: false });
  });

  it('a live worker reads in progress', () => {
    const v = deriveTaskVerdict(buildVerdictInput(facts({ task: { status: 'in_progress', result: null }, workers: [{ id: 'w2', status: 'running' }] })))!;
    expect(v.state).toBe('in_progress');
  });
});

describe('traceOutcomeOf', () => {
  it('blocked by a check is a red gate; shipped and done succeeded', () => {
    const blocked = deriveTaskVerdict(buildVerdictInput(facts()));
    expect(traceOutcomeOf(blocked, 'completed')).toEqual({ succeeded: false, failed: false, gatingCheckRed: true });
    const shipped = deriveTaskVerdict(buildVerdictInput(facts({ workers: [{ ...PR, mergedAt: new Date() }] })));
    expect(traceOutcomeOf(shipped, 'completed').succeeded).toBe(true);
    expect(traceOutcomeOf(null, 'failed').failed).toBe(true);
  });
});
