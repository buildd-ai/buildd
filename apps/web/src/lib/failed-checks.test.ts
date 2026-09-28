import { describe, expect, it } from 'bun:test';
import { failedChecks, MAX_FAILED_CHECKS } from './failed-checks';

const run = (id: number, name: string, conclusion: string | null, status = 'completed') =>
  ({ id, name, status, conclusion, html_url: `https://gh/runs/${id}` });

describe('failedChecks', () => {
  it('names the checks whose latest run failed, with a link', () => {
    expect(failedChecks([run(1, 'build', 'failure'), run(2, 'lint', 'success')]))
      .toEqual([{ name: 'build', conclusion: 'failure', url: 'https://gh/runs/1' }]);
  });

  // A re-run is a new check run with the same name.
  it('a check that failed and then passed on a re-run is not failing', () => {
    expect(failedChecks([run(1, 'build', 'failure'), run(5, 'build', 'success')])).toEqual([]);
  });

  it('a check still running on its re-run is not failing yet', () => {
    expect(failedChecks([run(1, 'build', 'failure'), run(5, 'build', null, 'in_progress')])).toEqual([]);
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
