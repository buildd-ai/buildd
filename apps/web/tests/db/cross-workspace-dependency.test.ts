/**
 * Cross-workspace task dependencies within one team (Living Spec e28018c2),
 * against real Postgres. The claim gate judges a dependency by id with no
 * workspace filter, so an edge into another workspace of the team gates and
 * releases exactly like one at home (AC-6, AC-10); everything else the claim
 * reads stays per workspace (AC-13, AC-14). A deleted upstream stops holding
 * its dependents elsewhere (AC-11). No claim-route change is expected: these
 * pin that.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { enqueueReadyDependents } from '@buildd/core/dispatch-dependents';
import { depsGate } from '@/app/api/workers/claim/deps-gate';
import { workspaceCapGate } from '@/app/api/workers/claim/workspace-cap-gate';
import { releaseCrossWorkspaceDependentsOf } from '@/lib/task-dependencies';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

let teamId: string;
let w1: string;
let w2: string;

beforeAll(async () => {
  assertDbConfigured();
  ({ teamId, workspaceId: w1 } = await seedWorkspace());
  const [ws] = await q<{ id: string }>(sql`
    INSERT INTO workspaces (name, team_id) VALUES (${`w2-${Date.now().toString(36)}`}, ${teamId}::uuid) RETURNING id`);
  w2 = ws.id;
});

const passesDepsGate = async (id: string) =>
  (await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.id, id), depsGate()))).length === 1;
const passesCap = async (id: string) =>
  (await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.id, id), workspaceCapGate()))).length === 1;
const setStatus = (id: string, status: string) => q(sql`UPDATE tasks SET status = ${status}, updated_at = now() WHERE id = ${id}::uuid`);

describe('the claim gate across workspaces of one team', () => {
  test('AC-6: a cross-workspace dependency holds the dependent until it completes with its PR merged, then wakes it', async () => {
    const a = await seedTask(w1, { status: 'pending' });
    const b = await seedTask(w2, { dependsOn: [a] });
    expect(await passesDepsGate(b)).toBe(false);

    await q(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status, pr_url, pr_number)
      VALUES (${w1}::uuid, ${a}::uuid, 'w', 'test', 'b', 'completed', 'https://example.test/pr/1', 1)`);
    await setStatus(a, 'completed');
    expect(await passesDepsGate(b)).toBe(false);
    expect(await enqueueReadyDependents(a, depsGate())).toEqual([]);

    await q(sql`UPDATE workers SET merged_at = now() WHERE task_id = ${a}::uuid`);
    expect(await passesDepsGate(b)).toBe(true);
    expect(await enqueueReadyDependents(a, depsGate())).toEqual([b]);
  });

  test('AC-10: a cancelled cross-workspace upstream releases the dependent', async () => {
    const a = await seedTask(w1, { status: 'in_progress' });
    const b = await seedTask(w2, { dependsOn: [a] });
    expect(await passesDepsGate(b)).toBe(false);
    await setStatus(a, 'cancelled');
    expect(await passesDepsGate(b)).toBe(true);
  });

  test('AC-11: deleting the upstream drops it from the dependent, records why, and the dependent is claimable', async () => {
    const a = await seedTask(w1, { status: 'pending' });
    const b = await seedTask(w2, { dependsOn: [a] });
    expect(await releaseCrossWorkspaceDependentsOf(a)).toEqual([b]);
    await q(sql`DELETE FROM tasks WHERE id = ${a}::uuid`);
    const [row] = await q<{ depends_on: string[]; context: { removedDependencies?: Array<{ id: string; reason: string }> } }>(
      sql`SELECT depends_on, context FROM tasks WHERE id = ${b}::uuid`);
    expect(row.depends_on).toEqual([]);
    expect(row.context.removedDependencies?.map(r => [r.id, r.reason])).toEqual([[a, 'upstream_deleted']]);
    expect(await passesDepsGate(b)).toBe(true);
  });

  test('AC-13: the workspace cap counts the dependent\'s own workspace only', async () => {
    await q(sql`UPDATE workspaces SET repo = 'acme/app', max_concurrent_tasks = 1 WHERE id = ${w2}::uuid`);
    await q(sql`UPDATE workspaces SET repo = 'acme/docs', max_concurrent_tasks = 1 WHERE id = ${w1}::uuid`);
    try {
      const a = await seedTask(w1, { status: 'cancelled' });
      const b = await seedTask(w2, { dependsOn: [a] });
      const busy = await seedTask(w2, { status: 'in_progress' });
      await q(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status)
        VALUES (${w2}::uuid, ${busy}::uuid, 'w', 'test', 'b', 'running')`);
      const inW1 = await seedTask(w1);

      // B's dependency no longer holds it, but W2 has no free seat.
      expect(await passesDepsGate(b)).toBe(true);
      expect(await passesCap(b)).toBe(false);
      // W1 is untouched by W2's load or by the edge.
      expect(await passesCap(inW1)).toBe(true);

      await setStatus(busy, 'completed');
      expect(await passesCap(b)).toBe(true);
    } finally {
      await q(sql`UPDATE workspaces SET repo = NULL, max_concurrent_tasks = DEFAULT WHERE id IN (${w1}::uuid, ${w2}::uuid)`);
    }
  });

  test('AC-14: a dependent waiting on another workspace holds no lease, so the next task on its files may start', async () => {
    const manifest = ['packages/core/drizzle/x/migration.sql'];
    const a = await seedTask(w1, { status: 'in_progress' });
    const b = await seedTask(w2, { dependsOn: [a], pathManifest: manifest });
    const c = await seedTask(w2, { pathManifest: manifest });
    expect(await passesDepsGate(b)).toBe(false);
    expect(await passesDepsGate(c)).toBe(true);
    expect(await q(sql`SELECT 1 FROM path_claims WHERE task_id = ${b}::uuid`)).toHaveLength(0);
    // B keeps its place: nothing about it changed while it waited.
    const [row] = await q<{ status: string; depends_on: string[] }>(sql`SELECT status, depends_on FROM tasks WHERE id = ${b}::uuid`);
    expect(row).toEqual({ status: 'pending', depends_on: [a] });
  });
});
