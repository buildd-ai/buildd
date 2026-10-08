import { describe, expect, it } from 'bun:test';
import { failedChecks, MAX_FAILED_CHECKS } from './failed-checks';

const run = (id: number, name: string, conclusion: string | null, status = 'completed') =>
  ({ id, name, status, conclusion, html_url: `https://gh/runs/${id}` });

describe('failedChecks', () => {
  it('names the checks whose latest run failed, with a link', () => {
    expect(failedChecks([run(1, 'build', 'failure'), run(2, 'lint', 'success')]))
      .toEqual([{ name: 'build', conclusion: 'failure', url: 'https://gh/runs/1' }]);
  });

  // A PR body edit triggers a new workflow run (same head SHA). The new run's
  // passing check supersedes the old run's failure of the same check. The
  // latest run per check name (by ID, which is monotonic) determines failure.
  it('old failing + new passing run of same check: latest passing run wins', () => {
    expect(failedChecks([run(1, 'test', 'failure'), run(5, 'test', 'success')]).map(c => c.url)).toEqual([]);
  });

  it('old passing + new failing run of same check: latest failing run loses', () => {
    expect(failedChecks([run(1, 'test', 'success'), run(5, 'test', 'failure')]).map(c => c.url)).toEqual(['https://gh/runs/5']);
  });

  it('same check run twice with no ordering: both are kept (fail closed)', () => {
    const run1 = { name: 'test', status: 'completed', conclusion: 'failure', html_url: 'https://gh/runs/1' };
    const run2 = { name: 'test', status: 'completed', conclusion: 'success', html_url: 'https://gh/runs/2' };
    const noOrderInfo = [{ ...run1, id: undefined, started_at: undefined }, { ...run2, id: undefined, started_at: undefined }];
    expect(failedChecks(noOrderInfo as any).map(c => c.url)).toEqual(['https://gh/runs/1']);
  });

  it('a check still running is not failing', () => {
    expect(failedChecks([run(5, 'build', null, 'in_progress')])).toEqual([]);
  });

  it('timed out, cancelled and action required count as failing', () => {
    expect(failedChecks([run(1, 'a', 'timed_out'), run(2, 'b', 'cancelled'), run(3, 'c', 'action_required')]).map(c => c.name)).toEqual(['a', 'b', 'c']);
  });

  it('is capped', () => {
    const many = Array.from({ length: 12 }, (_, i) => run(i + 1, `c${i}`, 'failure'));
    expect(failedChecks(many)).toHaveLength(MAX_FAILED_CHECKS);
  });

  it('tolerates junk', () => {
    expect(failedChecks([null, {}, { name: 'x' }] as any)).toEqual([]);
  });
});
