/**
 * The mission page's gate facts, against real Postgres (spec f7f67f1a P-1,
 * AC-3, AC-4). `loadMissionGateFacts` selects each claim-gate arm separately;
 * a dependent the claim gate would start must read released on the page, and
 * one it holds must not. Each case checks the page against `depsGate()` itself.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { depsGate } from '@/app/api/workers/claim/deps-gate';
import { loadMissionGateFacts } from '@/lib/mission-board-waiting';
import { assertDbConfigured, q, seedMission, seedTask, seedWorkspace } from './harness';

let workspaceId: string;
let teamId: string;
beforeAll(async () => {
  assertDbConfigured();
  ({ teamId, workspaceId } = await seedWorkspace());
});

const FREE = { held: false, local: false, budgetExhausted: false };

async function claimGateOpen(taskId: string): Promise<boolean> {
  const rows = await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.id, taskId), depsGate()));
  return rows.length === 1;
}

async function release(dependent: string, upstream: string, decision: 'start_now' | 'start_stacked' | 'wait', revoked = false) {
  await q(sql`
    INSERT INTO dependency_releases (dependent_task_id, upstream_task_id, upstream_pr_number, decision, source, reason_code, revoked_at)
    VALUES (${dependent}::uuid, ${upstream}::uuid, 1, ${decision}, 'rule', 'test', ${revoked ? new Date().toISOString() : null}::timestamptz)`);
}

describe('loadMissionGateFacts: release arms match the claim gate', () => {
  test('an early release lets the dependent start while its upstream runs; wait and revoked do not', async () => {
    const missionId = await seedMission(teamId, workspaceId);
    const up = await seedTask(workspaceId, { status: 'in_progress', missionId });
    const released = await seedTask(workspaceId, { dependsOn: [up], missionId });
    const waiting = await seedTask(workspaceId, { dependsOn: [up], missionId });
    const revoked = await seedTask(workspaceId, { dependsOn: [up], missionId });
    await release(released, up, 'start_now');
    await release(waiting, up, 'wait');
    await release(revoked, up, 'start_stacked', true);

    const facts = await loadMissionGateFacts(missionId, FREE);
    expect(facts.releasedEdges).toEqual([{ dependentId: released, dependencyId: up, arm: 'early_release' }]);
    expect(facts.waitingKinds[waiting]).toBe('dep_declared');
    expect(facts.waitingKinds[revoked]).toBe('dep_declared');
    expect(facts.waitingKinds[released]).toBeUndefined();

    expect(await claimGateOpen(released)).toBe(true);
    expect(await claimGateOpen(waiting)).toBe(false);
    expect(await claimGateOpen(revoked)).toBe(false);
  });

  test('the bypass flag releases every edge; a held task reads held', async () => {
    const missionId = await seedMission(teamId, workspaceId);
    const up = await seedTask(workspaceId, { status: 'in_progress', missionId });
    const bypassed = await seedTask(workspaceId, { dependsOn: [up], missionId });
    const held = await seedTask(workspaceId, { dependsOn: [up], missionId });
    await q(sql`UPDATE tasks SET context = '{"bypassDepsGate":"true"}'::jsonb WHERE id = ${bypassed}::uuid`);
    await q(sql`UPDATE tasks SET context = '{"heldBy":{"at":"2026-01-01T00:00:00Z"}}'::jsonb WHERE id = ${held}::uuid`);

    const facts = await loadMissionGateFacts(missionId, FREE);
    expect(facts.releasedEdges).toEqual([{ dependentId: bypassed, dependencyId: up, arm: 'bypass' }]);
    expect(facts.waitingKinds[held]).toBe('task_held');
    expect(await claimGateOpen(bypassed)).toBe(true);
  });

  test('a surface audit ignores a dependency outside its mission, as the claim does', async () => {
    const missionId = await seedMission(teamId, workspaceId);
    const elsewhere = await seedTask(workspaceId, { status: 'in_progress' });
    const audit = await seedTask(workspaceId, { title: '[surface audit] mission screens', dependsOn: [elsewhere], missionId });

    const facts = await loadMissionGateFacts(missionId, FREE);
    expect(facts.releasedEdges).toEqual([{ dependentId: audit, dependencyId: elsewhere, arm: 'surface_audit_scope' }]);
    expect(await claimGateOpen(audit)).toBe(true);
  });

  test('a completed or cancelled dependency is the status arm: no release row, no waiting cause from it', async () => {
    const missionId = await seedMission(teamId, workspaceId);
    const done = await seedTask(workspaceId, { status: 'cancelled', missionId });
    const ready = await seedTask(workspaceId, { dependsOn: [done], missionId });

    const facts = await loadMissionGateFacts(missionId, FREE);
    expect(facts.releasedEdges).toEqual([]);
    expect(facts.waitingKinds[ready]).toBeUndefined();
    expect(await claimGateOpen(ready)).toBe(true);
  });

  test('schedule and mission holds: a future start, a local mission', async () => {
    const missionId = await seedMission(teamId, workspaceId);
    const later = await seedTask(workspaceId, { startAt: new Date(Date.now() + 3_600_000), missionId });
    const ready = await seedTask(workspaceId, { missionId });

    const facts = await loadMissionGateFacts(missionId, { ...FREE, local: true });
    expect(facts.waitingKinds[later]).toBe('start_deferred');
    expect(facts.waitingKinds[ready]).toBe('mission_local');
  });

  test('another mission\'s tasks are not read', async () => {
    const missionId = await seedMission(teamId, workspaceId);
    const other = await seedMission(teamId, workspaceId);
    const up = await seedTask(workspaceId, { status: 'in_progress', missionId: other });
    const dep = await seedTask(workspaceId, { dependsOn: [up], missionId: other });
    await release(dep, up, 'start_now');

    const facts = await loadMissionGateFacts(missionId, FREE);
    expect(facts).toEqual({ releasedEdges: [], waitingKinds: {} });
  });
});
