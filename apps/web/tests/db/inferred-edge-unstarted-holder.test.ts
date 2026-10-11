/**
 * The dependency gate against real Postgres: an overlap edge the creation route
 * inferred (pathDeclaration.inferredDependsOn) stops holding while its holder
 * has never started. The edge keeps two tasks off the same migration index or
 * hard surface at once; a holder that is still pending, with no live worker and
 * no open PR, is editing nothing, and the claim route's live gates (path leases,
 * open-PR overlap) serialize whichever of the two claims first. Without this a
 * small task queued behind a long-deferred feature, and behind that feature's
 * own edges, until each one merged. A caller-declared edge onto the same holder
 * still holds, and so does a holder that has started.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { depsGate } from '@/app/api/workers/claim/deps-gate';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

let workspaceId: string;
beforeAll(async () => {
  assertDbConfigured();
  ({ workspaceId } = await seedWorkspace());
});

const MANIFEST = ['packages/core/drizzle/**', 'packages/core/db/schema.ts'];
const HOLDER_MANIFEST = ['packages/core/db/schema.ts'];

async function seedDependent(holder: string, opts: { inferred: boolean }): Promise<string> {
  const id = await seedTask(workspaceId, { status: 'pending', pathManifest: MANIFEST, dependsOn: [holder] });
  const decl = { declared: MANIFEST, source: 'creation', overlapPolicy: 'v2', ...(opts.inferred ? { inferredDependsOn: [holder] } : {}) };
  await q(sql`UPDATE tasks SET path_declaration = ${JSON.stringify(decl)}::jsonb WHERE id = ${id}::uuid`);
  return id;
}

async function seedWorker(taskId: string, opts: { status: string; prUrl?: string; prLifecycleStatus?: string }): Promise<void> {
  const tag = taskId.slice(0, 8);
  await q(sql`
    INSERT INTO workers (task_id, workspace_id, name, runner, branch, status, pr_url, pr_lifecycle_status)
    VALUES (${taskId}::uuid, ${workspaceId}::uuid, ${`w-${tag}`}, 'test', ${`b-${tag}`}, ${opts.status},
      ${opts.prUrl ?? null}, ${opts.prLifecycleStatus ?? null})`);
}

const passesDepsGate = async (id: string) =>
  (await db.select({ id: tasks.id }).from(tasks).where(sql`${tasks.id} = ${id}::uuid AND ${depsGate()}`)).length === 1;

describe('inferred overlap edge onto a holder that never started', () => {
  test('a pending holder with no worker does not hold an inferred edge', async () => {
    const holder = await seedTask(workspaceId, { status: 'pending', pathManifest: HOLDER_MANIFEST });
    expect(await passesDepsGate(await seedDependent(holder, { inferred: true }))).toBe(true);
  });

  test('a pending holder deferred to a future start does not hold an inferred edge', async () => {
    const holder = await seedTask(workspaceId, { status: 'pending', startAt: new Date(Date.now() + 10 * 86_400_000), pathManifest: HOLDER_MANIFEST });
    expect(await passesDepsGate(await seedDependent(holder, { inferred: true }))).toBe(true);
  });

  test('a caller-declared edge onto the same unstarted holder still holds', async () => {
    const holder = await seedTask(workspaceId, { status: 'pending', pathManifest: HOLDER_MANIFEST });
    expect(await passesDepsGate(await seedDependent(holder, { inferred: false }))).toBe(false);
  });

  test('a holder that has started still holds', async () => {
    const running = await seedTask(workspaceId, { status: 'in_progress', pathManifest: HOLDER_MANIFEST });
    await seedWorker(running, { status: 'running' });
    expect(await passesDepsGate(await seedDependent(running, { inferred: true }))).toBe(false);
  });

  test('a pending holder with a live worker still holds', async () => {
    const holder = await seedTask(workspaceId, { status: 'pending', pathManifest: HOLDER_MANIFEST });
    await seedWorker(holder, { status: 'waiting_input' });
    expect(await passesDepsGate(await seedDependent(holder, { inferred: true }))).toBe(false);
  });

  test('a requeued holder whose earlier worker left an open PR still holds; a closed PR does not', async () => {
    const open = await seedTask(workspaceId, { status: 'pending', pathManifest: HOLDER_MANIFEST });
    await seedWorker(open, { status: 'failed', prUrl: 'https://github.com/o/r/pull/1' });
    expect(await passesDepsGate(await seedDependent(open, { inferred: true }))).toBe(false);

    const closed = await seedTask(workspaceId, { status: 'pending', pathManifest: HOLDER_MANIFEST });
    await seedWorker(closed, { status: 'failed', prUrl: 'https://github.com/o/r/pull/2', prLifecycleStatus: 'closed' });
    expect(await passesDepsGate(await seedDependent(closed, { inferred: true }))).toBe(true);
  });
});

describe('a caller-declared edge is never released by an inferred-edge arm', () => {
  test('a declared edge onto a migration holder whose PR targets another base still holds', async () => {
    // The other-base arm releases INFERRED migration edges only. With no
    // inferredDependsOn key at all, its `?` used to be NULL and the gate passed.
    const holder = await seedTask(workspaceId, { status: 'completed', pathManifest: ['packages/core/drizzle/0001_x.sql'] });
    await seedWorker(holder, { status: 'completed', prUrl: 'https://github.com/o/r/pull/3' });
    await q(sql`UPDATE workers SET pr_base_ref = 'mission/other' WHERE task_id = ${holder}::uuid`);
    expect(await passesDepsGate(await seedDependent(holder, { inferred: false }))).toBe(false);
    expect(await passesDepsGate(await seedDependent(holder, { inferred: true }))).toBe(true);
  });
});
