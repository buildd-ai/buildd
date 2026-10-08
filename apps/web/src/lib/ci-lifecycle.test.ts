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
  it('a queued suite with no runs cannot hide a failure', () => {
    expect(ciLifecycleFromSuites([suite('queued', null, 0), suite('completed', 'failure', 25)])).toBe('ci_failed');
  });

  // Found in review: an Actions run held behind a concurrency group is also queued
  // with no runs yet, so an empty suite can't prove the PR green.
  it('but it cannot prove green either', () => {
    expect(ciLifecycleFromSuites([suite('queued', null, 0), suite('completed', 'success', 5)])).toBe('ci_running');
  });

  it('only empty queued suites: no verdict, the stored state stands', () => {
    expect(ciLifecycleFromSuites([suite('queued', null, 0)])).toBeNull();
  });

  // A workflow file that fails to parse fails before any job exists. But a
  // newer passing suite supersedes an older failing one: when a PR body is
  // edited, a new workflow run is triggered, creating a new suite. The old
  // suite's failure should not override the new suite's pass.
  it('old failing suite + new passing suite: newer passing suite wins', () => {
    expect(ciLifecycleFromSuites([
      { status: 'completed', conclusion: 'failure', latest_check_runs_count: 0, updated_at: '2026-01-01T00:00:00Z' },
      { status: 'completed', conclusion: 'success', latest_check_runs_count: 5, updated_at: '2026-01-01T00:02:00Z' },
    ])).toBe('ci_green');
  });

  it('old passing suite + new failing suite: newer failing suite loses', () => {
    expect(ciLifecycleFromSuites([
      { status: 'completed', conclusion: 'success', latest_check_runs_count: 5, updated_at: '2026-01-01T00:00:00Z' },
      { status: 'completed', conclusion: 'failure', latest_check_runs_count: 0, updated_at: '2026-01-01T00:02:00Z' },
    ])).toBe('ci_failed');
  });

  it('a real suite still running is running, even beside a failure', () => {
    expect(ciLifecycleFromSuites([suite('in_progress', null, 3), suite('completed', 'failure', 2)])).toBe('ci_running');
  });

  it('a suite without a run count is taken at its word', () => {
    expect(ciLifecycleFromSuites([{ status: 'queued', conclusion: null }])).toBe('ci_running');
  });
});
