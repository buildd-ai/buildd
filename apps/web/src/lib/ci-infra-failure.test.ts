import { describe, it, expect, mock, beforeEach } from 'bun:test';

const calls: Array<{ path: string; method?: string }> = [];
let run: any = { id: 9, run_attempt: 1 };
let jobLog = '';
mock.module('@/lib/github', () => ({
  githubApi: async (_i: number, path: string, opts: RequestInit = {}) => {
    calls.push({ path, method: opts.method });
    if (path.includes('/actions/runs?')) return { workflow_runs: run ? [run] : [] };
    if (path.endsWith('/jobs')) return { jobs: [{ id: 5, conclusion: 'failure' }, { id: 6, conclusion: 'success' }] };
    return null;
  },
  githubApiText: async () => jobLog,
}));

const { detectInfraFailure, rerunIfInfraFailure } = await import('./ci-infra-failure');

const PULL = 'Error response from daemon: toomanyrequests: Data limit exceeded';

describe('detectInfraFailure', () => {
  it('names a registry rate limit', () => expect(detectInfraFailure(PULL)).toBe('registry_rate_limit'));
  it('ignores an ordinary test failure', () => expect(detectInfraFailure('error: expect(received).toBe(1)')).toBeNull());
  it('ignores empty input', () => expect(detectInfraFailure(null)).toBeNull());
});

describe('rerunIfInfraFailure', () => {
  beforeEach(() => { calls.length = 0; run = { id: 9, run_attempt: 1 }; jobLog = PULL; });

  it('re-runs the failed jobs on an infra signature', async () => {
    const out = await rerunIfInfraFailure(1, 'o/r', 'sha');
    expect(out).toEqual({ rerun: true, signature: 'registry_rate_limit', runId: 9, runAttempt: 1 });
    expect(calls.at(-1)).toEqual({ path: '/repos/o/r/actions/runs/9/rerun-failed-jobs', method: 'POST' });
  });

  it('leaves a code failure to the fix path', async () => {
    jobLog = 'FAIL src/a.test.ts';
    expect(await rerunIfInfraFailure(1, 'o/r', 'sha')).toEqual({ rerun: false, reason: 'not_infra' });
    expect(calls.some(c => c.method === 'POST')).toBe(false);
  });

  it('re-runs a job whose database connection was terminated', async () => {
    jobLog = 'error: terminating connection due to administrator command\n(fail) store > writes [12ms]';
    expect(await rerunIfInfraFailure(1, 'o/r', 'sha')).toEqual({ rerun: true, signature: 'db_connection_lost', runId: 9, runAttempt: 1 });
    expect(calls.at(-1)).toEqual({ path: '/repos/o/r/actions/runs/9/rerun-failed-jobs', method: 'POST' });
  });

  it('a lost database connection is bounded by run_attempt like the infra signatures', async () => {
    jobLog = 'Connection terminated unexpectedly';
    run = { id: 9, run_attempt: 3 };
    expect(await rerunIfInfraFailure(1, 'o/r', 'sha')).toEqual({ rerun: false, reason: 'attempts_exhausted' });
  });

  it('stops re-running once the run has used its attempts', async () => {
    run = { id: 9, run_attempt: 3 };
    expect(await rerunIfInfraFailure(1, 'o/r', 'sha')).toEqual({ rerun: false, reason: 'attempts_exhausted' });
    expect(calls.some(c => c.method === 'POST')).toBe(false);
  });

  it('reports no_run when there is no failed run', async () => {
    run = null;
    expect(await rerunIfInfraFailure(1, 'o/r', 'sha')).toEqual({ rerun: false, reason: 'no_run' });
  });
});
