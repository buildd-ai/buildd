/**
 * Retry-lineage supersession: the create_pr close and the pr-reconcile sweep.
 *
 * The db mock EVALUATES the where clause against fixture rows instead of
 * ignoring it. A mocked db that returns fixed rows makes every predicate
 * unobservable — dropping the `taskClass = 'attempt'` filter, the lineage
 * scope or the open-PR filter would still pass. Here each predicate builder
 * returns a node and `matches` interprets it, so a missing or wrong predicate
 * returns the wrong rows and a test fails.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';

type Row = Record<string, any>;
type Pred =
  | { op: 'eq'; col: string; value: unknown }
  | { op: 'and' | 'or'; preds: Pred[] }
  | { op: 'inArray' | 'notInArray'; col: string; values: unknown[] }
  | { op: 'isNull' | 'isNotNull'; col: string }
  | { op: 'gte'; col: string; value: any };

function matches(row: Row, p: Pred | undefined): boolean {
  if (!p) return true;
  switch (p.op) {
    case 'eq': return row[p.col] === p.value;
    case 'and': return p.preds.filter(Boolean).every(q => matches(row, q));
    case 'or': return p.preds.filter(Boolean).some(q => matches(row, q));
    case 'inArray': return p.values.includes(row[p.col]);
    // SQL NOT IN is NULL-blind: a NULL column never satisfies it.
    case 'notInArray': return row[p.col] != null && !p.values.includes(row[p.col]);
    case 'isNull': return row[p.col] == null;
    case 'isNotNull': return row[p.col] != null;
    case 'gte': return row[p.col] != null && row[p.col] >= p.value;
  }
}

mock.module('drizzle-orm', () => ({
  eq: (col: string, value: unknown) => ({ op: 'eq', col, value }),
  and: (...preds: Pred[]) => ({ op: 'and', preds }),
  or: (...preds: Pred[]) => ({ op: 'or', preds }),
  inArray: (col: string, values: unknown[]) => ({ op: 'inArray', col, values }),
  notInArray: (col: string, values: unknown[]) => ({ op: 'notInArray', col, values }),
  isNull: (col: string) => ({ op: 'isNull', col }),
  isNotNull: (col: string) => ({ op: 'isNotNull', col }),
  gte: (col: string, value: unknown) => ({ op: 'gte', col, value }),
  desc: (col: string) => ({ desc: col }),
  sql: () => ({}),
}));

mock.module('@buildd/core/db/schema', () => ({
  tasks: { id: 'id', parentTaskId: 'parentTaskId', taskClass: 'taskClass', createdAt: 'createdAt', workspaceId: 'workspaceId' },
  workers: {
    id: 'id', taskId: 'taskId', prNumber: 'prNumber', prUrl: 'prUrl', mergedAt: 'mergedAt',
    prLifecycleStatus: 'prLifecycleStatus', workspaceId: 'workspaceId',
  },
  workerErrorTraces: { workerId: 'workerId', pattern: 'pattern', excerpt: 'excerpt', ts: 'ts' },
  workspaces: { id: 'id', gitConfig: 'gitConfig', releaseConfig: 'releaseConfig' },
}));

let TASKS: Row[] = [];
let WORKERS: Row[] = [];
let TRACES: Row[] = [];
let WORKSPACES: Row[] = [];

function select(rows: Row[], args: any): Row[] {
  let out = rows.filter(r => matches(r, args?.where));
  const order = args?.orderBy?.desc;
  if (order) out = [...out].sort((a, b) => (b[order] > a[order] ? 1 : b[order] < a[order] ? -1 : 0));
  if (typeof args?.limit === 'number') out = out.slice(0, args.limit);
  return out.map(r => ({ ...r }));
}

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: {
        findFirst: async (a: any) => select(TASKS, a)[0] ?? null,
        findMany: async (a: any) => select(TASKS, a),
      },
      workers: { findMany: async (a: any) => select(WORKERS, a) },
      workerErrorTraces: { findFirst: async (a: any) => select(TRACES, a)[0] ?? null },
      workspaces: { findFirst: async (a: any) => select(WORKSPACES, a)[0] ?? null },
    },
  },
}));

// GitHub's view of each PR by number. Default: open, unmerged, a buildd task
// branch into `dev` (the repo default). An entry overrides any of those fields.
type LivePr = { state?: string; merged?: boolean; head?: { ref: string } | null; base?: { ref: string; repo?: { default_branch: string } } | null };
let prState: Record<number, LivePr | Error> = {};
const livePr = (n: number, s?: LivePr) => ({
  number: n,
  state: 'open',
  merged: false,
  head: { ref: `buildd/${n}-task` },
  base: { ref: 'dev', repo: { default_branch: 'dev' } },
  ...(s ?? {}),
});
// Mutating calls fail this many times, per `${method} ${path}`, before succeeding.
let failuresLeft: Record<string, { n: number; err: Error }> = {};
const mockGithubApi = mock(async (_inst: number, path: string, init?: any) => {
  const method = init?.method ?? 'GET';
  const key = `${method} ${path}`;
  const f = failuresLeft[key];
  if (f && f.n > 0) { f.n--; throw f.err; }
  if (method === 'GET') {
    const n = Number(String(path).match(/\/pulls\/(\d+)$/)?.[1]);
    const s = prState[n];
    if (s instanceof Error) throw s;
    return livePr(n, s);
  }
  return {};
});
mock.module('@/lib/github', () => ({ githubApi: mockGithubApi }));

const { GATE_SLUGS: REAL_GATE_SLUGS } = await import('@buildd/core/gate-slugs');
const mockFireGateEvent = mock((_e: any) => 'sig');
mock.module('@/lib/gate-ledger', () => ({ GATE_SLUGS: REAL_GATE_SLUGS, fireGateEvent: mockFireGateEvent }));

mock.module('@/lib/repo-scope', () => ({
  repoFullNameFromPrUrl: (u: string | null | undefined) =>
    (u ?? '').match(/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/)?.[1] ?? null,
}));
const mockInstallationIdForRepo = mock(async (_repo: string) => 123 as number | null);
mock.module('@/lib/workspace-installation', () => ({ installationIdForRepo: mockInstallationIdForRepo }));

const {
  closeAncestorRetryPrs,
  collectRetryFamily,
  sweepDuplicateLineagePrs,
  resolveSupersessionCause,
  SWEEP_WINDOW_MS,
} = await import('./retry-pr-supersession');

const NOW = new Date('2026-09-29T12:00:00Z');
const recent = new Date(NOW.getTime() - 60 * 60 * 1000);
const url = (n: number, repo = 'org/repo') => `https://github.com/${repo}/pull/${n}`;

function patchedPrs(): number[] {
  return mockGithubApi.mock.calls
    .filter((c: any[]) => c[2]?.method === 'PATCH')
    .map((c: any[]) => Number(String(c[1]).match(/\/pulls\/(\d+)/)?.[1]));
}
function commentsOn(n: number): string[] {
  return mockGithubApi.mock.calls
    .filter((c: any[]) => c[2]?.method === 'POST' && String(c[1]).endsWith(`/issues/${n}/comments`))
    .map((c: any[]) => JSON.parse(c[2].body).body);
}
function gateEvents(outcome?: string): any[] {
  return mockFireGateEvent.mock.calls.map((c: any[]) => c[0]).filter(e => !outcome || e.outcome === outcome);
}

beforeEach(() => {
  // parentTaskId is not only retry lineage: 'friction-task' was auto-parented to
  // 'mission-task' as creation provenance (resolveCreatorContext). Only a task
  // with taskClass 'attempt' is climbed past.
  TASKS = [
    { id: 'friction-task', parentTaskId: 'mission-task', taskClass: 'work', createdAt: recent, workspaceId: 'ws' },
    { id: 'mission-task', parentTaskId: null, taskClass: 'work', createdAt: recent, workspaceId: 'ws' },
    { id: 'root-a', parentTaskId: null, taskClass: 'work', createdAt: recent, workspaceId: 'ws' },
    { id: 'retry-b', parentTaskId: 'root-a', taskClass: 'attempt', createdAt: recent, workspaceId: 'ws' },
    { id: 'retry-c', parentTaskId: 'retry-b', taskClass: 'attempt', createdAt: recent, workspaceId: 'ws' },
  ];
  WORKERS = [
    { id: 'w-friction', taskId: 'friction-task', prNumber: 2557, prUrl: url(2557), mergedAt: null, prLifecycleStatus: 'pr_open', workspaceId: 'ws' },
    { id: 'w-mission', taskId: 'mission-task', prNumber: 2556, prUrl: url(2556), mergedAt: null, prLifecycleStatus: null, workspaceId: 'ws' },
    { id: 'w-a', taskId: 'root-a', prNumber: 10, prUrl: url(10), mergedAt: null, prLifecycleStatus: 'ci_failed', workspaceId: 'ws' },
    { id: 'w-b', taskId: 'retry-b', prNumber: 20, prUrl: url(20), mergedAt: null, prLifecycleStatus: 'pr_open', workspaceId: 'ws' },
  ];
  TRACES = [];
  WORKSPACES = [{ id: 'ws', gitConfig: { defaultBranch: 'dev' }, releaseConfig: { enabled: true, releaseBranch: 'dev', prodBranch: 'main' } }];
  prState = {};
  failuresLeft = {};
  mockGithubApi.mockClear();
  mockFireGateEvent.mockClear();
  mockInstallationIdForRepo.mockClear();
});

const base = { installationId: 123, repoFullName: 'org/repo', successorBaseBranch: 'dev', workspaceId: 'ws' };

describe('collectRetryFamily — the whole retry tree one subject forks into', () => {
  it('from any member, returns the root and every attempt under it, siblings included', async () => {
    // Two "after review #1" siblings of one root, one of which was itself retried.
    TASKS.push(
      { id: 'sibling-b2', parentTaskId: 'root-a', taskClass: 'attempt', createdAt: recent, workspaceId: 'ws' },
      { id: 'retry-b2-child', parentTaskId: 'sibling-b2', taskClass: 'attempt', createdAt: recent, workspaceId: 'ws' },
    );
    const fam = await collectRetryFamily('retry-c');
    expect(fam.rootId).toBe('root-a');
    expect([...fam.taskIds].sort()).toEqual(['retry-b', 'retry-b2-child', 'retry-c', 'root-a', 'sibling-b2']);
  });

  it('never crosses creation provenance: a non-attempt child is a different family', async () => {
    const fam = await collectRetryFamily('mission-task');
    expect(fam.rootId).toBe('mission-task');
    expect(fam.taskIds).toEqual(['mission-task']);
    // And climbing from the provenance child stops at itself.
    expect((await collectRetryFamily('friction-task')).taskIds).toEqual(['friction-task']);
  });
});

describe('closeAncestorRetryPrs — lineage scope', () => {
  it('does not close a PR reached only via creation-provenance parentTaskId (regression for PR #2556)', async () => {
    await closeAncestorRetryPrs({ ...base, parentTaskId: 'friction-task', successorPrNumber: 2558 });
    expect(patchedPrs()).toContain(2557);
    expect(patchedPrs()).not.toContain(2556);
  });

  it('closes every open PR in a genuine multi-level retry chain', async () => {
    const res = await closeAncestorRetryPrs({ ...base, parentTaskId: 'retry-b', successorPrNumber: 30 });
    expect(patchedPrs().sort()).toEqual([10, 20]);
    expect(res.every(r => r.closed)).toBe(true);
  });

  it('never touches an ancestor PR in a different repo', async () => {
    WORKERS.find(w => w.id === 'w-a')!.prUrl = url(10, 'org/other');
    await closeAncestorRetryPrs({ ...base, parentTaskId: 'retry-b', successorPrNumber: 30 });
    expect(patchedPrs()).toEqual([20]);
  });

  it('skips ancestors the DB already knows are merged or closed, without a GitHub call', async () => {
    WORKERS.find(w => w.id === 'w-a')!.mergedAt = recent;
    WORKERS.find(w => w.id === 'w-b')!.prLifecycleStatus = 'closed';
    const res = await closeAncestorRetryPrs({ ...base, parentTaskId: 'retry-b', successorPrNumber: 30 });
    expect(res).toEqual([]);
    expect(mockGithubApi).not.toHaveBeenCalled();
  });
});

describe('closeAncestorRetryPrs — live state guards', () => {
  it('leaves a PR GitHub says merged alone: no comment, no close', async () => {
    prState[10] = { state: 'closed', merged: true };
    const res = await closeAncestorRetryPrs({ ...base, parentTaskId: 'retry-b', successorPrNumber: 30 });
    expect(patchedPrs()).toEqual([20]);
    expect(commentsOn(10)).toEqual([]);
    expect(res.find(r => r.prNumber === 10)).toEqual({ prNumber: 10, closed: false, reason: 'already merged' });
  });

  it('skips an already-closed PR without recording it as stranded', async () => {
    prState[20] = { state: 'closed', merged: false };
    await closeAncestorRetryPrs({ ...base, parentTaskId: 'retry-b', successorPrNumber: 30 });
    expect(patchedPrs()).toEqual([10]);
    expect(gateEvents('stranded')).toEqual([]);
  });
});

describe('closeAncestorRetryPrs — failures are loud and retried', () => {
  it('retries a close once on a GitHub 5xx and succeeds', async () => {
    failuresLeft['PATCH /repos/org/repo/pulls/20'] = { n: 1, err: new Error('GitHub API error: 502 bad gateway') };
    const res = await closeAncestorRetryPrs({ ...base, parentTaskId: 'retry-b', successorPrNumber: 30 });
    expect(res.find(r => r.prNumber === 20)?.closed).toBe(true);
    expect(gateEvents('stranded')).toEqual([]);
  });

  it('does not retry a 4xx; records a stranded gate event and names the ancestor on the successor', async () => {
    failuresLeft['PATCH /repos/org/repo/pulls/20'] = { n: 5, err: new Error('GitHub API error: 403 forbidden') };
    const res = await closeAncestorRetryPrs({
      ...base, parentTaskId: 'retry-b', successorPrNumber: 30,
      successorWorkerId: 'w-c', workspaceId: 'ws', taskId: 'retry-c',
    });
    const r20 = res.find(r => r.prNumber === 20)!;
    expect(r20.closed).toBe(false);
    expect(r20.reason).toContain('403');
    // One attempt, not two.
    expect(patchedPrs().filter(n => n === 20)).toHaveLength(1);
    const [ev] = gateEvents('stranded');
    expect(ev.gate).toBe(REAL_GATE_SLUGS.RETRY_PR_SUPERSESSION);
    expect(ev.detail).toMatchObject({ prNumber: 20, successorPrNumber: 30 });
    expect(ev.workspaceId).toBe('ws');
    // No explanation comment on a PR that is still open.
    expect(commentsOn(20)).toEqual([]);
    await new Promise(r => setTimeout(r, 0));
    expect(commentsOn(30).join('\n')).toContain('#20');
  });

  it('records an unreadable ancestor as stranded instead of dropping it silently', async () => {
    prState[10] = new Error('GitHub API error: 502');
    const res = await closeAncestorRetryPrs({ ...base, parentTaskId: 'retry-b', successorPrNumber: 30 });
    expect(patchedPrs()).toEqual([20]);
    expect(res.find(r => r.prNumber === 10)?.closed).toBe(false);
    expect(gateEvents('stranded').map(e => e.detail.prNumber)).toEqual([10]);
  });
});

describe('supersession comment names the actual cause', () => {
  it('says "checked out" when the runner reported the branch held by another worktree', async () => {
    TRACES = [{ workerId: 'w-c', pattern: 'resume_branch_held', excerpt: 'held by /tmp/x', ts: recent }];
    await closeAncestorRetryPrs({ ...base, parentTaskId: 'retry-b', successorPrNumber: 30, successorWorkerId: 'w-c' });
    const [c] = commentsOn(20);
    expect(c).toContain('superseded by #30');
    expect(c).toContain('still checked out');
    expect(c).not.toContain('unavailable');
  });

  it('says "gone from the remote" for a missing branch', async () => {
    TRACES = [{ workerId: 'w-c', pattern: 'resume_branch_fallback', excerpt: 'Branch "x" was missing on remote', ts: recent }];
    expect(await resolveSupersessionCause('w-c')).toBe('missing');
    await closeAncestorRetryPrs({ ...base, parentTaskId: 'retry-b', successorPrNumber: 30, successorWorkerId: 'w-c' });
    expect(commentsOn(20)[0]).toContain('gone from the remote');
  });

  it('asserts no cause when the successor reported none', async () => {
    await closeAncestorRetryPrs({ ...base, parentTaskId: 'retry-b', successorPrNumber: 30, successorWorkerId: 'w-c' });
    const [c] = commentsOn(20);
    expect(c).toContain('opened its own PR instead of updating this one');
    expect(c).not.toMatch(/gone|diverged|checked out|unavailable/);
  });

  it("reads only the successor worker's traces", async () => {
    TRACES = [{ workerId: 'someone-else', pattern: 'resume_branch_held', excerpt: '', ts: recent }];
    expect(await resolveSupersessionCause('w-c')).toBe('unknown');
  });

  it('uses the newest trace when there are several', async () => {
    TRACES = [
      { workerId: 'w-c', pattern: 'resume_branch_fallback', excerpt: 'was diverged', ts: new Date(recent.getTime() - 1000) },
      { workerId: 'w-c', pattern: 'resume_branch_held', excerpt: '', ts: recent },
    ];
    expect(await resolveSupersessionCause('w-c')).toBe('checked_out');
  });
});

describe('sweepDuplicateLineagePrs', () => {
  beforeEach(() => {
    WORKERS.push({ id: 'w-c', taskId: 'retry-c', prNumber: 30, prUrl: url(30), mergedAt: null, prLifecycleStatus: 'pr_open', workspaceId: 'ws' });
  });

  it('closes the older open PRs in a retry lineage, keeping the newest, and records each as healed', async () => {
    const res = await sweepDuplicateLineagePrs(NOW);
    expect(patchedPrs().sort()).toEqual([10, 20]);
    expect(patchedPrs()).not.toContain(30);
    expect(res.closed).toBe(2);
    const healed = gateEvents('warned');
    expect(healed.map(e => e.detail.prNumber).sort()).toEqual([10, 20]);
    expect(healed.every(e => e.gate === REAL_GATE_SLUGS.RETRY_PR_SUPERSESSION && e.detail.successorPrNumber === 30)).toBe(true);
    expect(commentsOn(20)[0]).toContain('reconciliation sweep');
  });

  it('does not treat a non-attempt child as a successor (the friction-task case)', async () => {
    // friction-task has an open PR and a parent with an open PR, but it is not an attempt.
    await sweepDuplicateLineagePrs(NOW);
    expect(patchedPrs()).not.toContain(2556);
    expect(patchedPrs()).not.toContain(2557);
  });

  it('ignores attempts older than the window', async () => {
    const old = new Date(NOW.getTime() - SWEEP_WINDOW_MS - 1000);
    for (const t of TASKS) if (t.taskClass === 'attempt') t.createdAt = old;
    const res = await sweepDuplicateLineagePrs(NOW);
    expect(res.candidates).toBe(0);
    expect(mockGithubApi).not.toHaveBeenCalled();
  });

  it('does nothing when the successor itself is no longer open on GitHub', async () => {
    prState[30] = { state: 'closed', merged: false };
    prState[20] = { state: 'closed', merged: false };
    await sweepDuplicateLineagePrs(NOW);
    // #30 is closed so it supersedes nothing; #20 is closed so it supersedes nothing either.
    expect(patchedPrs()).toEqual([]);
  });

  it('skips a successor whose DB row is already merged', async () => {
    WORKERS.find(w => w.id === 'w-c')!.mergedAt = recent;
    WORKERS.find(w => w.id === 'w-b')!.mergedAt = recent;
    await sweepDuplicateLineagePrs(NOW);
    expect(patchedPrs()).toEqual([]);
  });

  it('counts a close that still fails as stranded, so the next run retries it', async () => {
    failuresLeft['PATCH /repos/org/repo/pulls/10'] = { n: 9, err: new Error('GitHub API error: 403') };
    const res = await sweepDuplicateLineagePrs(NOW);
    expect(res.stranded).toBeGreaterThan(0);
    expect(gateEvents('stranded').every(e => e.detail.prNumber === 10)).toBe(true);
    // The sweep never posts the "could not close" note on the successor — that is the create_pr door's job.
    await new Promise(r => setTimeout(r, 0));
    expect(commentsOn(30)).toEqual([]);
  });

  it('skips a repo with no installation', async () => {
    mockInstallationIdForRepo.mockImplementation(async () => null);
    const res = await sweepDuplicateLineagePrs(NOW);
    expect(patchedPrs()).toEqual([]);
    expect(res.skipped).toBe(res.candidates);
    mockInstallationIdForRepo.mockImplementation(async () => 123);
  });
});

/**
 * Regression: a release PR (head = dev, base = main) was closed as "superseded"
 * by the PR its own after-CI fix task opened into dev. The fix task is a retry
 * attempt whose parent is the adopted release task, so the release PR sat in
 * its "retry lineage" — but it is the fix's SUBJECT, not an earlier attempt of
 * the same fix. Only a PR from a task branch, into the same base as the new PR,
 * is an earlier attempt.
 */
describe('closeAncestorRetryPrs — only an earlier attempt of the same fix is superseded', () => {
  beforeEach(() => {
    TASKS.push(
      { id: 'release-task', parentTaskId: null, taskClass: 'work', createdAt: recent, workspaceId: 'ws' },
      { id: 'ci-fix', parentTaskId: 'release-task', taskClass: 'attempt', createdAt: recent, workspaceId: 'ws', context: { prNumber: 3149, iteration: 1 } },
    );
    WORKERS.push(
      { id: 'w-release', taskId: 'release-task', prNumber: 3149, prUrl: url(3149), mergedAt: null, prLifecycleStatus: 'ci_failed', workspaceId: 'ws' },
      { id: 'w-fix', taskId: 'ci-fix', prNumber: 3185, prUrl: url(3185), mergedAt: null, prLifecycleStatus: 'pr_open', workspaceId: 'ws' },
    );
    prState[3149] = { head: { ref: 'dev' }, base: { ref: 'main', repo: { default_branch: 'dev' } } };
    prState[3185] = { head: { ref: 'buildd/ci-fix-task' }, base: { ref: 'dev', repo: { default_branch: 'dev' } } };
  });

  it('create_pr: an after-CI fix PR into dev does not close the release PR it is fixing', async () => {
    const res = await closeAncestorRetryPrs({ ...base, parentTaskId: 'release-task', successorPrNumber: 3185, successorBaseBranch: 'dev' });
    expect(patchedPrs()).not.toContain(3149);
    expect(commentsOn(3149)).toEqual([]);
    expect(res.every(r => !r.closed)).toBe(true);
    // Left open by design: not a stranded close, and nothing posted on the fix PR.
    expect(gateEvents('stranded')).toEqual([]);
    await new Promise(r => setTimeout(r, 0));
    expect(commentsOn(3185)).toEqual([]);
  });

  it('sweep: the same shape is left alone', async () => {
    const res = await sweepDuplicateLineagePrs(NOW);
    expect(patchedPrs()).not.toContain(3149);
    expect(res.stranded).toBe(0);
    expect(gateEvents('stranded')).toEqual([]);
  });

  it('protects a trunk head even when the bases match (head = the release branch)', async () => {
    prState[3149] = { head: { ref: 'dev' }, base: { ref: 'main', repo: { default_branch: 'dev' } } };
    await closeAncestorRetryPrs({ ...base, parentTaskId: 'release-task', successorPrNumber: 3185, successorBaseBranch: 'main' });
    expect(patchedPrs()).not.toContain(3149);
  });

  it("protects the repo's default branch and the workspace's configured branches as heads", async () => {
    // No workspace config at all: GitHub's own default branch still protects.
    WORKSPACES = [];
    prState[3149] = { head: { ref: 'dev' }, base: { ref: 'release', repo: { default_branch: 'dev' } } };
    await closeAncestorRetryPrs({ ...base, parentTaskId: 'release-task', successorPrNumber: 3185, successorBaseBranch: 'release', workspaceId: null });
    expect(patchedPrs()).not.toContain(3149);
    WORKSPACES = [{ id: 'ws', gitConfig: {}, releaseConfig: { enabled: true, prodBranch: 'main', releaseBranch: 'staging' } }];
    for (const head of ['main', 'staging']) {
      prState[3149] = { head: { ref: head }, base: { ref: 'release', repo: { default_branch: 'dev' } } };
      mockGithubApi.mockClear();
      await closeAncestorRetryPrs({ ...base, parentTaskId: 'release-task', successorPrNumber: 3185, successorBaseBranch: 'release' });
      expect(patchedPrs()).not.toContain(3149);
    }
  });

  it('protects a mission integration branch as head', async () => {
    prState[3149] = { head: { ref: 'mission/some-goal' }, base: { ref: 'dev', repo: { default_branch: 'dev' } } };
    await closeAncestorRetryPrs({ ...base, parentTaskId: 'release-task', successorPrNumber: 3185 });
    expect(patchedPrs()).not.toContain(3149);
  });

  it('does not close a task-branch ancestor PR into a different base', async () => {
    prState[3149] = { head: { ref: 'buildd/release-task' }, base: { ref: 'mission/some-goal', repo: { default_branch: 'dev' } } };
    await closeAncestorRetryPrs({ ...base, parentTaskId: 'release-task', successorPrNumber: 3185, successorBaseBranch: 'dev' });
    expect(patchedPrs()).not.toContain(3149);
  });

  it("fails closed when GitHub does not say the ancestor's head or base", async () => {
    prState[3149] = { head: null, base: null };
    await closeAncestorRetryPrs({ ...base, parentTaskId: 'release-task', successorPrNumber: 3185 });
    expect(patchedPrs()).not.toContain(3149);
    prState[3149] = { head: { ref: 'buildd/release-task' } };
    await closeAncestorRetryPrs({ ...base, parentTaskId: 'release-task', successorPrNumber: 3185, successorBaseBranch: undefined });
    expect(patchedPrs()).not.toContain(3149);
  });

  it('still closes a genuine earlier attempt: task branch, same base', async () => {
    prState[3149] = { head: { ref: 'buildd/release-task' }, base: { ref: 'dev', repo: { default_branch: 'dev' } } };
    const res = await closeAncestorRetryPrs({ ...base, parentTaskId: 'release-task', successorPrNumber: 3185 });
    expect(patchedPrs()).toContain(3149);
    expect(res.find(r => r.prNumber === 3149)?.closed).toBe(true);
  });
});
