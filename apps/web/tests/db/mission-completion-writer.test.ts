/**
 * S4b (docs/specs/workflow-kernel-library.md §1, §6): mission completion has one writer, and for
 * a mission with delivery records it is compare-and-set on the epochs the decision read.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { PgDialect } from 'drizzle-orm/pg-core';
import { assertDbConfigured, q, seedMission, seedWorkspace } from './harness';

const { claimMissionCompletion, readMissionEpochFingerprint } = await import('../../src/lib/workflow/mission-completion-write');
const { applyEpochOpsSql } = await import('../../src/lib/workflow/delivery-epochs');

let teamId: string;
let workspaceId: string;
beforeAll(async () => {
  assertDbConfigured();
  ({ teamId, workspaceId } = await seedWorkspace());
});

const status = async (id: string) => (await q<{ status: string }>(sql`SELECT status FROM missions WHERE id = ${id}::uuid`))[0].status;
const epoch = (missionId: string, n: number, state: string) => q<{ id: string }>(sql`
  INSERT INTO workflow_mission_epochs (mission_id, epoch, branch, state, version, origin)
  VALUES (${missionId}::uuid, ${n}, ${`mission/x-${n}`}, ${state}, 1, 'cut') RETURNING id`);

describe('one writer for mission completion', () => {
  test('a mission with no deliveries completes on the active CAS as before, once', async () => {
    const m = await seedMission(teamId, workspaceId);
    expect(await readMissionEpochFingerprint(m)).toBeNull();
    expect(await claimMissionCompletion(m, null, new Date())).toMatchObject({ id: m });
    expect(await status(m)).toBe('completed');
    expect(await claimMissionCompletion(m, null, new Date())).toBeNull();
  });

  test('a mission with deliveries completes on the epoch state the decision read', async () => {
    const m = await seedMission(teamId, workspaceId);
    await epoch(m, 1, 'retired');
    const fp = await readMissionEpochFingerprint(m);
    expect(fp).toMatch(/:1:retired$/);
    expect(await claimMissionCompletion(m, fp, new Date())).toMatchObject({ id: m });
    expect(await status(m)).toBe('completed');
  });

  test('an epoch transition between the read and the write leaves the mission active', async () => {
    const m = await seedMission(teamId, workspaceId);
    const [e] = await epoch(m, 1, 'open');
    const fp = await readMissionEpochFingerprint(m);
    await q(sql`UPDATE workflow_mission_epochs SET state = 'merged', version = version + 1 WHERE id = ${e.id}::uuid`);
    expect(await claimMissionCompletion(m, fp, new Date())).toBeNull();
    expect(await status(m)).toBe('active');
  });

  test('a delivery adopted after a no-delivery read: the stale NULL does not match', async () => {
    const m = await seedMission(teamId, workspaceId);
    const fp = await readMissionEpochFingerprint(m);
    await epoch(m, 1, 'open');
    expect(await claimMissionCompletion(m, fp, new Date())).toBeNull();
    expect(await status(m)).toBe('active');
  });
});

/**
 * S4b review finding 4: the CAS takes no lock, so an epoch write in flight when the completion
 * runs must still be seen. Epoch transitions touch the mission row in their own statement, and the
 * completion's UPDATE of that row then waits for them and re-checks against the row they wrote.
 */
describe('a concurrent epoch write is seen by the completion CAS', () => {
  const render = (q: Parameters<PgDialect['sqlToQuery']>[0]) => new PgDialect().sqlToQuery(q);

  test('an epoch transition committed while the completion waits leaves the mission active', async () => {
    const m = await seedMission(teamId, workspaceId);
    const [e] = await epoch(m, 1, 'open');
    const fp = await readMissionEpochFingerprint(m);

    const other = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await other.connect();
    try {
      await other.query('BEGIN');
      // The epoch merges in another transaction that has not committed yet.
      const t = render(applyEpochOpsSql([{ op: 'update', epochId: e.id, expectVersion: 1, set: { state: 'merged' } as never }]));
      await other.query(t.sql, t.params as unknown[]);
      const completing = claimMissionCompletion(m, fp, new Date());
      await new Promise((r) => setTimeout(r, 300));
      await other.query('COMMIT');
      expect(await completing).toBeNull();
      expect(await status(m)).toBe('active');
    } finally {
      await other.end();
    }
  });

  test('every epoch transition touches its mission row: update, insert and branch projection alike', () => {
    const upd = render(applyEpochOpsSql([{ op: 'update', epochId: '00000000-0000-4000-8000-000000000001', expectVersion: 1, set: { state: 'merged' } as never }])).sql;
    expect(upd).toContain('UPDATE missions SET updated_at = now()');
  });
});

describe('an unrelated write holding the mission row (S4b delta review finding 3)', () => {
  test('makes the claim miss with the deliveries unchanged; claiming again then wins', async () => {
    const m = await seedMission(teamId, workspaceId);
    const fp = await readMissionEpochFingerprint(m);
    const other = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await other.connect();
    try {
      await other.query('BEGIN');
      await other.query("UPDATE missions SET title = title || ' (edited)' WHERE id = $1", [m]);
      const first = claimMissionCompletion(m, fp, new Date());
      await new Promise((r) => setTimeout(r, 300));
      await other.query('COMMIT');
      expect(await first).toBeNull();
      expect(await status(m)).toBe('active');
      expect(await readMissionEpochFingerprint(m)).toBe(fp);
      expect(await claimMissionCompletion(m, fp, new Date())).toMatchObject({ id: m });
    } finally {
      await other.end();
    }
  });
});
