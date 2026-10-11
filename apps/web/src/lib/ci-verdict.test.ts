import { describe, expect, it } from 'bun:test';
import {
  isFailingCheckRun,
  isPassingCheckRun,
  isPassingStatus,
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
