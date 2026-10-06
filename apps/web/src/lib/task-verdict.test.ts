import { describe, expect, it } from 'bun:test';
import {
  applyVerdictDecision,
  deriveTaskVerdict,
  latestChecks,
  parseStoredVerdictDecision,
  type StoredVerdictDecision,
  type VerdictInput,
} from './task-verdict';

const PR = { url: 'https://github.com/acme/app/pull/12', number: 12, lifecycle: 'ci_failed', merged: false };

const input = (over: Partial<VerdictInput> = {}): VerdictInput => ({
  taskStatus: 'completed',
  live: null,
  openQuestion: false,
  pr: PR,
  checks: [
    { name: 'PR body lint', state: 'failed', url: 'https://github.com/acme/app/runs/1', line: 'Body contains a full UUID' },
    { name: 'build', state: 'passed', url: null },
  ],
  openAttempt: null,
  summary: 'All checks pass. Tier-2 green.',
  summarySource: 'agent',
  mismatch: [{ kind: 'success_with_red_check', detail: 'Reported success while a check was failing: PR body lint.' }],
  ...over,
});

const decision = (over: Partial<StoredVerdictDecision> = {}): StoredVerdictDecision => ({
  v: 'tv1', fingerprint: 'f', state: 'blocked', causeKey: 'blocked:check:PR body lint', at: '', model: 'm',
  wording: null, mismatchDiagnosis: null, traceClasses: {}, decisionIds: [], fallback: false, ...over,
});

describe('deriveTaskVerdict', () => {
  it('open PR + red check + agent summary "success" → blocked, the cause names the check and its line', () => {
    const v = deriveTaskVerdict(input())!;
    expect(v.state).toBe('blocked');
    expect(v.headline).toBe('PR blocked · 1 check failing: PR body lint');
    // The check and its first error line ride on the inline check row, not repeated in the cause.
    expect(v.failingChecks[0]).toMatchObject({ name: 'PR body lint', line: 'Body contains a full UUID' });
    expect(v.cause).not.toContain('Body contains a full UUID');
    expect(v.cause).toContain('The agent reported success; the check says otherwise.');
    expect(v.headline).not.toContain('Tier-2');
    expect(v.actions[0]).toMatchObject({ label: 'View failing check', href: 'https://github.com/acme/app/runs/1' });
    expect(v.failingChecks.map(c => c.name)).toEqual(['PR body lint']);
  });

  it('merged → shipped, whatever an earlier check said', () => {
    const v = deriveTaskVerdict(input({ pr: { ...PR, lifecycle: 'merged', merged: true } }))!;
    expect(v.state).toBe('shipped');
    expect(v.headline).toBe('Shipped · PR #12 merged');
  });

  it('a retry dispatched while CI is still red is still blocked, never "handled"', () => {
    const v = deriveTaskVerdict(input({ openAttempt: { taskId: 't2', iteration: 1, maxIterations: 3, claimed: true } }))!;
    expect(v.state).toBe('blocked');
    expect(v.cause).toContain('Fix 1 of 3 is running; this stays blocked until the check is green.');
    expect(`${v.headline} ${v.cause}`).not.toMatch(/handled/i);
    expect(v.actions.map(a => a.label)).toEqual(['View failing check', 'View fix 1 of 3', 'Open PR #12']);
  });

  it('a green suite outranks red names from an older snapshot', () => {
    const v = deriveTaskVerdict(input({ pr: { ...PR, lifecycle: 'ci_green' }, mismatch: [] }))!;
    expect(v.state).toBe('needs_you');
    expect(v.headline).toBe('Ready to merge · PR #12');
  });

  it('red lifecycle without any named check still blocks', () => {
    const v = deriveTaskVerdict(input({ checks: null }))!;
    expect(v.state).toBe('blocked');
    expect(v.headline).toBe('PR blocked · checks failing');
  });

  it('a live worker is in progress; a waiting one needs you', () => {
    expect(deriveTaskVerdict(input({ taskStatus: 'in_progress', live: { status: 'running', waitingForInput: false } }))!.state).toBe('in_progress');
    expect(deriveTaskVerdict(input({ taskStatus: 'in_progress', live: { status: 'waiting_input', waitingForInput: true } }))!.state).toBe('needs_you');
  });

  it('a failed task is failed with its first error line', () => {
    const v = deriveTaskVerdict(input({ taskStatus: 'failed', pr: null, failureLine: '\nerror: tests failed\nmore' }))!;
    expect(v).toMatchObject({ state: 'failed', headline: 'Failed', cause: 'error: tests failed' });
  });

  it('a fallback summary is never the headline', () => {
    const v = deriveTaskVerdict(input({ pr: null, summary: 'I will now look at the files', summarySource: 'fallback', mismatch: [] }))!;
    expect(v).toMatchObject({ state: 'done', headline: 'Done' });
  });

  it('a pending task with nothing to judge has no verdict', () => {
    expect(deriveTaskVerdict(input({ taskStatus: 'pending', pr: null, mismatch: [] }))).toBeNull();
  });

  it('a closed PR is failed', () => {
    expect(deriveTaskVerdict(input({ pr: { ...PR, lifecycle: 'closed' } }))!.state).toBe('failed');
  });
});

describe('applyVerdictDecision', () => {
  it('a PR-description diagnosis offers the description fix first', () => {
    const v = applyVerdictDecision(deriveTaskVerdict(input())!, decision({ wording: 'fix_pr_metadata' }));
    expect(v.wordedBy).toBe('model');
    expect(v.state).toBe('blocked');
    expect(v.actions[0]).toMatchObject({ label: 'Fix PR description', href: PR.url });
    expect(v.actions.length).toBeLessThanOrEqual(3);
  });

  it('a decision made for another state or cause is ignored (rules wording stands)', () => {
    const rules = deriveTaskVerdict(input())!;
    expect(applyVerdictDecision(rules, decision({ wording: 'fix_pr_metadata', causeKey: 'blocked:check:build' }))).toBe(rules);
    expect(applyVerdictDecision(rules, decision({ state: 'shipped', wording: 'rerun_checks' }))).toBe(rules);
  });

  it('never changes the state, only wording and actions', () => {
    const v = applyVerdictDecision(deriveTaskVerdict(input())!, decision({ wording: 'rerun_checks', mismatchDiagnosis: 'flaky_ci' }));
    expect(v.state).toBe('blocked');
    expect(v.cause).toContain('a re-run may clear it');
  });
});

describe('latestChecks / parseStoredVerdictDecision', () => {
  it('the newest snapshot that names a check wins', () => {
    expect(latestChecks([
      { at: 1, checks: [{ name: 'old', state: 'failed', url: null }] },
      { at: 3, checks: [] },
      { at: 2, checks: [{ name: 'new', state: 'failed', url: null }] },
    ])!.map(c => c.name)).toEqual(['new']);
    expect(latestChecks([])).toBeNull();
  });

  it('rejects a malformed stored record', () => {
    expect(parseStoredVerdictDecision(null)).toBeNull();
    expect(parseStoredVerdictDecision({ state: 'blocked' })).toBeNull();
    expect(parseStoredVerdictDecision(decision())!.causeKey).toBe('blocked:check:PR body lint');
  });
});
