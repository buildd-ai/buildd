/**
 * A runner-hosted Scout run's evidence objects against real Postgres. Two
 * things a mocked `db` cannot show: the one-owner CHECK on evidence_objects
 * (a row is a task run's OR a Scout run's, never both, never neither), and
 * the scoping of every read helper (an object belongs to a run by
 * scout_run_id AND to the run's workspace, whatever id the caller offers).
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { evidenceObjects, qualityScoutRuns } from '@buildd/core/db/schema';
import { saveScoutProbes, saveScoutRun } from '@buildd/core/quality-scout/ledger';
import type { ScoutRun } from '@buildd/core/quality-scout/types';
import { findScoutRunEvidenceObject, findTaskEvidenceObject, listScoutRunEvidenceObjects } from '@/lib/evidence-read';
import {
  dbScoutRunEvidenceStore as store,
  loadScoutRunScope,
  ownedScoutRunEvidenceIds,
} from '@/lib/quality-scout-run-evidence-store';
import { parkedRun, probeRecord } from '@/lib/quality-scout-runner-host.fixtures';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

beforeAll(() => {
  assertDbConfigured();
});

async function park(workspaceId: string): Promise<ScoutRun> {
  const run = parkedRun(workspaceId, {}, new Date());
  await saveScoutRun(run);
  await saveScoutProbes(run, [probeRecord('c1')]);
  return run;
}

async function seedWorker(workspaceId: string, taskId: string): Promise<string> {
  const [w] = await q<{ id: string }>(sql`
    INSERT INTO workers (workspace_id, task_id, name, branch, status, runner)
    VALUES (${workspaceId}::uuid, ${taskId}::uuid, 'w', 'b', 'running', 'test') RETURNING id`);
  return w.id;
}

const insertScout = (workspaceId: string, runId: string, over: { bytes?: number } = {}) => store.insertPending({
  workspaceId, scoutRunId: runId, kind: 'command_output', backendId: null,
  objectKey: `evidence/${workspaceId}/scout-runs/${runId}/command_output/${Date.now()}-0.log.gz`,
  bytes: over.bytes ?? 100, expiresAt: new Date(Date.now() + 86_400_000),
});

/** A raw insert: the CHECK is what is under test, not the store's shape. */
const rawInsert = (v: { workspaceId: string; taskId?: string | null; rootTaskId?: string | null; workerId?: string | null; scoutRunId?: string | null }) =>
  q(sql`INSERT INTO evidence_objects (workspace_id, task_id, root_task_id, worker_id, scout_run_id, kind, object_key, bytes)
    VALUES (${v.workspaceId}::uuid, ${v.taskId ?? null}::uuid, ${v.rootTaskId ?? null}::uuid, ${v.workerId ?? null}::uuid,
      ${v.scoutRunId ?? null}::uuid, 'command_output', 'k', 1) RETURNING id`);

/** neon-http wraps the Postgres error; the constraint name is in the message or its cause. */
async function rejectedBy(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    const e = err as { message?: string; constraint?: string; cause?: { message?: string; constraint?: string } };
    return [e.constraint, e.message, e.cause?.constraint, e.cause?.message].filter(Boolean).join(' ');
  }
  return 'ACCEPTED';
}

describe('evidence_objects_one_owner', () => {
  test('a task-run row and a Scout-run row are both accepted', async () => {
    const { workspaceId } = await seedWorkspace();
    const taskId = await seedTask(workspaceId);
    const workerId = await seedWorker(workspaceId, taskId);
    const run = await park(workspaceId);
    expect(await rawInsert({ workspaceId, taskId, rootTaskId: taskId, workerId })).toHaveLength(1);
    expect(await rawInsert({ workspaceId, scoutRunId: run.id })).toHaveLength(1);
  });

  test('neither owner, both owners, or a partial task triple is refused', async () => {
    const { workspaceId } = await seedWorkspace();
    const taskId = await seedTask(workspaceId);
    const workerId = await seedWorker(workspaceId, taskId);
    const run = await park(workspaceId);
    expect(await rejectedBy(rawInsert({ workspaceId }))).toContain('evidence_objects_one_owner');
    expect(await rejectedBy(rawInsert({ workspaceId, taskId, rootTaskId: taskId, workerId, scoutRunId: run.id }))).toContain('evidence_objects_one_owner');
    expect(await rejectedBy(rawInsert({ workspaceId, taskId, rootTaskId: taskId }))).toContain('evidence_objects_one_owner');
    expect(await rejectedBy(rawInsert({ workspaceId, scoutRunId: run.id, workerId }))).toContain('evidence_objects_one_owner');
  });

  test("deleting the Scout run deletes its objects (cascade), never another run's", async () => {
    const { workspaceId } = await seedWorkspace();
    const gone = await park(workspaceId);
    const kept = await park(workspaceId);
    const a = await insertScout(workspaceId, gone.id);
    const b = await insertScout(workspaceId, kept.id);
    await db.delete(qualityScoutRuns).where(eq(qualityScoutRuns.id, gone.id));
    const left = await db.select({ id: evidenceObjects.id }).from(evidenceObjects).where(sql`${evidenceObjects.id} IN (${a}::uuid, ${b}::uuid)`);
    expect(left.map((r) => r.id)).toEqual([b!]);
  });
});

describe('Scout run evidence scoping', () => {
  test("an object is found only through its own run, in its run's workspace", async () => {
    const a = await seedWorkspace();
    const b = await seedWorkspace();
    const mine = await park(a.workspaceId);
    const sibling = await park(a.workspaceId);
    const theirs = await park(b.workspaceId);
    const id = (await insertScout(a.workspaceId, mine.id))!;
    await insertScout(b.workspaceId, theirs.id);

    expect((await findScoutRunEvidenceObject({ id: mine.id, workspaceId: a.workspaceId }, id))?.id).toBe(id);
    // Same workspace, another run: not its object.
    expect(await findScoutRunEvidenceObject({ id: sibling.id, workspaceId: a.workspaceId }, id)).toBeNull();
    // Right run id, offered with another workspace: not found.
    expect(await findScoutRunEvidenceObject({ id: mine.id, workspaceId: b.workspaceId }, id)).toBeNull();

    expect((await listScoutRunEvidenceObjects({ id: mine.id, workspaceId: a.workspaceId })).map((r) => r.id)).toEqual([id]);
    expect(await listScoutRunEvidenceObjects({ id: mine.id, workspaceId: b.workspaceId })).toEqual([]);
    expect(await listScoutRunEvidenceObjects({ id: sibling.id, workspaceId: a.workspaceId })).toEqual([]);
  });

  test("a Scout run's object is never reachable through a task's evidence route", async () => {
    const { workspaceId } = await seedWorkspace();
    const taskId = await seedTask(workspaceId);
    const run = await park(workspaceId);
    const id = (await insertScout(workspaceId, run.id))!;
    expect(await findTaskEvidenceObject({ id: taskId, workspaceId }, id)).toBeNull();
  });

  test('loadScoutRunScope names the run\'s own workspace', async () => {
    const { workspaceId } = await seedWorkspace();
    const run = await park(workspaceId);
    expect(await loadScoutRunScope(run.id)).toEqual({ id: run.id, workspaceId });
    expect(await loadScoutRunScope(crypto.randomUUID())).toBeNull();
  });

  test("ownedScoutRunEvidenceIds keeps only this run's objects whose upload has not failed", async () => {
    const { workspaceId } = await seedWorkspace();
    const run = await park(workspaceId);
    const other = await park(workspaceId);
    const ok = (await insertScout(workspaceId, run.id))!;
    const failed = (await insertScout(workspaceId, run.id))!;
    const foreign = (await insertScout(workspaceId, other.id))!;
    await db.update(evidenceObjects).set({ uploadState: 'failed' }).where(eq(evidenceObjects.id, failed));
    expect([...await ownedScoutRunEvidenceIds(run.id, [ok, failed, foreign, crypto.randomUUID()])]).toEqual([ok]);
  });

  test("usedBytes sums the run's objects, failed uploads excluded", async () => {
    const { workspaceId } = await seedWorkspace();
    const run = await park(workspaceId);
    const other = await park(workspaceId);
    await insertScout(workspaceId, run.id, { bytes: 300 });
    const failed = (await insertScout(workspaceId, run.id, { bytes: 5000 }))!;
    await insertScout(workspaceId, other.id, { bytes: 7000 });
    await db.update(evidenceObjects).set({ uploadState: 'failed' }).where(eq(evidenceObjects.id, failed));
    expect(await store.usedBytes(run.id)).toBe(300);
  });

  test('a Scout row is written pending and never queued for indexing', async () => {
    const { workspaceId } = await seedWorkspace();
    const run = await park(workspaceId);
    const id = (await insertScout(workspaceId, run.id))!;
    const [row] = await db.select().from(evidenceObjects).where(eq(evidenceObjects.id, id));
    expect(row).toMatchObject({ uploadState: 'pending', indexState: 'skipped', taskId: null, workerId: null, scoutRunId: run.id });
  });
});
