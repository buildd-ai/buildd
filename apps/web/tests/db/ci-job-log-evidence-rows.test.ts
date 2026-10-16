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
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

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
});
