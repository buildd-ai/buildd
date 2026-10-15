/**
 * The mission epoch statements rendered through the real PgDialect
 * (scripts/sql-render-coverage.test.ts): what Postgres receives, not a mock's
 * view of it. Behaviour on a real database is apps/web/tests/db/mission-epochs.test.ts.
 */
import { describe, expect, it } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { applyEpochOpsSql, contentContained, missionEpochsSql, type GithubApi } from './delivery-epochs';

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
