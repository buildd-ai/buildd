import { describe, expect, it } from 'bun:test';
import {
  isFailingCheckRun,
  isPassingCheckRun,
  isPassingStatus,
  latestRunPerName,
  listAllCheckRuns,
  listAllCommitStatuses,
} from './ci-verdict';

const run = (i: number) => ({ id: i, name: `c-${i}`, status: 'completed', conclusion: 'success' });

/** A GitHub-shaped list endpoint over `rows`, honouring per_page/page. */
function pagedApi(rows: unknown[], key: string, opts: { totalCount?: number | null } = {}) {
  const paths: string[] = [];
  const api = async (_i: number, path: string) => {
    paths.push(path);
    const qs = new URLSearchParams(path.split('?')[1] ?? '');
    const per = Number(qs.get('per_page') ?? 30);
    const page = Number(qs.get('page') ?? 1);
    const body: Record<string, unknown> = { [key]: rows.slice((page - 1) * per, page * per) };
    if (opts.totalCount !== null) body.total_count = opts.totalCount ?? rows.length;
    return body;
  };
  return { api, paths };
}

describe('the passing predicate is an allow-list', () => {
  it('passes only completed success / neutral / skipped', () => {
    for (const c of ['success', 'neutral', 'skipped']) expect(isPassingCheckRun({ status: 'completed', conclusion: c })).toBe(true);
    for (const c of ['failure', 'timed_out', 'cancelled', 'startup_failure', 'action_required', 'stale', 'something_new', null]) {
      expect(isPassingCheckRun({ status: 'completed', conclusion: c })).toBe(false);
    }
    for (const s of ['queued', 'in_progress', 'waiting', 'requested', 'pending', undefined]) {
      expect(isPassingCheckRun({ status: s, conclusion: 'success' })).toBe(false);
    }
  });
  it('treats failure, timed_out and startup_failure as red; cancelled is not red, just not green', () => {
    expect(['failure', 'timed_out', 'startup_failure'].every((c) => isFailingCheckRun({ status: 'completed', conclusion: c }))).toBe(true);
    expect(isFailingCheckRun({ status: 'completed', conclusion: 'cancelled' })).toBe(false);
  });
  it('passes a commit status only when it says success', () => {
    expect(isPassingStatus({ state: 'success' })).toBe(true);
    for (const s of ['failure', 'error', 'pending', undefined]) expect(isPassingStatus({ state: s })).toBe(false);
  });
});

describe('reading every page', () => {
  it('reads 250 check runs over three pages of 100', async () => {
    const { api, paths } = pagedApi(Array.from({ length: 250 }, (_, i) => run(i)), 'check_runs');
    const r = await listAllCheckRuns(api, 1, 'o/r', 'sha');
    expect(r).toMatchObject({ complete: true });
    expect(r.items).toHaveLength(250);
    expect(paths).toEqual([1, 2, 3].map((p) => `/repos/o/r/commits/sha/check-runs?filter=latest&per_page=100&page=${p}`));
  });
  it('stops after one request when the first page holds everything', async () => {
    const { api, paths } = pagedApi([run(1)], 'check_runs');
    expect(await listAllCheckRuns(api, 1, 'o/r', 'sha')).toMatchObject({ complete: true, items: [run(1)] });
    expect(paths).toHaveLength(1);
  });
  it('without total_count, a short page ends the read', async () => {
    const { api, paths } = pagedApi(Array.from({ length: 120 }, (_, i) => run(i)), 'check_runs', { totalCount: null });
    const r = await listAllCheckRuns(api, 1, 'o/r', 'sha');
    expect({ n: r.items.length, complete: r.complete, calls: paths.length }).toEqual({ n: 120, complete: true, calls: 2 });
  });
  it('is incomplete when GitHub returns fewer than its total_count', async () => {
    const { api } = pagedApi([run(1)], 'check_runs', { totalCount: 5 });
    expect(await listAllCheckRuns(api, 1, 'o/r', 'sha')).toMatchObject({ complete: false });
  });
  it('is incomplete past 1000 runs rather than silently truncated', async () => {
    const { api, paths } = pagedApi(Array.from({ length: 1001 }, (_, i) => run(i)), 'check_runs');
    expect(await listAllCheckRuns(api, 1, 'o/r', 'sha')).toMatchObject({ complete: false });
    expect(paths).toHaveLength(10);
  });
  it('throws on a response with no list, so the caller fails closed', async () => {
    await expect(listAllCheckRuns(async () => ({ message: 'weird' }), 1, 'o/r', 'sha')).rejects.toThrow(/no check_runs array/);
  });
  it('pages the combined status the same way', async () => {
    const { api, paths } = pagedApi(Array.from({ length: 101 }, (_, i) => ({ context: `s-${i}`, state: 'success' })), 'statuses');
    const r = await listAllCommitStatuses(api, 1, 'o/r', 'sha');
    expect({ n: r.items.length, complete: r.complete }).toEqual({ n: 101, complete: true });
    expect(paths[0]).toBe('/repos/o/r/commits/sha/status?per_page=100&page=1');
  });
});

describe('latestRunPerName keys a superseded run on (workflow, app, name)', () => {
  const r = (id: number, over: Record<string, unknown> = {}) => ({
    id, name: 'integration', status: 'completed', conclusion: 'success', app: { id: 15368 }, workflow_id: 1, ...over,
  });

  it('a newer pass in one workflow does not hide an older failure of a same-named job in another', () => {
    const kept = latestRunPerName([r(1, { conclusion: 'failure', workflow_id: 1 }), r(2, { workflow_id: 2 })]);
    expect(kept.map((k) => k.id).sort()).toEqual([1, 2]);
    expect(kept.some(isFailingCheckRun)).toBe(true);
  });

  it('a different app with the same check name is a different check', () => {
    expect(latestRunPerName([r(1, { conclusion: 'failure' }), r(2, { app: { id: 7 } })])).toHaveLength(2);
  });

  it('a genuine re-run in the same workflow still replaces the earlier run, in either order', () => {
    expect(latestRunPerName([r(1, { conclusion: 'failure' }), r(2)]).map((k) => k.id)).toEqual([2]);
    expect(latestRunPerName([r(2), r(1, { conclusion: 'failure' })]).map((k) => k.id)).toEqual([2]);
  });

  it('runs without workflow or app info keep the name-only behaviour', () => {
    const bare = (id: number, conclusion: string) => ({ id, name: 'x', status: 'completed', conclusion });
    expect(latestRunPerName([bare(1, 'failure'), bare(2, 'success')]).map((k) => k.id)).toEqual([2]);
  });

  it('unorderable same-workflow runs are both kept (fails closed)', () => {
    const u = (conclusion: string) => ({ name: 'x', status: 'completed', conclusion, workflow_id: 1 });
    expect(latestRunPerName([u('failure'), u('success')])).toHaveLength(2);
  });
});

describe('listAllCheckRuns annotates each run with its workflow', () => {
  const runs = [
    { id: 1, name: 'integration', check_suite: { id: 10 } },
    { id: 2, name: 'integration', check_suite: { id: 20 } },
    { id: 3, name: 'third-party', check_suite: { id: 99 } },
  ];
  const mk = (workflowRuns: unknown, fail = false) => async (_i: number, path: string) => {
    if (path.includes('/check-runs')) return { total_count: runs.length, check_runs: runs };
    if (path.includes('/actions/runs')) {
      if (fail) throw new Error('GitHub API error: 502');
      return workflowRuns;
    }
    throw new Error(`unexpected ${path}`);
  };

  it('maps check suite to workflow_id; a run with no workflow run stays unannotated', async () => {
    const api = mk({ total_count: 2, workflow_runs: [{ check_suite_id: 10, workflow_id: 5 }, { check_suite_id: 20, workflow_id: 6 }] });
    const r = await listAllCheckRuns<{ id: number; workflow_id?: number }>(api, 1, 'o/r', 'sha');
    expect(r.items.map((x) => x.workflow_id)).toEqual([5, 6, undefined]);
  });

  it('an unreadable workflow-run read throws, so callers fail closed', async () => {
    await expect(listAllCheckRuns(mk(null, true), 1, 'o/r', 'sha')).rejects.toThrow();
    await expect(listAllCheckRuns(mk({ nope: [] }), 1, 'o/r', 'sha')).rejects.toThrow();
  });
});
