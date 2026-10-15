/**
 * Mission deliveries and epochs on real Postgres (docs/specs/workflow-kernel-library.md
 * §6, AC-20–AC-23; tasks f3bda4e1 and a11abc4b): the one write statement's
 * compare-and-set and unique indexes, rotation under replay and concurrency,
 * and the steps a merge leaves owed (cut the successor, settle the PRs left on
 * the merged branch, retire it), against an in-process fake of GitHub's refs,
 * pulls, compare and merges APIs.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { q, seedMission, seedWorkspace } from './harness';

const epochs = await import('../../src/lib/workflow/delivery-epochs');
type Deps = NonNullable<Parameters<typeof epochs.epochMerged>[1]>;

const REPO = 'acme/app';
const TRUNK = 'dev';
const ROOT = 'mission/kernel';

// ── A fake GitHub: refs, PRs, ancestry, trees ───────────────────────────────

interface FakePr { number: number; state: 'open' | 'closed'; base: string; headSha: string; merged?: boolean; mergeCommitSha?: string; headRef?: string; mergedAt?: string }

class FakeGithub {
  refs = new Map<string, string>();
  prs = new Map<number, FakePr>();
  /** sha → its ancestors (itself excluded). */
  ancestors = new Map<string, Set<string>>();
  trees = new Map<string, string>();
  /** Heads whose test merge into anything conflicts. */
  conflicts = new Set<string>();
  /** Heads whose test merge leaves the base tree unchanged (content already there, no ancestry). */
  sameTree = new Set<string>();
  /** Fail the next N calls whose method+path matches. */
  failNext: Array<{ method: string; path: RegExp }> = [];
  /** Called on each test merge, before it answers (e.g. a push racing the content check). */
  onMerge: (() => void) | null = null;
  calls: Array<{ method: string; path: string; body?: unknown }> = [];
  private seq = 0;

  commit(sha: string, parents: string[], tree = `tree-${sha}`): string {
    const anc = new Set<string>();
    for (const p of parents) { anc.add(p); for (const a of this.ancestors.get(p) ?? []) anc.add(a); }
    this.ancestors.set(sha, anc);
    this.trees.set(sha, tree);
    return sha;
  }

  private err(status: number, msg: string): never { throw new Error(`GitHub API error: ${status} ${msg}`); }

  api: epochs.GithubApi = async (_inst, path, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ method, path, body });
    const f = this.failNext.findIndex((x) => x.method === method && x.path.test(path));
    if (f >= 0) { this.failNext.splice(f, 1); this.err(502, 'Bad Gateway'); }
    const p = path.replace(`/repos/${REPO}`, '');
    let m: RegExpExecArray | null;
    if ((m = /^\/git\/ref\/heads\/(.+)$/.exec(p)) && method === 'GET') {
      const ref = decodeURIComponent(m[1]!);
      const sha = this.refs.get(ref);
      return sha ? { object: { sha } } : this.err(404, 'Not Found');
    }
    if (p === '/git/refs' && method === 'POST') {
      const ref = String(body.ref).replace('refs/heads/', '');
      if (this.refs.has(ref)) this.err(422, 'Reference already exists');
      this.refs.set(ref, body.sha);
      return { ref: body.ref };
    }
    if ((m = /^\/git\/refs\/heads\/(.+)$/.exec(p))) {
      const ref = m[1]!.split('/').map(decodeURIComponent).join('/');
      if (method === 'DELETE') { if (!this.refs.delete(ref)) this.err(422, 'Reference does not exist'); return null; }
      if (method === 'PATCH') { this.refs.set(ref, body.sha); return {}; }
    }
    if ((m = /^\/git\/commits\/(.+)$/.exec(p))) return { tree: { sha: this.trees.get(m[1]!) } };
    if ((m = /^\/compare\/(.+)\.\.\.(.+)$/.exec(p))) {
      const [a, b] = [m[1]!, m[2]!];
      if (a === b) return { status: 'identical' };
      if (this.ancestors.get(b)?.has(a)) return { status: 'ahead' };
      if (this.ancestors.get(a)?.has(b)) return { status: 'behind' };
      return { status: 'diverged' };
    }
    if (p === '/merges' && method === 'POST') {
      this.onMerge?.();
      const base = this.refs.get(body.base)!;
      const head = body.head as string;
      if (head === base || this.ancestors.get(base)?.has(head)) return null;
      if (this.conflicts.has(head)) this.err(409, 'Merge conflict');
      const sha = `merge-${++this.seq}`;
      this.commit(sha, [base, head], this.sameTree.has(head) ? this.trees.get(base) : `tree-${sha}`);
      this.refs.set(body.base, sha);
      return { sha, parents: [{ sha: base }, { sha: head }], commit: { tree: { sha: this.trees.get(sha) } } };
    }
    if ((m = /^\/pulls\?(.*)$/.exec(p))) {
      const params = new URLSearchParams(m[1]);
      return [...this.prs.values()]
        .filter((x) => x.state === params.get('state') && (!params.get('base') || x.base === params.get('base')))
        .map((x) => ({ number: x.number, head: { sha: x.headSha }, base: { ref: x.base } }));
    }
    if ((m = /^\/pulls\/(\d+)$/.exec(p))) {
      const pr = this.prs.get(Number(m[1]));
      if (!pr) this.err(404, 'Not Found');
      if (method === 'PATCH') {
        if (body.base) pr!.base = body.base;
        if (body.state) pr!.state = body.state;
        return {};
      }
      return { number: pr!.number, state: pr!.state, merged: !!pr!.merged, merge_commit_sha: pr!.mergeCommitSha ?? null, merged_at: pr!.mergedAt ?? null, head: { sha: pr!.headSha, ref: pr!.headRef }, base: { ref: pr!.base } };
    }
    if (/^\/issues\/\d+\/comments$/.test(p)) return {};
    throw new Error(`fake GitHub: unhandled ${method} ${path}`);
  };

  /** Merge an epoch's PR the way GitHub does, optionally deleting its head and retargeting what was on it. */
  mergeEpochPr(n: number, opts: { deleteBranch?: boolean } = {}): string {
    const pr = this.prs.get(n)!;
    const trunkHead = this.refs.get(TRUNK)!;
    const sha = this.commit(`m-${n}`, [trunkHead, pr.headSha]);
    this.refs.set(TRUNK, sha);
    Object.assign(pr, { state: 'closed', merged: true, mergeCommitSha: sha, mergedAt: '2026-10-14T12:00:00.000Z' });
    if (opts.deleteBranch && pr.headRef) {
      this.refs.delete(pr.headRef);
      for (const other of this.prs.values()) if (other.state === 'open' && other.base === pr.headRef) other.base = TRUNK;
    }
    return sha;
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────

let gh: FakeGithub;
let missionId: string;
let workspaceId: string;
let work = { unfinishedTasks: 1, openTaskPrs: 0 };
let refreshPrs = new Set<number>();
let superseded: Array<{ prNumber: number; satisfiedBy: number }> = [];
let notes: string[] = [];

const deps = (): Deps => ({
  api: gh.api,
  workOf: async () => work,
  legacyPrOf: async () => null,
  repoOf: async () => ({ workspaceId, installationId: 1, repoFullName: REPO, trunk: TRUNK }),
  refreshPrsOf: async () => refreshPrs,
  recordSupersession: async (p) => { superseded.push({ prNumber: p.prNumber, satisfiedBy: p.satisfiedBy.prNumber }); },
  noteHeld: async (_m, title) => { notes.push(title); },
  obsoleteRefreshTasksOf: async () => [],
  cancelTask: async () => {},
});

async function epochRows() {
  return q<{ epoch: number; branch: string; state: string; pr_number: number | null; cut_from_sha: string | null; settled_at: string | null; retired_at: string | null; settlement: { held?: unknown[]; settled?: Array<{ prNumber: number; disposition: string }> } | null }>(
    sql`SELECT epoch, branch, state, pr_number, cut_from_sha, settled_at, retired_at, settlement FROM workflow_mission_epochs WHERE mission_id = ${missionId}::uuid ORDER BY epoch`,
  );
}
async function workingBranch(): Promise<string | null> {
  return (await q<{ working_branch: string | null }>(sql`SELECT working_branch FROM missions WHERE id = ${missionId}::uuid`))[0]?.working_branch ?? null;
}

/** Epoch 1 with mission PR #10 open on ROOT, one task PR #11 on ROOT. */
async function inFlight() {
  gh.commit('t0', []);
  gh.refs.set(TRUNK, 't0');
  gh.commit('b1', ['t0']);
  gh.refs.set(ROOT, 'b1');
  gh.prs.set(10, { number: 10, state: 'open', base: TRUNK, headSha: 'b1', headRef: ROOT });
  await epochs.bindEpochPr({ missionId, prNumber: 10, repoFullName: REPO, ownerTaskId: null, headRef: ROOT, actor: 'test' }, deps());
}

const mergedInput = (sha: string) => ({
  missionId, prNumber: 10, repoFullName: REPO, headRef: ROOT, mergeCommitSha: sha, mergedHeadSha: 'b1',
  mergedAt: '2026-10-14T12:00:00.000Z', actor: 'test',
});

beforeEach(async () => {
  gh = new FakeGithub();
  work = { unfinishedTasks: 1, openTaskPrs: 0 };
  refreshPrs = new Set();
  superseded = [];
  notes = [];
  const ws = await seedWorkspace();
  workspaceId = ws.workspaceId;
  missionId = await seedMission(ws.teamId, ws.workspaceId);
  await q(sql`UPDATE missions SET working_branch = ${ROOT}, integration_branch_enabled = true WHERE id = ${missionId}::uuid`);
});

describe('AC-20: an epoch merges while work remains (the #3787 sequence)', () => {
  test('exactly one successor, cut from the merge commit, and the mission branch moves to it', async () => {
    await inFlight();
    const m = gh.mergeEpochPr(10);
    const r = await epochs.epochMerged(mergedInput(m), deps());
    expect(r.reason).toBe('merged_rotated');
    const rows = await epochRows();
    expect(rows.map((e) => [e.epoch, e.state, e.branch])).toEqual([[1, 'merged', ROOT], [2, 'open', `${ROOT}-delivery-2`]]);
    expect(rows[1]!.cut_from_sha).toBe(m);
    expect(await workingBranch()).toBe(`${ROOT}-delivery-2`);
    expect(gh.refs.get(`${ROOT}-delivery-2`)).toBe(m);
    // Nothing else on the old branch: settled and retired.
    expect(rows[0]!.retired_at).not.toBeNull();
    expect(gh.refs.has(ROOT)).toBe(false);
  });

  test('the merge ingested twice, and twice concurrently, creates one successor', async () => {
    await inFlight();
    const m = gh.mergeEpochPr(10);
    await Promise.all([epochs.epochMerged(mergedInput(m), deps()), epochs.epochMerged(mergedInput(m), deps())]);
    const again = await epochs.epochMerged(mergedInput(m), deps());
    expect(again.result).toBe('noop');
    const rows = await epochRows();
    expect(rows.map((e) => e.epoch)).toEqual([1, 2]);
    expect(rows.filter((e) => e.state === 'open')).toHaveLength(1);
  });

  test('the statement refuses a second open epoch and a second successor at the index, not by luck', async () => {
    await inFlight();
    const [e1] = await q<{ id: string }>(sql`SELECT id FROM workflow_mission_epochs WHERE mission_id = ${missionId}::uuid`);
    await expect(q(sql`INSERT INTO workflow_mission_epochs (mission_id, epoch, branch, state, origin) VALUES (${missionId}::uuid, 2, 'x', 'open', 'cut')`)).rejects.toThrow();
    await q(sql`INSERT INTO workflow_mission_epochs (mission_id, epoch, branch, state, origin, predecessor_id) VALUES (${missionId}::uuid, 2, 'x', 'merged', 'cut', ${e1!.id}::uuid)`);
    await expect(q(sql`INSERT INTO workflow_mission_epochs (mission_id, epoch, branch, state, origin, predecessor_id) VALUES (${missionId}::uuid, 3, 'y', 'merged', 'cut', ${e1!.id}::uuid)`)).rejects.toThrow();
  });

  test('a stale compare-and-set writes nothing', async () => {
    await inFlight();
    const [e1] = await q<{ id: string; version: number }>(sql`SELECT id, version FROM workflow_mission_epochs WHERE mission_id = ${missionId}::uuid`);
    const stale = epochs.applyEpochOpsSql([{ op: 'update', epochId: e1!.id, expectVersion: Number(e1!.version) + 5, set: { state: 'merged' } }]);
    const [r] = await q<{ applied: boolean }>(stale);
    expect(r!.applied).toBe(false);
    expect((await epochRows())[0]!.state).toBe('open');
  });
});

describe('scenario 2: GitHub deletes the branch on merge and moves its PRs to trunk', () => {
  test('the moved task PR goes to the successor, never stays on trunk, and no worker is handed the dead branch', async () => {
    await inFlight();
    gh.commit('w11', ['b1']);
    gh.prs.set(11, { number: 11, state: 'open', base: ROOT, headSha: 'w11', headRef: 'buildd/task-11' });
    work = { unfinishedTasks: 0, openTaskPrs: 1 };
    const m = gh.mergeEpochPr(10, { deleteBranch: true });
    expect(gh.prs.get(11)!.base).toBe(TRUNK);
    // The retarget webhook (from = the delivery branch) records the move.
    await epochs.applyMissionEpochCommand(missionId, { type: 'PrMovedOff', actor: 'test', at: '2026-10-14T12:00:00.000Z', branch: ROOT, prNumber: 11 }, deps());

    await epochs.epochMerged(mergedInput(m), deps());
    expect(gh.prs.get(11)!.base).toBe(`${ROOT}-delivery-2`);
    expect(await workingBranch()).toBe(`${ROOT}-delivery-2`);
    const [e1] = await epochRows();
    expect(e1!.settlement?.settled?.map((p) => [p.prNumber, p.disposition])).toEqual([[11, 'retarget']]);
    expect(e1!.retired_at).not.toBeNull();
  });
});

describe('review of #4806: only PRs that were on the delivery branch are touched', () => {
  test('a mission PR that was always on trunk, and one in another repo, are never moved or closed', async () => {
    await inFlight();
    gh.commit('w20', ['t0']);
    gh.prs.set(20, { number: 20, state: 'open', base: TRUNK, headSha: 'w20', headRef: 'buildd/always-trunk' });
    work = { unfinishedTasks: 0, openTaskPrs: 1 };
    const m = gh.mergeEpochPr(10, { deleteBranch: true });
    await epochs.epochMerged(mergedInput(m), deps());
    expect(gh.prs.get(20)!).toMatchObject({ state: 'open', base: TRUNK });
    expect(gh.calls.some((c) => c.path.endsWith('/pulls/20') && c.method === 'PATCH')).toBe(false);
  });

  test('the default refresh-PR lookup is scoped to the mission repo', async () => {
    const t = (await q<{ id: string }>(sql`INSERT INTO tasks (workspace_id, mission_id, title, status, context) VALUES (${workspaceId}::uuid, ${missionId}::uuid, 'refresh', 'completed', '{"requireMergeCommit": true}'::jsonb) RETURNING id`))[0]!;
    await q(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status, pr_number, pr_url) VALUES (${workspaceId}::uuid, ${t.id}::uuid, 'w', 'test', 'b5', 'completed', 5, 'https://github.com/acme/app/pull/5'),
      (${workspaceId}::uuid, ${t.id}::uuid, 'w2', 'test', 'b6', 'completed', 6, 'https://github.com/acme/other/pull/6')`);
    await inFlight();
    gh.commit('r5', ['b1', 't0']);
    gh.commit('r6', ['b1', 't0']);
    gh.sameTree.add('r5'); gh.sameTree.add('r6');
    gh.prs.set(5, { number: 5, state: 'open', base: ROOT, headSha: 'r5' });
    gh.prs.set(6, { number: 6, state: 'open', base: ROOT, headSha: 'r6' });
    work = { unfinishedTasks: 0, openTaskPrs: 0 };
    const { refreshPrsOf: _r, ...withDefault } = deps();
    await epochs.epochMerged(mergedInput(gh.mergeEpochPr(10)), withDefault);
    const [e1] = await epochRows();
    // #5 is this repo's refresh; #6 belongs to another repo, so here it is an ordinary task PR.
    expect(e1!.settlement?.settled?.map((p) => [p.prNumber, (p as { kind?: string }).kind])).toEqual([[5, 'refresh'], [6, 'task']]);
  });
});

describe('review of #4806: settlement races', () => {
  test('two settlements at once never close a PR whose work did not reach trunk', async () => {
    await inFlight();
    // A refresh PR with work of its own: its test merge produces a new tree.
    gh.commit('r7', ['b1', 't0']);
    gh.prs.set(7, { number: 7, state: 'open', base: ROOT, headSha: 'r7' });
    refreshPrs = new Set([7]);
    work = { unfinishedTasks: 0, openTaskPrs: 0 };
    const m = gh.mergeEpochPr(10);
    await Promise.all([
      epochs.epochMerged(mergedInput(m), deps()),
      epochs.reconcileMissionEpochs(missionId, deps()),
      epochs.reconcileMissionEpochs(missionId, deps()),
    ]);
    expect(gh.prs.get(7)!.state).toBe('open');
    expect(superseded).toEqual([]);
    expect(gh.refs.has(ROOT)).toBe(true);
    // Every probe used a ref of its own.
    const probes = gh.calls.filter((c) => c.path.endsWith('/git/refs') && c.method === 'POST' && String((c.body as { ref?: string })?.ref).includes('buildd-settle/')).map((c) => (c.body as { ref: string }).ref);
    expect(new Set(probes).size).toBe(probes.length);
  });

  test('the settle lease admits one caller at a time', async () => {
    await inFlight();
    work = { unfinishedTasks: 0, openTaskPrs: 0 };
    await epochs.applyMissionEpochCommand(missionId, { ...mergedInput('m1'), type: 'Merged', at: '2026-10-14T12:00:00.000Z' } as never, deps());
    const [e1] = await q<{ id: string }>(sql`SELECT id FROM workflow_mission_epochs WHERE mission_id = ${missionId}::uuid AND epoch = 1`);
    expect(await q(epochs.settleLeaseSql(e1!.id, 'a', 60_000))).toHaveLength(1);
    expect(await q(epochs.settleLeaseSql(e1!.id, 'b', 60_000))).toHaveLength(0);
    await q(epochs.settleReleaseSql(e1!.id, 'b'));
    expect(await q(epochs.settleLeaseSql(e1!.id, 'c', 60_000))).toHaveLength(0);
    await q(epochs.settleReleaseSql(e1!.id, 'a'));
    expect(await q(epochs.settleLeaseSql(e1!.id, 'c', 60_000))).toHaveLength(1);
  });
});

describe('review of #4806: an adopted re-cut that merges again', () => {
  test('without delete-on-merge, the later delivery settles and retires; the earlier record never deadlocks it', async () => {
    gh.commit('t0', []);
    gh.refs.set(TRUNK, 't0');
    gh.commit('b1', ['t0']);
    gh.refs.set(ROOT, 'b1');
    work = { unfinishedTasks: 1, openTaskPrs: 0 };
    const legacy: Deps = { ...deps(), legacyPrOf: async () => ({ prNumber: 7, repoFullName: REPO, ownerTaskId: null, state: 'merged', mergedAt: '2026-09-01T00:00:00.000Z' }) };
    await epochs.applyMissionEpochCommand(missionId, { type: 'Adopt', actor: 'test', at: '2026-10-14T11:00:00.000Z' }, legacy);
    gh.prs.set(8, { number: 8, state: 'open', base: TRUNK, headSha: 'b1', headRef: ROOT });
    await epochs.bindEpochPr({ missionId, prNumber: 8, repoFullName: REPO, ownerTaskId: null, headRef: ROOT, actor: 'test' }, legacy);
    gh.commit('w9', ['b1']);
    gh.prs.set(9, { number: 9, state: 'open', base: ROOT, headSha: 'w9' });
    const m = gh.mergeEpochPr(8);
    await epochs.epochMerged({ ...mergedInput(m), prNumber: 8 }, legacy);
    const rows = await epochRows();
    expect(rows.map((e) => [e.epoch, e.state])).toEqual([[1, 'merged'], [2, 'merged'], [3, 'open']]);
    expect(gh.prs.get(9)!.base).toBe(`${ROOT}-delivery-3`);
    expect(rows[1]!.retired_at).not.toBeNull();
    expect(rows[0]!.settlement?.held ?? []).toEqual([]);
  });
});

describe('AC-23 / a11abc4b: refresh PRs left on a merged branch', () => {
  test('AC-1: a refresh whose content already shipped closes as superseded by the delivery PR, then the branch retires', async () => {
    await inFlight();
    gh.commit('r5', ['b1', 't0']);
    gh.sameTree.add('r5');
    gh.prs.set(5, { number: 5, state: 'open', base: ROOT, headSha: 'r5', headRef: 'buildd/refresh-5' });
    refreshPrs = new Set([5]);
    work = { unfinishedTasks: 0, openTaskPrs: 0 };
    const m = gh.mergeEpochPr(10);
    await epochs.epochMerged(mergedInput(m), deps());
    expect(gh.prs.get(5)!.state).toBe('closed');
    expect(gh.prs.get(5)!.base).toBe(ROOT);
    expect(superseded).toEqual([{ prNumber: 5, satisfiedBy: 10 }]);
    const [e1] = await epochRows();
    expect(e1!.retired_at).not.toBeNull();
    // The probe ref used for the tree proof is gone.
    expect([...gh.refs.keys()].some((r) => r.startsWith('buildd-settle/'))).toBe(false);
  });

  test('AC-3: a refresh with unique work holds the branch, is never sent to trunk, and asks a person once', async () => {
    await inFlight();
    gh.commit('r6', ['b1', 't0']);
    gh.conflicts.add('r6');
    gh.prs.set(6, { number: 6, state: 'open', base: ROOT, headSha: 'r6', headRef: 'buildd/refresh-6' });
    refreshPrs = new Set([6]);
    work = { unfinishedTasks: 0, openTaskPrs: 0 };
    const m = gh.mergeEpochPr(10);
    await epochs.epochMerged(mergedInput(m), deps());
    await epochs.reconcileMissionEpochs(missionId, deps());
    expect(gh.prs.get(6)!).toMatchObject({ state: 'open', base: ROOT });
    expect(gh.refs.has(ROOT)).toBe(true);
    expect((await epochRows())[0]!.retired_at).toBeNull();
    expect(notes).toHaveLength(1);

    // A person closes it: the next pass settles and retires the branch.
    gh.prs.get(6)!.state = 'closed';
    await epochs.reconcileMissionEpochs(missionId, deps());
    expect((await epochRows())[0]!.retired_at).not.toBeNull();
    expect(gh.refs.has(ROOT)).toBe(false);
  });

  test('AC-4: a GitHub refusal mid-settlement keeps the branch and converges on the next pass', async () => {
    await inFlight();
    gh.commit('w11', ['b1']);
    gh.prs.set(11, { number: 11, state: 'open', base: ROOT, headSha: 'w11', headRef: 'buildd/task-11' });
    work = { unfinishedTasks: 0, openTaskPrs: 1 };
    gh.failNext.push({ method: 'PATCH', path: /\/pulls\/11$/ });
    const m = gh.mergeEpochPr(10);
    await epochs.epochMerged(mergedInput(m), deps());
    expect(gh.prs.get(11)!.base).toBe(ROOT);
    expect(gh.refs.has(ROOT)).toBe(true);
    await epochs.reconcileMissionEpochs(missionId, deps());
    expect(gh.prs.get(11)!.base).toBe(`${ROOT}-delivery-2`);
    expect((await epochRows())[0]!.retired_at).not.toBeNull();
  });
});

describe('retirement reads GitHub fresh', () => {
  test('a PR opened on the merged branch after settlement keeps it, and is settled on the next pass', async () => {
    await inFlight();
    work = { unfinishedTasks: 1, openTaskPrs: 0 };
    const m = gh.mergeEpochPr(10);
    gh.commit('w12', ['b1']);
    let opened = false;
    const racing: Deps = {
      ...deps(),
      // Runs inside the settle step, after its read of open PRs: a PR lands on the branch in between.
      obsoleteRefreshTasksOf: async () => {
        if (!opened) { opened = true; gh.prs.set(12, { number: 12, state: 'open', base: ROOT, headSha: 'w12', headRef: 'buildd/task-12' }); }
        return [];
      },
    };
    // One pass: retirement reads the branch fresh, finds the newcomer, settles it, then retires.
    await epochs.epochMerged(mergedInput(m), racing);
    expect(gh.prs.get(12)!.base).toBe(`${ROOT}-delivery-2`);
    expect((await epochRows())[0]!.retired_at).not.toBeNull();
    expect(gh.refs.has(ROOT)).toBe(false);
  });
});

describe('scenario 4 and later work: nothing left when the epoch merged', () => {
  test('no successor; work filed later opens exactly one, from trunk, and only one', async () => {
    await inFlight();
    work = { unfinishedTasks: 0, openTaskPrs: 0 };
    const m = gh.mergeEpochPr(10);
    expect((await epochs.epochMerged(mergedInput(m), deps())).reason).toBe('merged');
    expect((await epochRows()).map((e) => e.state)).toEqual(['merged']);
    expect(await workingBranch()).toBe(ROOT);

    work = { unfinishedTasks: 1, openTaskPrs: 0 };
    gh.commit('t9', [m]);
    gh.refs.set(TRUNK, 't9');
    const [a, b] = await Promise.all([
      epochs.ensureWritableEpoch({ missionId, reason: 'task_filed', actor: 'test' }, deps()),
      epochs.ensureWritableEpoch({ missionId, reason: 'task_filed', actor: 'test' }, deps()),
    ]);
    expect(a.branch).toBe(`${ROOT}-delivery-2`);
    expect(b.branch).toBe(`${ROOT}-delivery-2`);
    expect([a.rotated, b.rotated].filter(Boolean)).toHaveLength(1);
    const rows = await epochRows();
    expect(rows.map((e) => [e.epoch, e.state, e.cut_from_sha])).toEqual([[1, 'merged', null], [2, 'open', 't9']]);
    expect(gh.refs.get(`${ROOT}-delivery-2`)).toBe('t9');
  });

  test('a completed mission is never given a new delivery', async () => {
    await inFlight();
    work = { unfinishedTasks: 0, openTaskPrs: 0 };
    await epochs.epochMerged(mergedInput(gh.mergeEpochPr(10)), deps());
    await q(sql`UPDATE missions SET status = 'completed' WHERE id = ${missionId}::uuid`);
    const r = await epochs.ensureWritableEpoch({ missionId, reason: 'task_filed', actor: 'test' }, deps());
    expect(r.branch).toBeNull();
    expect((await epochRows())).toHaveLength(1);
  });
});

describe('a lost merge webhook', () => {
  test('the hourly reconcile reads the open delivery PR live and records the merge', async () => {
    await inFlight();
    gh.mergeEpochPr(10);
    const out = await epochs.reconcileMissionEpochs(missionId, deps());
    expect(out.steps[0]).toMatchObject({ step: 'catch_up_merge' });
    expect((await epochRows()).map((e) => e.state)).toEqual(['merged', 'open']);
  });
});

// ── Review round 2 of #4806 ────────────────────────────────────────────────

const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-10-15T12:00:00.000Z');
const legacyMerged = (hoursAgo: number): Deps => ({
  ...deps(),
  now: () => NOW,
  legacyPrOf: async () => ({ prNumber: 7, repoFullName: REPO, ownerTaskId: null, state: 'merged', mergedAt: new Date(NOW.getTime() - hoursAgo * HOUR).toISOString() }),
});

/** A mission predating delivery records whose mission PR #7 merged at m7 (head b1). */
function legacyMergedMission(branch: 'gone' | 'at_merged_head' | 'moved_on') {
  gh.commit('t0', []);
  gh.commit('b1', ['t0']);
  const m7 = gh.commit('m7', ['t0', 'b1']);
  gh.refs.set(TRUNK, m7);
  gh.prs.set(7, { number: 7, state: 'closed', merged: true, base: TRUNK, headSha: 'b1', headRef: ROOT, mergeCommitSha: m7 });
  if (branch === 'at_merged_head') gh.refs.set(ROOT, 'b1');
  if (branch === 'moved_on') { gh.commit('x1', ['b1']); gh.refs.set(ROOT, 'x1'); }
  return m7;
}

describe('review round 2, blocking 1: adoption never treats a moved-on branch as the merge being recorded', () => {
  test('(a)/(b) merged 2 h ago, branch re-created or still taking work: adopted as the live delivery; nothing rotates, nothing is deleted', async () => {
    legacyMergedMission('moved_on');
    work = { unfinishedTasks: 0, openTaskPrs: 0 };
    await epochs.reconcileMissionEpochs(missionId, legacyMerged(2));
    const rows = await epochRows();
    expect(rows.map((e) => [e.epoch, e.state, e.branch])).toEqual([[1, 'merged', ROOT], [2, 'open', ROOT]]);
    expect(gh.refs.get(ROOT)).toBe('x1');
    expect(await workingBranch()).toBe(ROOT);
  });

  test('merged 2 h ago and the branch is gone: that merge is recorded now, so the work left rotates to a successor', async () => {
    const m7 = legacyMergedMission('gone');
    work = { unfinishedTasks: 1, openTaskPrs: 0 };
    await epochs.reconcileMissionEpochs(missionId, legacyMerged(2));
    const rows = await epochRows();
    expect(rows.map((e) => [e.epoch, e.state, e.branch, e.cut_from_sha])).toEqual([[1, 'merged', ROOT, null], [2, 'open', `${ROOT}-delivery-2`, m7]]);
  });

  test('merged 2 h ago and the branch still at the merged head: recorded now, settled, and the branch retired', async () => {
    legacyMergedMission('at_merged_head');
    work = { unfinishedTasks: 0, openTaskPrs: 0 };
    await epochs.reconcileMissionEpochs(missionId, legacyMerged(2));
    const [e1] = await epochRows();
    expect(e1!.retired_at).not.toBeNull();
    expect(gh.refs.has(ROOT)).toBe(false);
  });

  test('the catch-up window is pinned: a merge 3 days old is history, not a merge being recorded', async () => {
    legacyMergedMission('gone');
    work = { unfinishedTasks: 1, openTaskPrs: 0 };
    await epochs.reconcileMissionEpochs(missionId, legacyMerged(72));
    const rows = await epochRows();
    // Adopted as a past delivery with a live re-cut, never rotated from the old merge commit.
    expect(rows.map((e) => [e.epoch, e.state, e.branch])).toEqual([[1, 'merged', ROOT], [2, 'open', ROOT]]);
    expect(epochs.MERGE_CATCH_UP_MS).toBe(48 * HOUR);
  });
});

describe('review round 2, blocking 2: no branch is deleted with work that never reached trunk', () => {
  test('a merged delivery whose branch moved on after settlement is kept, a person is asked once, completion stays held; once trunk has it, it retires', async () => {
    await inFlight();
    work = { unfinishedTasks: 0, openTaskPrs: 0 };
    const m = gh.mergeEpochPr(10);
    let pushed = false;
    const racing: Deps = {
      ...deps(),
      // Inside the settle step: a commit lands on the merged branch.
      obsoleteRefreshTasksOf: async () => {
        if (!pushed) { pushed = true; gh.commit('late', ['b1']); gh.refs.set(ROOT, 'late'); }
        return [];
      },
    };
    await epochs.epochMerged(mergedInput(m), racing);
    expect(gh.refs.get(ROOT)).toBe('late');
    const [e1] = await epochRows();
    expect(e1!.retired_at).toBeNull();
    expect((e1!.settlement as { unshippedHead?: string } | null)?.unshippedHead).toBe('late');
    expect(notes).toEqual(["Delivery 1's branch has commits that never reached trunk"]);
    // Completion reads the kept branch as unshipped work.
    const { epochCompletionHold } = await import('@buildd/workflow-kernel/delivery-epochs');
    const loaded = (await epochs.epochsForMissions([missionId])).get(missionId)!;
    expect(epochCompletionHold({ epochs: loaded }, () => 0)).toMatchObject({ holds: true, reason: 'unsettled' });
    await epochs.reconcileMissionEpochs(missionId, racing);
    expect(notes).toHaveLength(1);
    expect(gh.refs.has(ROOT)).toBe(true);

    // Trunk takes the commit: the next pass retires the branch.
    gh.refs.set(TRUNK, gh.commit('t2', [m, 'late']));
    await epochs.reconcileMissionEpochs(missionId, racing);
    expect((await epochRows())[0]!.retired_at).not.toBeNull();
    expect(gh.refs.has(ROOT)).toBe(false);
  });
});

describe('review round 2: pins', () => {
  test('reconcile honours the settle lease: a branch another caller is settling is not touched', async () => {
    await inFlight();
    gh.commit('r7', ['b1', 't0']);
    gh.sameTree.add('r7');
    gh.prs.set(7, { number: 7, state: 'open', base: ROOT, headSha: 'r7' });
    refreshPrs = new Set([7]);
    work = { unfinishedTasks: 0, openTaskPrs: 0 };
    await epochs.applyMissionEpochCommand(missionId, { ...mergedInput(gh.mergeEpochPr(10)), type: 'Merged', at: '2026-10-14T12:00:00.000Z' } as never, deps());
    const [e1] = await q<{ id: string }>(sql`SELECT id FROM workflow_mission_epochs WHERE mission_id = ${missionId}::uuid AND epoch = 1`);
    await q(epochs.settleLeaseSql(e1!.id, 'someone-else', 60_000));
    const out = await epochs.reconcileMissionEpochs(missionId, deps());
    expect(out.steps.some((s) => s.step === 'settle' && s.outcome === 'in_flight')).toBe(true);
    expect(gh.prs.get(7)!.state).toBe('open');
    expect((await epochRows())[0]!.settled_at).toBeNull();
  });

  test('an existing successor branch that does not start from the cut commit is never taken as ready', async () => {
    await inFlight();
    work = { unfinishedTasks: 1, openTaskPrs: 0 };
    gh.commit('stray', ['t0']);
    gh.refs.set(`${ROOT}-delivery-2`, 'stray');
    await epochs.epochMerged(mergedInput(gh.mergeEpochPr(10)), deps());
    const [, e2] = await q<{ branch_ready_at: string | null }>(sql`SELECT branch_ready_at FROM workflow_mission_epochs WHERE mission_id = ${missionId}::uuid ORDER BY epoch`);
    expect(e2!.branch_ready_at).toBeNull();
    expect(gh.refs.get(`${ROOT}-delivery-2`)).toBe('stray');
    expect((await epochRows())[0]!.settled_at).toBeNull();
  });

  test('a transition whose branch move would match nothing writes nothing', async () => {
    await inFlight();
    const [e1] = await q<{ id: string; version: number }>(sql`SELECT id, version FROM workflow_mission_epochs WHERE mission_id = ${missionId}::uuid`);
    await q(sql`UPDATE missions SET working_branch = 'mission/moved-elsewhere' WHERE id = ${missionId}::uuid`);
    const [r] = await q<{ applied: boolean }>(epochs.applyEpochOpsSql([
      { op: 'update', epochId: e1!.id, expectVersion: Number(e1!.version), set: { state: 'merged', mergeCommitSha: 'm1' } },
      { op: 'insert', epoch: { missionId, epoch: 2, branch: `${ROOT}-delivery-2`, state: 'open', origin: 'cut', cutFromSha: 'm1', predecessorId: e1!.id, scopeVersion: 1,
        repoFullName: null, prNumber: null, ownerTaskId: null, mergedAt: null, mergeCommitSha: null, mergedHeadSha: null, branchReadyAt: null, settledAt: null, retiredAt: null } },
      { op: 'project_branch', missionId, fromBranch: ROOT, branch: `${ROOT}-delivery-2` },
    ]));
    expect(r!.applied).toBe(false);
    expect((await epochRows()).map((e) => [e.epoch, e.state])).toEqual([[1, 'open']]);
    expect(await workingBranch()).toBe('mission/moved-elsewhere');
  });

  test('a lost retarget webhook: a PR still recorded on the delivery branch but live on trunk is moved too', async () => {
    const t = (await q<{ id: string }>(sql`INSERT INTO tasks (workspace_id, mission_id, title, status, task_class) VALUES (${workspaceId}::uuid, ${missionId}::uuid, 'task 11', 'completed', 'work') RETURNING id`))[0]!;
    await q(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status, pr_number, pr_url, pr_base_ref)
      VALUES (${workspaceId}::uuid, ${t.id}::uuid, 'w', 'test', 'buildd/task-11', 'completed', 11, 'https://github.com/acme/app/pull/11', ${ROOT})`);
    await inFlight();
    gh.commit('w11', ['b1']);
    gh.prs.set(11, { number: 11, state: 'open', base: ROOT, headSha: 'w11', headRef: 'buildd/task-11' });
    work = { unfinishedTasks: 0, openTaskPrs: 1 };
    const m = gh.mergeEpochPr(10, { deleteBranch: true });
    // No PrMovedOff: the webhook never arrived. The default recorded-base lookup finds it.
    await epochs.epochMerged(mergedInput(m), deps());
    expect(gh.prs.get(11)!.base).toBe(`${ROOT}-delivery-2`);
  });
});

// ── Review round 3 of #4806 ────────────────────────────────────────────────

describe('review round 3: adoption from any command reads the branch', () => {
  test('a mission with a past merged mission PR and its follow-up merged on the branch: binding a new PR adopts a live delivery, and the bind lands on it', async () => {
    legacyMergedMission('moved_on');
    work = { unfinishedTasks: 0, openTaskPrs: 0 };
    gh.prs.set(30, { number: 30, state: 'open', base: TRUNK, headSha: 'x1', headRef: ROOT });
    const r = await epochs.bindEpochPr({ missionId, prNumber: 30, repoFullName: REPO, ownerTaskId: null, headRef: ROOT, actor: 'test' }, legacyMerged(72));
    expect(r.result).toBe('applied');
    const rows = await epochRows();
    expect(rows.map((e) => [e.epoch, e.state, e.pr_number])).toEqual([[1, 'merged', 7], [2, 'open', 30]]);
  });

  test('an unreadable branch head at adoption keeps the branch live', async () => {
    legacyMergedMission('at_merged_head');
    work = { unfinishedTasks: 0, openTaskPrs: 0 };
    gh.failNext.push({ method: 'GET', path: new RegExp(`/git/ref/heads/${ROOT}$`) });
    await epochs.reconcileMissionEpochs(missionId, legacyMerged(72));
    const rows = await epochRows();
    expect(rows.map((e) => [e.epoch, e.state])).toEqual([[1, 'merged'], [2, 'open']]);
    expect(gh.refs.has(ROOT)).toBe(true);
  });
});

describe('review round 3: the last read before a delete fails closed', () => {
  /** Merge with nothing left; mid-settlement the branch moves to a commit trunk also takes, then arm a failure for the retire read. */
  async function setup(fail: RegExp | null) {
    await inFlight();
    work = { unfinishedTasks: 0, openTaskPrs: 0 };
    const m = gh.mergeEpochPr(10);
    let armed = false;
    const d: Deps = {
      ...deps(),
      obsoleteRefreshTasksOf: async () => {
        if (!armed) {
          armed = true;
          gh.commit('late', ['b1']);
          gh.refs.set(ROOT, 'late');
          gh.refs.set(TRUNK, gh.commit('t2', [m, 'late']));
          if (fail) gh.failNext.push({ method: 'GET', path: fail });
        }
        return [];
      },
    };
    await epochs.epochMerged(mergedInput(m), d);
  }

  test('control: the branch at a head trunk contains is retired', async () => {
    await setup(null);
    expect(gh.refs.has(ROOT)).toBe(false);
  });

  test.each([
    ['the branch head (a non-404 error)', new RegExp(`/git/ref/heads/${ROOT}$`)],
    ['trunk\'s head', new RegExp(`/git/ref/heads/${TRUNK}$`)],
    ['the ancestry compare', /\/compare\/late\.\.\./],
  ])('an unreadable %s keeps the branch', async (_l, fail) => {
    await setup(fail);
    expect(gh.refs.has(ROOT)).toBe(true);
    expect((await epochRows())[0]!.retired_at).toBeNull();
  });
});

describe('review round 3: a PR is closed only at the head that was checked', () => {
  test('a push during the content check leaves the PR open and held', async () => {
    await inFlight();
    gh.commit('r5', ['b1', 't0']);
    gh.sameTree.add('r5');
    gh.prs.set(5, { number: 5, state: 'open', base: ROOT, headSha: 'r5' });
    refreshPrs = new Set([5]);
    work = { unfinishedTasks: 0, openTaskPrs: 0 };
    gh.onMerge = () => { gh.prs.get(5)!.headSha = 'r5b'; gh.onMerge = null; };
    await epochs.epochMerged(mergedInput(gh.mergeEpochPr(10)), deps());
    expect(gh.prs.get(5)!.state).toBe('open');
    expect(superseded).toEqual([]);
    expect((await epochRows())[0]!.retired_at).toBeNull();
  });
});
