/**
 * S4b (docs/specs/workflow-kernel-library.md §1, §6): mission completion has one writer, and for
 * a mission with delivery records it is compare-and-set on the epochs the decision read.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedMission, seedWorkspace } from './harness';

const { claimMissionCompletion, readMissionEpochFingerprint } = await import('../../src/lib/workflow/mission-completion-write');

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
