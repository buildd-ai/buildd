/**
 * The kernel's live GitHub reads: only GitHub's own answer is a fact; an
 * unreadable answer is unknown, never the convenient value.
 */
import { describe, expect, test } from 'bun:test';
import { githubReader, readBaseDelta } from './github-facts';

describe('branchExists (close cause, §4)', () => {
  const reader = (answer: () => unknown) => githubReader(1, (async () => answer()) as never);

  test('a branch GitHub returns exists; a 404 is deleted; any other failure is unknown', async () => {
    const asked: string[] = [];
    const ok = githubReader(1, (async (_i: number, path: string) => { asked.push(path); return { name: 'mission/x' }; }) as never);
    expect(await ok.branchExists!('acme/widgets', 'mission/x')).toBe(true);
    expect(asked).toEqual(['/repos/acme/widgets/branches/mission/x']);
    expect(await reader(() => { throw new Error('GitHub API error: 404 {"message":"Branch not found"}'); }).branchExists!('acme/widgets', 'gone')).toBe(false);
    expect(await reader(() => { throw new Error('GitHub API error: 502 Bad Gateway'); }).branchExists!('acme/widgets', 'x')).toBeNull();
    expect(await reader(() => null).branchExists!('acme/widgets', 'x')).toBeNull();
  });
});

describe('readBaseDelta (S15 base delta)', () => {
  const files = (n: number, prefix = 'f') => Array.from({ length: n }, (_, i) => ({ filename: `${prefix}${i}.ts` }));

  test('the commits and files the base gained since the head, and the PR\'s own files', async () => {
    const paths: string[] = [];
    const get = async (path: string) => {
      paths.push(path);
      if (path.includes('/compare/')) return { ahead_by: 4, files: [{ filename: 'src/x.ts' }] };
      return [{ filename: 'src/a.ts' }];
    };
    expect(await readBaseDelta(get, 'acme/w', 7, 'H1', 'dev')).toEqual({ baseCommits: 4, baseFiles: ['src/x.ts'], prFiles: ['src/a.ts'] });
    expect(paths[0]).toBe('/repos/acme/w/compare/H1...dev');
  });

  test('a list that may be cut, or a read that fails, is null on that side (never "nothing changed")', async () => {
    const capped = async (path: string) => (path.includes('/compare/') ? { ahead_by: 400, files: files(300) } : files(100));
    expect(await readBaseDelta(capped, 'acme/w', 7, 'H1', 'dev')).toEqual({ baseCommits: 400, baseFiles: null, prFiles: null });
    const failing = async () => { throw new Error('502'); };
    expect(await readBaseDelta(failing, 'acme/w', 7, 'H1', 'dev')).toEqual({ baseCommits: null, baseFiles: null, prFiles: null });
    // Pages until a short one.
    const paged = async (path: string) => (path.includes('/compare/') ? { ahead_by: 1, files: [] } : path.endsWith('page=1') ? files(100) : files(5, 'g'));
    expect((await readBaseDelta(paged, 'acme/w', 7, 'H1', 'dev')).prFiles).toHaveLength(105);
  });
});

// D12 / AC-15: a merge no buildd door made records who made it, as GitHub reports it.
describe('toLivePr: the merger', () => {
  test('a merged PR carries merged_by; an open one carries nothing extra', async () => {
    const { toLivePr } = await import('./github-facts');
    const merged = toLivePr({ state: 'closed', merged: true, merged_at: '2026-10-01T00:00:00Z', merge_commit_sha: 'm1', merged_by: { login: 'a-person' }, head: { sha: 'h1' }, base: { ref: 'dev' } } as never);
    expect(merged?.mergedBy).toBe('a-person');
    const open = toLivePr({ state: 'open', merged: false, head: { sha: 'h1' }, base: { ref: 'dev' } } as never);
    expect(open && 'mergedBy' in open).toBe(false);
  });
});

describe('changedPaths (§13.13 rule 4)', () => {
  const reader = (files: unknown) => githubReader(1, (async () => ({ files })) as never);
  test('a renamed file counts under its old name too, since a finding was anchored on that one', async () => {
    expect(await reader([{ filename: 'src/b.ts', previous_filename: 'src/a.ts' }, { filename: 'README.md' }]).changedPaths!('o/r', 'A', 'B')).toEqual(['src/b.ts', 'README.md', 'src/a.ts']);
  });
  test('a list at the compare cap may be cut: unread', async () => {
    expect(await reader(Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}.ts` }))).changedPaths!('o/r', 'A', 'B')).toBeNull();
  });
});

describe('a bounded reader (S4a review: the fast heal reads GitHub under a budget)', () => {
  test('every call carries an abort signal; a read GitHub never answers in time reads as failed', async () => {
    const seen: Array<RequestInit | undefined> = [];
    // Answers only when aborted, like fetch with a signal.
    const hanging = (async (_i: number, _p: string, init?: RequestInit) => {
      seen.push(init);
      await new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    }) as never;
    const started = Date.now();
    expect(await githubReader(1, hanging, { timeoutMs: 30 }).readPr('acme/app', 7)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  test('without a timeout nothing changes: no signal is added', async () => {
    const seen: Array<RequestInit | undefined> = [];
    await githubReader(1, (async (_i: number, _p: string, init?: RequestInit) => { seen.push(init); return null; }) as never).readPr('acme/app', 7);
    expect(seen[0]?.signal).toBeUndefined();
  });
});

describe('a re-run supersedes the run it replaced (6900a317)', () => {
  // One head, one workflow triggered twice (a PR-body edit re-runs it): GitHub keeps the
  // first run's failed suite next to the passing one, under the same check name.
  const run = (id: number, name: string, suite: number, conclusion: string | null, status = 'completed') =>
    ({ id, name, status, conclusion, check_suite: { id: suite }, started_at: new Date(1_000_000 + id).toISOString() });
  const suite = (id: number, conclusion: string | null, status = 'completed') => ({ id, status, conclusion });
  const api = (runs: unknown[], suites: unknown[]) => (async (_i: number, path: string) => {
    if (path.includes('/check-runs')) return { total_count: runs.length, check_runs: runs };
    if (path.includes('/check-suites')) return { total_count: suites.length, check_suites: suites };
    // Every suite here is the one workflow, triggered more than once.
    if (path.includes('/actions/runs')) {
      const wr = (runs as Array<{ check_suite?: { id: number } }>).map((r) => ({ check_suite_id: r.check_suite?.id, workflow_id: 1 }));
      return { total_count: wr.length, workflow_runs: wr };
    }
    throw new Error(`unexpected ${path}`);
  }) as never;

  test('checkRuns: a failed run a newer same-name run replaced is not failing', async () => {
    const r = githubReader(1, api([run(1, 'build', 10, 'success'), run(2, 'check', 20, 'failure'), run(3, 'check', 30, 'success')], []));
    expect(await r.checkRuns!('acme/widgets', 'H1')).toEqual({ complete: true, failing: [] });
  });
  test('checkRuns: a newer failure still fails, and a re-run still going is not complete', async () => {
    const r = githubReader(1, api([run(2, 'check', 20, 'success'), run(3, 'check', 30, 'failure')], []));
    expect(await r.checkRuns!('acme/widgets', 'H1')).toEqual({ complete: true, failing: ['check'] });
    const going = githubReader(1, api([run(2, 'check', 20, 'failure'), run(3, 'check', 30, null, 'in_progress')], []));
    expect(await going.checkRuns!('acme/widgets', 'H1')).toEqual({ complete: false, failing: [] });
  });
  test('ciGreen: a failed suite whose every run was re-run green elsewhere does not hold the head red', async () => {
    const runs = [run(1, 'build', 10, 'success'), run(2, 'check', 20, 'failure'), run(3, 'check', 30, 'success')];
    const r = githubReader(1, api(runs, [suite(10, 'success'), suite(20, 'failure'), suite(30, 'success')]));
    expect(await r.ciGreen!('acme/widgets', 'H1')).toBe(true);
  });
  test('ciGreen: a failed suite with a run nothing replaced, or with no runs at all, is still red', async () => {
    const partly = [run(2, 'check', 20, 'failure'), run(4, 'lint', 20, 'failure'), run(3, 'check', 30, 'success')];
    expect(await githubReader(1, api(partly, [suite(20, 'failure'), suite(30, 'success')])).ciGreen!('acme/widgets', 'H1')).toBe(false);
    expect(await githubReader(1, api([run(3, 'check', 30, 'success')], [suite(20, 'failure'), suite(30, 'success')])).ciGreen!('acme/widgets', 'H1')).toBe(false);
  });
  test('ciGreen: unreadable runs fall back to the suites alone (fails closed)', async () => {
    const suitesOnly = (async (_i: number, path: string) => {
      if (path.includes('/check-suites')) return { check_suites: [suite(20, 'failure'), suite(30, 'success')] };
      throw new Error('GitHub API error: 502');
    }) as never;
    expect(await githubReader(1, suitesOnly).ciGreen!('acme/widgets', 'H1')).toBe(false);
  });
});
