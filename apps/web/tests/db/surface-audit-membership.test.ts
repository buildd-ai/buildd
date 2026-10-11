/**
 * A mission's `[surface audit]` waits on the mission's builder tasks as they
 * are NOW, not on the list frozen into its dependsOn when they were filed. A
 * task unlinked from the mission (manage_missions unlink_task) must stop
 * holding the audit, both for the claim gate and in the stored list.
 * lib/mission-surface-audit-membership.ts is the contract.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { depsGate } from '@/app/api/workers/claim/deps-gate';
import { detachTaskFromMissionSurfaceAudits, missionMemberIds } from '@/lib/mission-surface-audit-membership';
import { assertDbConfigured, q, seedMission, seedTask, seedWorkspace } from './harness';

let teamId: string;
let workspaceId: string;
beforeAll(async () => {
  assertDbConfigured();
  ({ teamId, workspaceId } = await seedWorkspace());
});

const passesDepsGate = async (id: string) =>
  (await q(sql`SELECT tasks.id FROM tasks WHERE tasks.id = ${id}::uuid AND ${depsGate()}`)).length === 1;
const dependsOnOf = async (id: string) =>
  (await q<{ depends_on: string[] }>(sql`SELECT depends_on FROM tasks WHERE id = ${id}::uuid`))[0].depends_on;

describe('surface audit dependencies follow current mission membership', () => {
  test('claim gate: a dependency no longer in the audit\'s mission does not block it', async () => {
    const mission = await seedMission(teamId, workspaceId);
    const other = await seedMission(teamId, workspaceId);
    const done = await seedTask(workspaceId, { missionId: mission, status: 'completed' });
    // Unlinked into a standalone follow-up, and one moved to another mission: both still running.
    const standalone = await seedTask(workspaceId, { missionId: null, status: 'in_progress' });
    const moved = await seedTask(workspaceId, { missionId: other, status: 'pending' });
    const audit = await seedTask(workspaceId, {
      missionId: mission, title: '[surface audit] Example', dependsOn: [done, standalone, moved],
    });
    expect(await passesDepsGate(audit)).toBe(true);
  });

  test('claim gate: a member dependency still running keeps blocking the audit', async () => {
    const mission = await seedMission(teamId, workspaceId);
    const running = await seedTask(workspaceId, { missionId: mission, status: 'in_progress' });
    const standalone = await seedTask(workspaceId, { missionId: null, status: 'in_progress' });
    const audit = await seedTask(workspaceId, {
      missionId: mission, title: '[surface audit] Example', dependsOn: [running, standalone],
    });
    expect(await passesDepsGate(audit)).toBe(false);
  });

  test('claim gate: an ordinary task keeps waiting on a dependency outside its mission', async () => {
    const mission = await seedMission(teamId, workspaceId);
    const foreign = await seedTask(workspaceId, { missionId: null, status: 'in_progress' });
    const plain = await seedTask(workspaceId, { missionId: mission, title: 'build the card', dependsOn: [foreign] });
    expect(await passesDepsGate(plain)).toBe(false);
  });

  test('unlinking a task removes its edge from the mission\'s pending audit, and only that edge', async () => {
    const mission = await seedMission(teamId, workspaceId);
    const keep = await seedTask(workspaceId, { missionId: mission, status: 'in_progress' });
    const gone = await seedTask(workspaceId, { missionId: mission, status: 'in_progress' });
    const audit = await seedTask(workspaceId, {
      missionId: mission, title: '[surface audit] Example', dependsOn: [keep, gone],
    });
    const plain = await seedTask(workspaceId, { missionId: mission, dependsOn: [gone] });
    const started = await seedTask(workspaceId, {
      missionId: mission, title: '[surface audit] round 2: Example', status: 'in_progress', dependsOn: [gone],
    });

    await q(sql`UPDATE tasks SET mission_id = NULL WHERE id = ${gone}::uuid`);
    expect(await detachTaskFromMissionSurfaceAudits(mission, gone)).toEqual([audit]);

    expect(await dependsOnOf(audit)).toEqual([keep]);
    expect(await dependsOnOf(plain)).toEqual([gone]);
    expect(await dependsOnOf(started)).toEqual([gone]);
    // Idempotent.
    expect(await detachTaskFromMissionSurfaceAudits(mission, gone)).toEqual([]);
  });

  test('missionMemberIds keeps only the current members, in order', async () => {
    const mission = await seedMission(teamId, workspaceId);
    const a = await seedTask(workspaceId, { missionId: mission });
    const b = await seedTask(workspaceId, { missionId: null });
    const c = await seedTask(workspaceId, { missionId: mission });
    expect(await missionMemberIds(mission, [c, b, a])).toEqual([c, a]);
    expect(await missionMemberIds(mission, [])).toEqual([]);
  });
});
