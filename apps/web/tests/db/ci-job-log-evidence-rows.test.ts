/**
 * The rows a CI job log capture records, against real Postgres. A retried
 * capture writes the same object (its name is the fix task's), so it must
 * leave one evidence_objects row per (object, task), not a second one, and
 * must not queue an object the indexer already has. A mocked `db` cannot show
 * either: both are the WHERE clause.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { recordCiJobLogEvidenceRows, type EvidenceObjectInsert } from '@/lib/ci-job-log-evidence';
import { db } from '@buildd/core/db';
import { allMigrationSql, assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

beforeAll(() => {
  assertDbConfigured();
});

async function seedCapture(): Promise<{ row: (o: Partial<EvidenceObjectInsert>) => EvidenceObjectInsert[]; workspaceId: string; retry: string; root: string }> {
  const { workspaceId } = await seedWorkspace();
  const root = await seedTask(workspaceId);
  const retry = await seedTask(workspaceId);
  const [w] = await q<{ id: string }>(sql`
    INSERT INTO workers (workspace_id, task_id, name, branch, status, runner)
    VALUES (${workspaceId}::uuid, ${retry}::uuid, 'w', 'b', 'running', 'test') RETURNING id`);
  const objectKey = `evidence/${workspaceId}/${root}/${retry}/${w.id}/ci_job_log/${retry}-777.log.gz`;
  // What one capture records: the retry task's row (the one the indexer reads) and the root's.
  const row = (o: Partial<EvidenceObjectInsert>): EvidenceObjectInsert[] => [retry, root].map((taskId) => ({
    workspaceId, taskId, rootTaskId: root, workerId: w.id, prNumber: 12, kind: 'ci_job_log', backendId: null,
    objectKey, bytes: 10, sha256: 'a', uploadState: 'stored', expiresAt: new Date(Date.now() + 86_400_000), ...o,
    indexState: taskId === retry ? (o.indexState ?? 'queued') : 'skipped',
  }));
  return { row, workspaceId, retry, root };
}

const rowsOf = (workspaceId: string) => q<{ task_id: string; upload_state: string; index_state: string; bytes: string }>(sql`
  SELECT task_id, upload_state, index_state, bytes FROM evidence_objects WHERE workspace_id = ${workspaceId}::uuid ORDER BY task_id`);

describe('recordCiJobLogEvidenceRows', () => {
  test('a retried capture of the same object leaves one row per task, not a second one, and queues it once', async () => {
    const c = await seedCapture();
    await recordCiJobLogEvidenceRows(c.row({}));
    await recordCiJobLogEvidenceRows(c.row({ bytes: 11 }));
    const rows = await rowsOf(c.workspaceId);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.task_id === c.retry)).toMatchObject({ upload_state: 'stored', index_state: 'queued', bytes: '11' });
    expect(rows.find((r) => r.task_id === c.root)).toMatchObject({ upload_state: 'stored', index_state: 'skipped' });
  });

  test('a capture that failed and was retried ends stored and queued, in the same row', async () => {
    const c = await seedCapture();
    await recordCiJobLogEvidenceRows(c.row({ bytes: 0, sha256: null, uploadState: 'failed', indexState: 'skipped' }));
    await recordCiJobLogEvidenceRows(c.row({}));
    const rows = await rowsOf(c.workspaceId);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.task_id === c.retry)).toMatchObject({ upload_state: 'stored', index_state: 'queued', bytes: '10' });
  });

  test('an object the indexer already has is not queued again, and a failed retry never undoes a stored one', async () => {
    const c = await seedCapture();
    await recordCiJobLogEvidenceRows(c.row({}));
    await q(sql`UPDATE evidence_objects SET index_state = 'indexed' WHERE workspace_id = ${c.workspaceId}::uuid AND task_id = ${c.retry}::uuid`);
    await recordCiJobLogEvidenceRows(c.row({}));
    await recordCiJobLogEvidenceRows(c.row({ bytes: 0, sha256: null, uploadState: 'failed', indexState: 'skipped' }));
    const rows = await rowsOf(c.workspaceId);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.task_id === c.retry)).toMatchObject({ upload_state: 'stored', index_state: 'indexed', bytes: '10' });
  });

  test('a different object is its own row', async () => {
    const c = await seedCapture();
    await recordCiJobLogEvidenceRows(c.row({}));
    await recordCiJobLogEvidenceRows(c.row({}).map((r) => ({ ...r, objectKey: `${r.objectKey}.2` })));
    expect(await rowsOf(c.workspaceId)).toHaveLength(4);
  });

  test('two captures of one object racing each other still leave one row per task', async () => {
    // The kernel's effect lease is what normally keeps captures apart; a process
    // suspended past its lease is not kept apart by it. Run them truly at once,
    // several times over: the database, not the read before the write, must hold.
    for (let i = 0; i < 10; i++) {
      const c = await seedCapture();
      await Promise.all([recordCiJobLogEvidenceRows(c.row({})), recordCiJobLogEvidenceRows(c.row({ bytes: 11 }))]);
      const rows = await rowsOf(c.workspaceId);
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.task_id === c.retry)).toMatchObject({ upload_state: 'stored', index_state: 'queued' });
    }
  });

  test('a failed capture racing a stored one never undoes the stored row', async () => {
    for (let i = 0; i < 10; i++) {
      const c = await seedCapture();
      await recordCiJobLogEvidenceRows(c.row({}));
      await Promise.all([
        recordCiJobLogEvidenceRows(c.row({ bytes: 0, sha256: null, uploadState: 'failed', indexState: 'skipped' })),
        recordCiJobLogEvidenceRows(c.row({ bytes: 0, sha256: null, uploadState: 'failed', indexState: 'skipped' })),
      ]);
      const rows = await rowsOf(c.workspaceId);
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.task_id === c.retry)).toMatchObject({ upload_state: 'stored', index_state: 'queued', bytes: '10' });
    }
  });
});

describe('the migration that makes it one row per (object, task)', () => {
  // Read the shipped SQL rather than mirroring it.
  const migration = (slug: string) => {
    const m = allMigrationSql().find((x) => x.name.endsWith(`_${slug}`));
    if (!m) throw new Error(`no migration ${slug}`);
    return m.sql;
  };
  const run = async (slug: string) => {
    for (const stmt of migration(slug).split('--> statement-breakpoint')) {
      if (stmt.trim()) await db.execute(sql.raw(stmt));
    }
  };

  test('keeps the furthest-progressed row of each duplicate set, then builds the unique index, in one migration', async () => {
    await q(sql`DROP INDEX IF EXISTS evidence_objects_object_task_unique`);
    try {
      const c = await seedCapture();
      const [retryRow, rootRow] = c.row({});
      const ins = (r: EvidenceObjectInsert, upload: string, index: string, bytes: number, age: string) => q(sql`
        INSERT INTO evidence_objects (workspace_id, task_id, root_task_id, worker_id, kind, object_key, bytes, upload_state, index_state, created_at, updated_at)
        VALUES (${r.workspaceId}::uuid, ${r.taskId}::uuid, ${r.rootTaskId}::uuid, ${r.workerId}::uuid, 'ci_job_log', ${r.objectKey},
                ${bytes}, ${upload}, ${index}, now() - ${age}::interval, now() - ${age}::interval)`);
      // Retry task: an indexed row beats a newer queued one and a newer failed one.
      await ins(retryRow, 'stored', 'indexed', 1, '3 hours');
      await ins(retryRow, 'stored', 'queued', 2, '2 hours');
      await ins(retryRow, 'failed', 'skipped', 3, '1 hour');
      // Root task: stored beats a newer failed one; between two stored, the newer wins.
      await ins(rootRow, 'stored', 'skipped', 4, '3 hours');
      await ins(rootRow, 'stored', 'skipped', 5, '2 hours');
      await ins(rootRow, 'failed', 'skipped', 6, '1 hour');
      // A different object of the same task is not a duplicate.
      await ins({ ...rootRow, objectKey: `${rootRow.objectKey}.2` }, 'failed', 'skipped', 7, '1 hour');

      await run('evidence_objects_one_row_per_object_task');

      const rows = await q<{ task_id: string; object_key: string; bytes: string }>(sql`
        SELECT task_id, object_key, bytes FROM evidence_objects WHERE workspace_id = ${c.workspaceId}::uuid ORDER BY bytes`);
      expect(rows.map((r) => r.bytes)).toEqual(['1', '5', '7']);

      // Running the dedupe again deletes nothing (only the dedupe: the index already exists).
      await db.execute(sql.raw(migration('evidence_objects_one_row_per_object_task').split('--> statement-breakpoint')[0]!));
      expect(await q(sql`SELECT 1 FROM evidence_objects WHERE workspace_id = ${c.workspaceId}::uuid`)).toHaveLength(3);
      // And the index now refuses a second row for the same object and task.
      await expect(ins(retryRow, 'stored', 'queued', 8, '0 hours')).rejects.toThrow();
    } finally {
      await q(sql`CREATE UNIQUE INDEX IF NOT EXISTS evidence_objects_object_task_unique ON evidence_objects (object_key, task_id)`);
    }
  });
});
