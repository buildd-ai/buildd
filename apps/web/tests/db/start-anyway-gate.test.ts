/**
 * Start anyway against real Postgres (spec 36df686b, R-3, R-9, AC-8, AC-12,
 * AC-18): the claim's dependency gate admits a task whose declared prerequisite
 * is unfinished only while a person's unexpired intent names that exact edge.
 * The edge and the upstream task are never touched; once the claim consumes
 * the intent, or the task parks and its prerequisite later completes, the
 * ordinary gate and the ordinary dependency wake decide.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { enqueueReadyDependents } from '@buildd/core/dispatch-dependents';
import { depsGate } from '@/app/api/workers/claim/deps-gate';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

let workspaceId: string;
beforeAll(async () => {
  assertDbConfigured();
  ({ workspaceId } = await seedWorkspace());
});

const inOneHour = () => new Date(Date.now() + 3_600_000).toISOString();
const anHourAgo = () => new Date(Date.now() - 3_600_000).toISOString();

async function seedDependent(deps: string[], context: Record<string, unknown> = {}): Promise<string> {
  const id = await seedTask(workspaceId, { status: 'pending', dependsOn: deps });
  await q(sql`UPDATE tasks SET context = ${JSON.stringify(context)}::jsonb WHERE id = ${id}::uuid`);
  return id;
}
const intent = (edges: string[], expiresAt = inOneHour()) => ({
  forceStart: { id: 'f1', at: new Date().toISOString(), expiresAt, kinds: ['dep_declared'], loopKeys: [], assessDependsOn: edges, reasonsDigest: 'x', blockers: [] },
});
const passes = async (id: string) =>
  (await db.select({ id: tasks.id }).from(tasks).where(sql`${tasks.id} = ${id}::uuid AND ${depsGate()}`)).length === 1;

describe('Start anyway: the claim dependency gate', () => {
  test('AC-18: a claim without a human intent waits on an unfinished declared dependency', async () => {
    const up = await seedTask(workspaceId, { status: 'in_progress' });
    expect(await passes(await seedDependent([up]))).toBe(false);
  });

  test('AC-8: an unexpired intent naming the edge admits the dependent, and edge and upstream are unchanged', async () => {
    const up = await seedTask(workspaceId, { status: 'in_progress' });
    const dep = await seedDependent([up], intent([up]));
    expect(await passes(dep)).toBe(true);
    const [row] = await q<{ depends_on: string[]; up_status: string }>(sql`
      SELECT t.depends_on, u.status AS up_status FROM tasks t JOIN tasks u ON u.id = ${up}::uuid WHERE t.id = ${dep}::uuid`);
    expect(row.depends_on).toEqual([up]);
    expect(row.up_status).toBe('in_progress');
  });

  test('AC-3: an edge added after the confirmation is not admitted by an intent that did not name it', async () => {
    const seen = await seedTask(workspaceId, { status: 'in_progress' });
    const added = await seedTask(workspaceId, { status: 'pending' });
    expect(await passes(await seedDependent([seen, added], intent([seen])))).toBe(false);
  });

  test('R-3: an expired intent admits nothing', async () => {
    const up = await seedTask(workspaceId, { status: 'in_progress' });
    expect(await passes(await seedDependent([up], intent([up], anHourAgo())))).toBe(false);
  });

  test('R-2: a consumed intent (history only) admits no second claim', async () => {
    const up = await seedTask(workspaceId, { status: 'in_progress' });
    const consumed = { forceStartHistory: [{ ...intent([up]).forceStart, claimedAt: new Date().toISOString() }] };
    expect(await passes(await seedDependent([up], consumed))).toBe(false);
  });

  test('R-3: the legacy whole-task bypass flag no longer releases a dependency', async () => {
    const up = await seedTask(workspaceId, { status: 'in_progress' });
    expect(await passes(await seedDependent([up], { bypassDepsGate: true }))).toBe(false);
  });

  test('AC-12: a parked task is woken by the existing dependency wake exactly when its prerequisite completes', async () => {
    const up = await seedTask(workspaceId, { status: 'in_progress' });
    // Parked: back to pending with the edge kept and the intent consumed.
    const parked = await seedDependent([up], { waitExit: { blockerTaskId: up, reason: 'needs the API', at: new Date().toISOString() } });
    expect(await enqueueReadyDependents(up, depsGate())).not.toContain(parked);
    await q(sql`UPDATE tasks SET status = 'completed' WHERE id = ${up}::uuid`);
    const woken = await enqueueReadyDependents(up, depsGate());
    expect(woken.filter(id => id === parked)).toHaveLength(1);
    expect(await passes(parked)).toBe(true);
  });
});
