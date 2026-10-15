/**
 * The mission epoch statements rendered through the real PgDialect
 * (scripts/sql-render-coverage.test.ts): what Postgres receives, not a mock's
 * view of it. Behaviour on a real database is apps/web/tests/db/mission-epochs.test.ts.
 */
import { describe, expect, it } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { applyEpochOpsSql, missionEpochsSql } from './delivery-epochs';

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
