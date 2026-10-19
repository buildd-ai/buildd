/**
 * Home's open-PR reads, from source: a PR counts as merged when ANY worker row
 * carrying it recorded the merge, and one PR is one card.
 *
 * Several rows can carry one PR (a CI-retry attempt pushes to its parent's
 * branch and adopts the PR number). `isNull(workers.mergedAt)` only says that
 * this row did not see the merge, so each query that lists open PRs also needs
 * `noRowOfPrMerged()`. Without it Home kept a "Merge PR #N" card after the PR
 * merged. The predicate itself is rendered and checked in
 * lib/pr-merge-stamp.test.ts.
 */
import { describe, expect, it } from 'bun:test';

const home = await Bun.file(new URL('./page.tsx', import.meta.url)).text();

function blockAfter(src: string, marker: string, end: string): string {
  const at = src.indexOf(marker);
  expect(at).toBeGreaterThan(-1);
  return src.slice(at, src.indexOf(end, at));
}

describe('Home open-PR reads honour a merge recorded on any row of the PR', () => {
  it('the escalation-inbox query (Merge / CI cards)', () => {
    const block = blockAfter(home, 'function openPrWorkersQuery(wsIds: string[]) {', 'columns: {');
    expect(block).toContain('isNull(workers.mergedAt)');
    expect(block).toContain('noRowOfPrMerged()');
  });

  it('collapses the open PR rows to one per PR before building cards', () => {
    expect(home).toMatch(/const openPrWorkers = oneRowPerPr\(r1\.openPrWorkers/);
  });

  it('the dependency-blocker merge cards', () => {
    const at = home.indexOf('upstreamTasks: upstreamIds.length > 0 ? db.query.tasks.findMany({');
    const block = blockAfter(home.slice(at), 'workers: {', 'columns: {');
    expect(block).toContain('isNull(workers.mergedAt)');
    expect(block).toContain('noRowOfPrMerged()');
  });

});
