import { describe, it, expect, mock } from 'bun:test';
import type { CheckRun } from './dispatch';

const mockGithubApi = mock(async (_installationId: number, _path: string, _options?: RequestInit) => ({}) as any);
mock.module('@/lib/github', () => ({ githubApi: mockGithubApi }));

const { classifyCheckRuns, dispatchWorkflowRelease, deploymentOnlyPreflight } = await import('./dispatch');

const run = (over: Partial<CheckRun> = {}): CheckRun => ({
  name: 'build',
  status: 'completed',
  conclusion: 'success',
  ...over,
});

describe('classifyCheckRuns', () => {
  it('is unknown with no checks', () => {
    expect(classifyCheckRuns([])).toEqual({ ciState: 'unknown', failingChecks: [] });
  });

  it('is pending while any check is incomplete', () => {
    const r = classifyCheckRuns([run(), run({ name: 'test', status: 'in_progress', conclusion: null })]);
    expect(r.ciState).toBe('pending');
  });

  it('is passing when all complete and successful', () => {
    expect(classifyCheckRuns([run(), run({ name: 'test' })]).ciState).toBe('passing');
  });

  it('treats neutral and skipped as non-failing', () => {
    const r = classifyCheckRuns([run({ conclusion: 'neutral' }), run({ name: 'lint', conclusion: 'skipped' })]);
    expect(r.ciState).toBe('passing');
  });

  it('is failing and names the failing checks', () => {
    const r = classifyCheckRuns([run(), run({ name: 'test', conclusion: 'failure' }), run({ name: 'e2e', conclusion: 'timed_out' })]);
    expect(r.ciState).toBe('failing');
    expect(r.failingChecks).toEqual(['test', 'e2e']);
  });
});

describe('dispatchWorkflowRelease', () => {
  const staleRun = (createdAgoMs: number) => ({
    id: 1,
    status: 'completed',
    conclusion: 'success',
    html_url: 'https://github.com/o/r/actions/runs/1',
    created_at: new Date(Date.now() - createdAgoMs).toISOString(),
  });

  it('ignores a stale run from before dispatch and returns the fresh one', async () => {
    mockGithubApi.mockReset();
    let call = 0;
    mockGithubApi.mockImplementation(async (_id: number, path: string) => {
      call++;
      if (path.includes('/dispatches')) return {};
      // First poll only sees the old run; second poll sees the new one appear too.
      if (call === 2) return { workflow_runs: [staleRun(14 * 24 * 60 * 60 * 1000)] };
      return {
        workflow_runs: [
          {
            id: 2,
            status: 'queued',
            conclusion: null,
            html_url: 'https://github.com/o/r/actions/runs/2',
            created_at: new Date().toISOString(),
          },
          staleRun(14 * 24 * 60 * 60 * 1000),
        ],
      };
    });

    const result = await dispatchWorkflowRelease(
      1,
      'o',
      'r',
      { workflowFile: 'release.yml', ref: 'dev', inputs: {} },
      { attempts: 2, intervalMs: 1 },
    );

    expect(result.runId).toBe(2);
    expect(result.runUrl).toBe('https://github.com/o/r/actions/runs/2');
  });

  it('returns no run (not a stale one) when nothing created since dispatch ever surfaces', async () => {
    mockGithubApi.mockReset();
    mockGithubApi.mockImplementation(async (_id: number, path: string) => {
      if (path.includes('/dispatches')) return {};
      return { workflow_runs: [staleRun(14 * 24 * 60 * 60 * 1000)] };
    });

    const result = await dispatchWorkflowRelease(
      1,
      'o',
      'r',
      { workflowFile: 'release.yml', ref: 'dev', inputs: {} },
      { attempts: 2, intervalMs: 1 },
    );

    expect(result.runId).toBeUndefined();
    expect(result.runUrl).toBeUndefined();
    expect(result.runsUrl).toContain('release.yml');
  });
});

describe('deploymentOnlyPreflight', () => {
  it('reports CI on prodBranch HEAD directly, without comparing to any source ref', async () => {
    mockGithubApi.mockReset();
    mockGithubApi.mockImplementation(async (_id: number, path: string) => {
      if (path.includes('/git/ref/heads/main')) return { object: { sha: 'deadbeef' } };
      if (path.includes('/commits/deadbeef/check-runs')) {
        return { check_runs: [{ name: 'build', status: 'completed', conclusion: 'success' }] };
      }
      throw new Error(`unexpected path: ${path}`);
    });

    const result = await deploymentOnlyPreflight(1, 'o', 'r', 'main');

    expect(result.ref).toBe('main');
    expect(result.prodBranch).toBe('main');
    expect(result.aheadBy).toBe(0);
    expect(result.shippableCommits).toEqual([]);
    expect(result.refHeadSha).toBe('deadbeef');
    expect(result.ciState).toBe('passing');
  });

  it('leaves ciState unknown when the branch ref cannot be resolved', async () => {
    mockGithubApi.mockReset();
    mockGithubApi.mockImplementation(async () => {
      throw new Error('404');
    });

    const result = await deploymentOnlyPreflight(1, 'o', 'r', 'main');

    expect(result.refHeadSha).toBeUndefined();
    expect(result.ciState).toBe('unknown');
  });
});
