/**
 * The integration-refresh PR rules every merge door shares: merge method,
 * effective delta, and the post-merge ancestry proof.
 *
 * The ancestry tests model a tiny commit graph and answer GitHub's compare API
 * from it, so "squash" and "merge commit" are real graph shapes, not flags.
 */
import { describe, it, expect } from 'bun:test';
import {
  integrationRefreshOf,
  resolveMergeMethod,
  refreshDeltaBase,
  effectiveDeltaFiles,
  verifyRefreshLanded,
  COMPARE_FILES_CAP,
  refreshFiledFor,
  requeueBranchContext,
  refreshPrIsEmpty,
  isAncestor,
} from './integration-refresh';

const REFRESH_CTX = { requireMergeCommit: true, refreshTrunk: 'dev', refreshTrunkSha: 'dev-2', refreshMissionHeadSha: 'm-1' };

describe('refreshFiledFor: the branch a refresh was filed for survives a requeue (task 0427d13b, #4909)', () => {
  it('reads the explicit refreshBranch first', () => {
    expect(refreshFiledFor({ ...REFRESH_CTX, refreshBranch: 'mission/a', baseBranch: 'buildd/x', resumeBranch: 'buildd/x' })).toBe('mission/a');
  });

  it('reads baseBranch on a refresh filed before refreshBranch existed', () => {
    expect(refreshFiledFor({ ...REFRESH_CTX, baseBranch: 'mission/a' })).toBe('mission/a');
    expect(refreshFiledFor({ ...REFRESH_CTX, baseBranch: 'mission/a', resumeBranch: 'buildd/x' })).toBe('mission/a');
  });

  it('a baseBranch a requeue overwrote with the task\'s own head is not a filed-for branch', () => {
    // The #4909 shape: an infra requeue set baseBranch = resumeBranch = the refresh's own head.
    expect(refreshFiledFor({ ...REFRESH_CTX, baseBranch: 'buildd/7f-chore', resumeBranch: 'buildd/7f-chore' })).toBeNull();
  });

  it('is null for anything that is not a refresh', () => {
    expect(refreshFiledFor({ baseBranch: 'mission/a', refreshBranch: 'mission/a' })).toBeNull();
    expect(refreshFiledFor(null)).toBeNull();
  });
});

describe('requeueBranchContext', () => {
  it('an ordinary task resumes on its branch and builds on it', () => {
    expect(requeueBranchContext({ baseBranch: 'mission/a' }, 'buildd/t')).toEqual({ baseBranch: 'buildd/t', resumeBranch: 'buildd/t' });
  });

  it('a refresh resumes on its branch but keeps the branch it was filed for', () => {
    expect(requeueBranchContext({ ...REFRESH_CTX, baseBranch: 'mission/a' }, 'buildd/r')).toEqual({ resumeBranch: 'buildd/r' });
  });

  it('adds nothing without a branch', () => {
    expect(requeueBranchContext({ baseBranch: 'mission/a' }, null)).toEqual({});
  });
});

describe('resolveMergeMethod', () => {
  it('lands a refresh PR as a merge commit even when the caller asked for squash or rebase', () => {
    expect(resolveMergeMethod(REFRESH_CTX)).toBe('merge');
    expect(resolveMergeMethod(REFRESH_CTX, 'squash')).toBe('merge');
    expect(resolveMergeMethod(REFRESH_CTX, 'rebase')).toBe('merge');
    // A legacy refresh task with only the flag is still a refresh.
    expect(resolveMergeMethod({ requireMergeCommit: true }, 'squash')).toBe('merge');
  });

  it('leaves an ordinary task PR on its requested method, squash by default', () => {
    expect(resolveMergeMethod({ baseBranch: 'mission/x' })).toBe('squash');
    expect(resolveMergeMethod(null)).toBe('squash');
    expect(resolveMergeMethod(undefined, 'rebase')).toBe('rebase');
    expect(resolveMergeMethod({ requireMergeCommit: 'yes' }, 'squash')).toBe('squash');
  });
});

describe('refreshDeltaBase', () => {
  it('is the recorded trunk for a refresh task', () => {
    expect(refreshDeltaBase(REFRESH_CTX, { targetBranch: 'main' })).toBe('dev');
  });
  it('falls back to the workspace trunk for a refresh task that predates the field', () => {
    expect(refreshDeltaBase({ requireMergeCommit: true }, { targetBranch: 'dev' })).toBe('dev');
    expect(refreshDeltaBase({ requireMergeCommit: true }, { defaultBranch: 'main' })).toBe('main');
  });
  it('is null for any other task', () => {
    expect(refreshDeltaBase({}, { targetBranch: 'dev' })).toBeNull();
    expect(integrationRefreshOf({ baseBranch: 'mission/x' })).toBeNull();
  });
});

describe('effectiveDeltaFiles', () => {
  it('reads trunk...head, so inherited trunk files are not in the list', async () => {
    const paths: string[] = [];
    const files = await effectiveDeltaFiles(1, 'o/r', 'dev', 'head-sha', async (_i, path) => {
      paths.push(path);
      return { files: [{ filename: 'packages/core/drizzle/0300_mission.sql', status: 'added', additions: 3, deletions: 0 }] };
    });
    expect(paths).toEqual(['/repos/o/r/compare/dev...head-sha']);
    expect(files?.map(f => f.filename)).toEqual(['packages/core/drizzle/0300_mission.sql']);
  });

  it('encodes a slashed base ref segment-wise', async () => {
    const paths: string[] = [];
    await effectiveDeltaFiles(1, 'o/r', 'release/x y', 'h', async (_i, path) => { paths.push(path); return { files: [] }; });
    expect(paths[0]).toBe('/repos/o/r/compare/release/x%20y...h');
  });

  it('is null (keep the larger PR list) when the read fails or may be truncated', async () => {
    expect(await effectiveDeltaFiles(1, 'o/r', 'dev', 'h', async () => { throw new Error('GitHub API error: 500'); })).toBeNull();
    expect(await effectiveDeltaFiles(1, 'o/r', 'dev', 'h', async () => ({}))).toBeNull();
    const many = Array.from({ length: COMPARE_FILES_CAP }, (_, i) => ({ filename: `f${i}`, status: 'added', additions: 1, deletions: 0 }));
    expect(await effectiveDeltaFiles(1, 'o/r', 'dev', 'h', async () => ({ files: many }))).toBeNull();
  });
});

// Friction 0e0a8c78: three writers merged dev into one mission branch within
// two minutes, and the refresh PR then opened with a 0-file diff and merged.
describe('refreshPrIsEmpty: a refresh PR another writer already did is superseded before it opens', () => {
  const answer = (o: { contains: boolean | 'fail'; files: unknown[] | 'fail' }) => {
    const paths: string[] = [];
    const api = async (_i: number, path: string) => {
      paths.push(path);
      if (path.includes('/compare/dev-2...')) {
        if (o.contains === 'fail') throw new Error('GitHub API error: 502');
        return { status: o.contains ? 'ahead' : 'diverged' };
      }
      if (o.files === 'fail') throw new Error('GitHub API error: 502');
      return { files: o.files };
    };
    return { api, paths };
  };
  const ask = (api: any, context: unknown = REFRESH_CTX) =>
    refreshPrIsEmpty({ installationId: 1, repoFullName: 'o/r', context, base: 'mission/a', head: 'buildd/r', api });

  it('is empty when the base already contains the trunk sha and the head adds no file', async () => {
    const { api, paths } = answer({ contains: true, files: [] });
    expect(await ask(api)).toEqual({ trunk: 'dev', trunkSha: 'dev-2' });
    expect(paths).toEqual(['/repos/o/r/compare/dev-2...mission/a', '/repos/o/r/compare/mission/a...buildd/r']);
  });

  it('opens as before when the base is still missing the trunk sha', async () => {
    expect(await ask(answer({ contains: false, files: [] }).api)).toBeNull();
  });

  it('opens as before when the head carries a file of its own (a conflict resolution)', async () => {
    expect(await ask(answer({ contains: true, files: [{ filename: 'a.ts', status: 'modified', additions: 1, deletions: 1 }] }).api)).toBeNull();
  });

  it('fails open on a read failure, and for a PR that is not a refresh', async () => {
    expect(await ask(answer({ contains: 'fail', files: [] }).api)).toBeNull();
    expect(await ask(answer({ contains: true, files: 'fail' }).api)).toBeNull();
    expect(await ask(answer({ contains: true, files: [] }).api, { baseBranch: 'mission/a' })).toBeNull();
    expect(await ask(answer({ contains: true, files: [] }).api, { requireMergeCommit: true })).toBeNull();
  });
});

// ── Commit graph ────────────────────────────────────────────────────────────

/** parents[sha] = parent shas. */
function graphApi(parents: Record<string, string[]>, branchHead: string, opts: { failCompare?: boolean } = {}) {
  const ancestorsOf = (sha: string): Set<string> => {
    const seen = new Set<string>();
    const stack = [sha];
    while (stack.length) {
      const s = stack.pop()!;
      if (seen.has(s)) continue;
      seen.add(s);
      stack.push(...(parents[s] ?? []));
    }
    return seen;
  };
  return async (_i: number, path: string) => {
    if (path.includes('/git/ref/heads/')) return { object: { sha: branchHead } };
    const m = /\/compare\/(.+)\.\.\.(.+)$/.exec(path);
    if (!m) throw new Error(`unexpected path ${path}`);
    if (opts.failCompare) throw new Error('GitHub API error: 502');
    const resolve = (ref: string) => (ref === 'dev' ? 'dev-2' : ref);
    const [base, head] = [resolve(m[1]), resolve(m[2])];
    const headAnc = ancestorsOf(head);
    const baseAnc = ancestorsOf(base);
    const status = base === head ? 'identical' : headAnc.has(base) ? 'ahead' : baseAnc.has(head) ? 'behind' : 'diverged';
    const mergeBase = [...headAnc].find(s => baseAnc.has(s) && ![...headAnc].some(o => o !== s && baseAnc.has(o) && ancestorsOf(o).has(s)));
    return { status, merge_base_commit: { sha: mergeBase } };
  };
}

// dev-0 ← dev-1 ← dev-2 (trunk). Mission forked at dev-0: dev-0 ← m-1.
// The resolution branch: r-1 = merge(m-1, dev-2).
const BASE_GRAPH: Record<string, string[]> = {
  'dev-1': ['dev-0'],
  'dev-2': ['dev-1'],
  'm-1': ['dev-0'],
  'r-1': ['m-1', 'dev-2'],
};

describe('verifyRefreshLanded', () => {
  const refresh = integrationRefreshOf(REFRESH_CTX)!;

  it('passes when the PR landed as a merge commit (two parents) carrying dev', async () => {
    // GitHub's merge commit for the PR: parents [m-1, r-1].
    const graph = { ...BASE_GRAPH, 'pr-merge': ['m-1', 'r-1'] };
    const verdict = await verifyRefreshLanded({
      installationId: 1, repoFullName: 'o/r', branch: 'mission/x', trunk: 'dev', refresh, prHeadSha: 'r-1',
      api: graphApi(graph, 'pr-merge'),
    });
    expect(graph['pr-merge']).toHaveLength(2);
    expect(verdict).toEqual({ ok: true, branchHead: 'pr-merge', trunkSha: 'dev-2' });
  });

  it('fails, naming dev, when the PR was squashed (one parent, dev not in history)', async () => {
    // A squash: same tree, single parent m-1 — dev-2 is not an ancestor.
    const graph = { ...BASE_GRAPH, squash: ['m-1'] };
    const verdict = await verifyRefreshLanded({
      installationId: 1, repoFullName: 'o/r', branch: 'mission/x', trunk: 'dev', refresh, prHeadSha: 'r-1',
      api: graphApi(graph, 'squash'),
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.transient).toBe(false);
    expect(verdict.missing).toEqual(['dev dev-2']);
    expect(verdict.reason).toContain('squash or rebase');
  });

  it('fails when the mission work it started from is no longer in the branch', async () => {
    // Someone replaced the branch with dev: dev-2 present, m-1 gone.
    const verdict = await verifyRefreshLanded({
      installationId: 1, repoFullName: 'o/r', branch: 'mission/x', trunk: 'dev', refresh, prHeadSha: 'r-1',
      api: graphApi(BASE_GRAPH, 'dev-2'),
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.missing).toEqual(['mission head m-1']);
  });

  it('a legacy task without a recorded trunk sha checks what its PR head merged in', async () => {
    const legacy = integrationRefreshOf({ requireMergeCommit: true })!;
    const squashed = await verifyRefreshLanded({
      installationId: 1, repoFullName: 'o/r', branch: 'mission/x', trunk: 'dev', refresh: legacy, prHeadSha: 'r-1',
      api: graphApi({ ...BASE_GRAPH, squash: ['m-1'] }, 'squash'),
    });
    expect(squashed.ok).toBe(false);
    if (!squashed.ok) expect(squashed.missing).toEqual(['dev dev-2']);

    // ...and a later real repair (a merge carrying dev-2) clears it.
    const repaired = await verifyRefreshLanded({
      installationId: 1, repoFullName: 'o/r', branch: 'mission/x', trunk: 'dev', refresh: legacy, prHeadSha: 'r-1',
      api: graphApi({ ...BASE_GRAPH, squash: ['m-1'], repair: ['squash', 'dev-2'] }, 'repair'),
    });
    expect(repaired.ok).toBe(true);
  });

  it('a failed read is transient, never a violation', async () => {
    const verdict = await verifyRefreshLanded({
      installationId: 1, repoFullName: 'o/r', branch: 'mission/x', trunk: 'dev', refresh, prHeadSha: 'r-1',
      api: graphApi(BASE_GRAPH, 'r-1', { failCompare: true }),
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.transient).toBe(true);
  });
});

describe('isAncestor: a settled answer between two commits is read from GitHub once', () => {
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  const counting = (status: string | (() => never)) => {
    const calls: string[] = [];
    const api = async (_i: number, path: string) => {
      calls.push(path);
      if (typeof status === 'function') return status();
      return { status };
    };
    return { api, calls };
  };

  it('asks once for the same pair of commit SHAs, whatever the answer', async () => {
    for (const status of ['ahead', 'diverged']) {
      const { api, calls } = counting(status);
      const first = await isAncestor(1, 'o/r', A, B, api);
      expect(await isAncestor(1, 'o/r', A, B, api)).toBe(first);
      expect(calls).toHaveLength(1);
    }
  });

  it('asks again for a branch name, which can move', async () => {
    const { api, calls } = counting('ahead');
    await isAncestor(1, 'o/r', A, 'dev', api);
    await isAncestor(1, 'o/r', A, 'dev', api);
    expect(calls).toHaveLength(2);
  });

  it('asks again after a failed read', async () => {
    const { api, calls } = counting(() => { throw new Error('timeout'); });
    expect(await isAncestor(1, 'o/r', A, B, api)).toBeNull();
    expect(await isAncestor(1, 'o/r', A, B, api)).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it('keeps each repo apart', async () => {
    const { api, calls } = counting('ahead');
    await isAncestor(1, 'o/r', A, B, api);
    await isAncestor(1, 'o/other', A, B, api);
    expect(calls).toHaveLength(2);
  });
});
