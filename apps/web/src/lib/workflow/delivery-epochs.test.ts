/**
 * The mission epoch statements rendered through the real PgDialect
 * (scripts/sql-render-coverage.test.ts): what Postgres receives, not a mock's
 * view of it. Behaviour on a real database is apps/web/tests/db/mission-epochs.test.ts.
 */
import { describe, expect, it } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { applyEpochOpsSql, contentContained, epochStepsMayComplete, missionEpochsSql, settleFinishedBranch, settleLeaseSql, settleReleaseSql, type EpochDeps, type GithubApi } from './delivery-epochs';
import type { EpochSnapshot, MissionEpochView } from '@buildd/workflow-kernel/delivery-epochs';

const dialect = new PgDialect();
const render = (q: Parameters<PgDialect['sqlToQuery']>[0]) => dialect.sqlToQuery(q);

describe('missionEpochsSql', () => {
  it('reads one mission set as uuids, ordered by mission and epoch', () => {
    const { sql, params } = render(missionEpochsSql(['m1', 'm2']));
    expect(sql).toContain('FROM workflow_mission_epochs');
    expect(sql).toContain('jsonb_array_elements_text($1::jsonb))::uuid');
    expect(sql).toContain('ORDER BY mission_id, epoch');
    expect(params).toEqual([JSON.stringify(['m1', 'm2'])]);
  });
});

describe('applyEpochOpsSql', () => {
  it('a merge that rotates: the CAS update gates the successor insert and the branch projection', () => {
    const { sql, params } = render(applyEpochOpsSql([
      { op: 'update', epochId: 'e1', expectVersion: 3, set: { state: 'merged', mergeCommitSha: 'm1', mergedAt: '2026-10-14T12:00:00.000Z' } },
      { op: 'insert', epoch: {
        missionId: 'mi', epoch: 2, branch: 'mission/x-delivery-2', state: 'open', origin: 'cut', cutFromSha: 'm1', predecessorId: 'e1',
        scopeVersion: 1, repoFullName: null, prNumber: null, ownerTaskId: null, mergedAt: null, mergeCommitSha: null, mergedHeadSha: null,
        branchReadyAt: null, settledAt: null, retiredAt: null,
      } },
      { op: 'project_branch', missionId: 'mi', fromBranch: 'mission/x', branch: 'mission/x-delivery-2' },
    ]));
    expect(sql).toContain('WITH u AS (');
    expect(sql).toMatch(/UPDATE workflow_mission_epochs SET "state" = \$\d+::text, "merge_commit_sha" = \$\d+::text, "merged_at" = \$\d+::timestamptz, version = version \+ 1/);
    expect(sql).toMatch(/WHERE id = \$\d+::uuid AND version = \$\d+/);
    expect(sql).toContain('"i0" AS (');
    expect(sql).toContain('INSERT INTO workflow_mission_epochs (mission_id, epoch, branch, state, origin');
    expect(sql).toContain('"p0" AS (');
    expect(sql).toContain('UPDATE missions SET working_branch = ');
    expect(sql).toContain('branch_refresh_conflict_task_id = NULL');
    expect(sql).toContain('working_branch IS NOT DISTINCT FROM');
    // Every write after the update runs only when the compare-and-set matched.
    expect(sql.match(/WHERE EXISTS \(SELECT 1 FROM u\)|AND EXISTS \(SELECT 1 FROM u\)/g)?.length).toBe(2);
    expect(sql).toContain('SELECT EXISTS (SELECT 1 FROM u) AS applied');
    expect(params).toContain(3);
  });

  it('an adopted epoch 2 names the epoch 1 inserted beside it', () => {
    const base = {
      missionId: 'mi', branch: 'mission/x', origin: 'adopted' as const, cutFromSha: null, predecessorId: null, scopeVersion: 1,
      repoFullName: null, prNumber: null, ownerTaskId: null, mergedAt: null, mergeCommitSha: null, mergedHeadSha: null,
      branchReadyAt: null, settledAt: null, retiredAt: null,
    };
    const { sql } = render(applyEpochOpsSql([
      { op: 'insert', epoch: { ...base, epoch: 1, state: 'merged' } },
      { op: 'insert', epoch: { ...base, epoch: 2, state: 'open', origin: 'adopted_recut', predecessorEpoch: 1 } },
    ]));
    expect(sql).toContain('(SELECT id FROM "i0")');
    expect(sql).toContain('SELECT EXISTS (SELECT 1 FROM i0) AS applied');
  });

  it('refuses a transition that would update two epochs', () => {
    expect(() => applyEpochOpsSql([
      { op: 'update', epochId: 'a', expectVersion: 0, set: { retiredAt: 'x' } },
      { op: 'update', epochId: 'b', expectVersion: 0, set: { retiredAt: 'x' } },
    ])).toThrow('at most one epoch');
  });
});

// Review of #4806, blocking 1: a content check can only say "contained" from
// ancestry or from the tree of a merge it made itself on a ref of its own.
describe('contentContained', () => {
  const repo = { workspaceId: 'w', installationId: 1, repoFullName: 'o/r', trunk: 'dev' };
  function fake(mergeAnswer: () => unknown, opts: { refExists?: boolean } = {}) {
    const refs: string[] = [];
    const api: GithubApi = async (_i, path, init) => {
      const method = init?.method ?? 'GET';
      if (path.includes('/compare/')) return { status: 'diverged' };
      if (path.endsWith('/git/refs') && method === 'POST') {
        if (opts.refExists) throw new Error('GitHub API error: 422 Reference already exists');
        refs.push(JSON.parse(String(init!.body)).ref);
        return {};
      }
      if (path.endsWith('/merges')) return mergeAnswer();
      if (path.includes('/git/commits/')) return { tree: { sha: 'T-into' } };
      return null;
    };
    return { api, refs };
  }

  it('"nothing to merge" (204) is unknown, never contained: ancestry already said no', async () => {
    expect(await contentContained(fake(() => null).api, repo, 'head', 'into', 'buildd-settle/x')).toBeNull();
  });

  it('a merge whose parents are not exactly (into, head) is unknown', async () => {
    const other = () => ({ parents: [{ sha: 'someone-else' }, { sha: 'head' }], commit: { tree: { sha: 'T-into' } } });
    expect(await contentContained(fake(other).api, repo, 'head', 'into', 'buildd-settle/x')).toBeNull();
  });

  it('a ref name already taken is unknown, never reused', async () => {
    const mine = () => ({ parents: [{ sha: 'into' }, { sha: 'head' }], commit: { tree: { sha: 'T-into' } } });
    expect(await contentContained(fake(mine, { refExists: true }).api, repo, 'head', 'into', 'buildd-settle/x')).toBeNull();
  });

  it('its own merge with an unchanged tree is contained; two checks never share a ref', async () => {
    const mine = () => ({ parents: [{ sha: 'into' }, { sha: 'head' }], commit: { tree: { sha: 'T-into' } } });
    const f = fake(mine);
    const [a, b] = await Promise.all([
      contentContained(f.api, repo, 'head', 'into', 'buildd-settle/x'),
      contentContained(f.api, repo, 'head', 'into', 'buildd-settle/x'),
    ]);
    expect([a, b]).toEqual([true, true]);
    expect(new Set(f.refs).size).toBe(2);
  });
});

describe('settle lease SQL', () => {
  it('takes the lease only when free or expired, and releases only its own token', () => {
    const take = render(settleLeaseSql('e1', 'tok', 60_000));
    expect(take.sql).toContain('WHERE id = $');
    expect(take.sql).toContain('(settle_lease_until IS NULL OR settle_lease_until < now())');
    expect(take.sql).toContain("interval '1 millisecond'");
    expect(take.params).toEqual(['tok', 60_000, 'e1']);
    const release = render(settleReleaseSql('e1', 'tok'));
    expect(release.sql).toMatch(/AND settle_lease_token = \$\d+::text/);
  });
});

describe('epochStepsMayComplete (S4b): the epoch path asks the completion writer after a settlement or retirement', () => {
  it('a recorded settlement or retirement may release a held completion', () => {
    expect(epochStepsMayComplete([{ step: 'settle', epoch: 1, outcome: 'settled:applied:ok' }])).toBe(true);
    expect(epochStepsMayComplete([{ step: 'retire', epoch: 1, outcome: 'retired:applied:ok' }])).toBe(true);
  });
  it('nothing recorded, a noop, a held branch or a cut asks nothing', () => {
    expect(epochStepsMayComplete([])).toBe(false);
    expect(epochStepsMayComplete([{ step: 'settle', epoch: 1, outcome: 'in_flight' }])).toBe(false);
    expect(epochStepsMayComplete([{ step: 'retire', epoch: 1, outcome: 'retired:noop:already' }])).toBe(false);
    expect(epochStepsMayComplete([{ step: 'cut_branch', epoch: 2, outcome: 'created:applied:ok' }])).toBe(false);
  });
});

// Task fbc93ebd (kernel audit F6): a refresh PR onto a delivery whose
// integration PR closed unmerged stayed open forever. Settlement now closes
// refresh PRs once the branch is finished, and only then.
describe('settleFinishedBranch', () => {
  const BR = 'mission/x';
  const repo = { workspaceId: 'w', installationId: 1, repoFullName: 'o/r', trunk: 'dev' };
  const epoch: EpochSnapshot = {
    id: 'e1', missionId: 'm1', epoch: 1, branch: BR, state: 'open', version: 2, origin: 'adopted', cutFromSha: null,
    branchReadyAt: null, predecessorId: null, scopeVersion: 1, repoFullName: 'o/r', prNumber: 40, ownerTaskId: 'own',
    mergedAt: null, mergeCommitSha: null, mergedHeadSha: null, settlement: null, settledAt: null, retiredAt: null, movedPrs: [],
  };
  const view = (terminal = false): MissionEpochView => ({ missionId: 'm1', integrationBranch: BR, terminal, scopeVersion: 1, epochs: [epoch], work: { unfinishedTasks: 0, openTaskPrs: 0 } });

  function world(opts: { deliveryPr?: unknown; successors?: number[]; contained?: boolean; supersededBy?: number | null; refreshHead?: string; failRecord?: number } = {}) {
    const calls: string[] = [];
    const comments: Array<{ pr: number; body: string }> = [];
    const closed: number[] = [];
    const api: GithubApi = async (_i, path, init) => {
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${path}`);
      if (method === 'GET' && path === '/repos/o/r/pulls/40') return opts.deliveryPr ?? { state: 'closed', merged: false };
      if (method === 'GET' && path.startsWith('/repos/o/r/pulls?state=open&base=mission%2Fx')) {
        return [...(closed.includes(50) ? [] : [{ number: 50, head: { sha: 'r1' }, base: { ref: BR } }]), { number: 51, head: { sha: 't1' }, base: { ref: BR } }];
      }
      if (method === 'GET' && path.startsWith('/repos/o/r/pulls?state=open&head=')) {
        return (opts.successors ?? []).map((n) => ({ number: n }));
      }
      if (path === '/repos/o/r/git/ref/heads/mission/x') return { object: { sha: 'B' } };
      if (path === '/repos/o/r/git/ref/heads/dev') return { object: { sha: 'T' } };
      if (path.includes('/compare/')) return { status: opts.contained ? 'ahead' : 'diverged' };
      if (path.endsWith('/git/refs') && method === 'POST') return {};
      if (path.endsWith('/merges')) throw new Error('GitHub API error: 409 conflict');
      if (method === 'GET' && path === '/repos/o/r/pulls/50') return { state: 'open', head: { sha: opts.refreshHead ?? 'r1' } };
      if (method === 'POST' && path.endsWith('/comments')) { comments.push({ pr: Number(path.split('/').at(-2)), body: JSON.parse(String(init!.body)).body }); return {}; }
      if (method === 'PATCH' && /\/pulls\/\d+$/.test(path)) { closed.push(Number(path.split('/').at(-1))); return {}; }
      if (method === 'DELETE') return {};
      return null;
    };
    const superseded: Array<{ prNumber: number; by: number }> = [];
    const cancelled: string[] = [];
    const notes: string[] = [];
    let failRecord = opts.failRecord ?? 0;
    const deps: EpochDeps = {
      refreshPrsOf: async () => new Set([50]),
      // The rows: a refresh closed on the branch whose resolution is not recorded yet.
      unsettledClosedRefreshesOf: async () => (closed.includes(50) && !superseded.some((x) => x.prNumber === 50) && !notes.length ? [50] : []),
      supersessionOf: async () => (opts.supersededBy != null ? { prNumber: opts.supersededBy, url: null } : null),
      obsoleteRefreshTasksOf: async () => ['t-unstarted'],
      cancelTask: async (id) => { cancelled.push(id); },
      recordSupersession: async (p) => {
        if (failRecord > 0) { failRecord--; throw new Error('kernel unavailable'); }
        superseded.push({ prNumber: p.prNumber, by: p.satisfiedBy.prNumber });
      },
      noteOnce: async (_m, title, body) => { notes.push(`${title}\n${body}`); },
      newId: () => 'fixed-id-0000',
    };
    return { api, deps, calls, comments, closed, superseded, cancelled, notes };
  }

  it('the #4913 shape: the integration PR closed and its work landed elsewhere, so its refresh PR is closed and points there', async () => {
    const w = world({ supersededBy: 61 });
    const r = await settleFinishedBranch(w.api, repo, view(), epoch, w.deps);
    expect(r.outcome).toBe('finished:superseded:closed=1:cancelled=1:recorded=1');
    expect(w.closed).toEqual([50]);
    expect(w.comments).toHaveLength(1);
    expect(w.comments[0]!.body).toContain('its PR #40 closed without merging and its work landed in #61');
    expect(w.superseded).toEqual([{ prNumber: 50, by: 61 }]);
    expect(w.cancelled).toEqual(['t-unstarted']);
    expect(w.notes).toEqual([]);
    // A task PR on the branch is never touched by this settlement.
    expect(w.calls.some((c) => c.includes('/pulls/51'))).toBe(false);
  });

  it('the #4909 shape: the branch is already in trunk, so the refresh PR is closed and a person is asked where to record it', async () => {
    const w = world({ contained: true });
    const r = await settleFinishedBranch(w.api, repo, view(), epoch, w.deps);
    expect(r.outcome).toBe('finished:contained_in_trunk:closed=1:cancelled=1');
    expect(w.closed).toEqual([50]);
    expect(w.superseded).toEqual([]);
    expect(w.notes).toHaveLength(1);
    expect(w.notes[0]).toContain('#50');
  });

  it('closing the integration PR alone settles nothing: a refresh onto the branch may still be wanted', async () => {
    const w = world({ contained: false });
    const r = await settleFinishedBranch(w.api, repo, view(), epoch, w.deps);
    expect(r.outcome).toBe('not_finished:closed_work_unaccounted');
    expect(w.closed).toEqual([]);
    expect(w.cancelled).toEqual([]);
  });

  it('an open or merged delivery PR stops at one read', async () => {
    for (const pr of [{ state: 'open', merged: false }, { state: 'closed', merged: true }]) {
      const w = world({ deliveryPr: pr, supersededBy: 61 });
      const r = await settleFinishedBranch(w.api, repo, view(), epoch, w.deps);
      expect(r.outcome).toBe('skip:delivery_pr_live');
      expect(w.calls).toEqual(['GET /repos/o/r/pulls/40']);
    }
  });

  it('a successor PR from the branch keeps it live', async () => {
    const w = world({ supersededBy: 61, successors: [70] });
    const r = await settleFinishedBranch(w.api, repo, view(), epoch, w.deps);
    expect(r.outcome).toBe('not_finished:successor_open');
    expect(w.closed).toEqual([]);
  });

  it('a refresh PR pushed to since it was listed is left for the next pass', async () => {
    const w = world({ supersededBy: 61, refreshHead: 'moved' });
    const r = await settleFinishedBranch(w.api, repo, view(), epoch, w.deps);
    expect(r.outcome).toBe('finished:superseded:closed=0:cancelled=1:recorded=0:skipped=1');
    expect(w.closed).toEqual([]);
  });

  // Review of #5021, finding 1: a record that fails after the close is not lost
  // because the PR no longer lists as open.
  it('a supersession that fails after the close is recorded on the next pass, from the rows', async () => {
    const w = world({ supersededBy: 61, failRecord: 1 });
    const first = await settleFinishedBranch(w.api, repo, view(), epoch, w.deps);
    expect(first.outcome).toBe('finished:superseded:closed=1:cancelled=1:recorded=0');
    expect(w.closed).toEqual([50]);
    expect(w.superseded).toEqual([]);
    const second = await settleFinishedBranch(w.api, repo, view(), epoch, w.deps);
    expect(second.outcome).toBe('finished:superseded:closed=0:cancelled=1:resettled=1:recorded=1');
    expect(w.closed).toEqual([50]);
    expect(w.superseded).toEqual([{ prNumber: 50, by: 61 }]);
    // Settled: a third pass finds nothing left.
    expect((await settleFinishedBranch(w.api, repo, view(), epoch, { ...w.deps, obsoleteRefreshTasksOf: async () => [] })).outcome).toBe('skip:nothing_to_settle');
  });

  it('a note that fails after the close is posted on the next pass', async () => {
    const w = world({ contained: true });
    let fail = true;
    const noteOnce: EpochDeps['noteOnce'] = async (m, t, b) => { if (fail) { fail = false; throw new Error('db'); } await w.deps.noteOnce!(m, t, b); };
    await settleFinishedBranch(w.api, repo, view(), epoch, { ...w.deps, noteOnce });
    expect(w.notes).toEqual([]);
    const second = await settleFinishedBranch(w.api, repo, view(), epoch, { ...w.deps, noteOnce });
    expect(second.outcome).toBe('finished:contained_in_trunk:closed=0:cancelled=1:resettled=1');
    expect(w.notes).toHaveLength(1);
    expect(w.notes[0]).toContain('#50');
  });

  it('a closed mission finishes the branch without reading its PR, and asks nobody', async () => {
    const w = world({});
    const r = await settleFinishedBranch(w.api, repo, view(true), epoch, w.deps);
    expect(r.outcome).toBe('finished:mission_terminal:closed=1:cancelled=1');
    expect(w.calls).not.toContain('GET /repos/o/r/pulls/40');
    expect(w.notes).toEqual([]);
  });
});
