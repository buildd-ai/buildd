import { describe, expect, it } from 'bun:test';
import { ciLifecycleFromSuites } from './ci-lifecycle';

const suite = (status: string, conclusion: string | null, runs = 1) => ({ status, conclusion, latest_check_runs_count: runs });

describe('ciLifecycleFromSuites', () => {
  it('no suites: no verdict', () => {
    expect(ciLifecycleFromSuites([])).toBeNull();
    expect(ciLifecycleFromSuites(undefined)).toBeNull();
  });

  it('green, red, running', () => {
    expect(ciLifecycleFromSuites([suite('completed', 'success'), suite('completed', 'skipped')])).toBe('ci_green');
    expect(ciLifecycleFromSuites([suite('completed', 'success'), suite('completed', 'failure')])).toBe('ci_failed');
    expect(ciLifecycleFromSuites([suite('in_progress', null), suite('completed', 'success')])).toBe('ci_running');
  });

  // Seen on a real PR: an app (Vercel) opens a suite that stays queued with no
  // runs, so the PR read "CI running" for two weeks while Actions had failed.
  it('a suite with no runs carries no verdict and never holds a PR in running', () => {
    expect(ciLifecycleFromSuites([suite('queued', null, 0), suite('completed', 'failure', 25)])).toBe('ci_failed');
    expect(ciLifecycleFromSuites([suite('queued', null, 0), suite('completed', 'success', 5)])).toBe('ci_green');
    expect(ciLifecycleFromSuites([suite('queued', null, 0)])).toBeNull();
  });

  it('a suite without a run count is taken at its word', () => {
    expect(ciLifecycleFromSuites([{ status: 'queued', conclusion: null }])).toBe('ci_running');
  });
});
