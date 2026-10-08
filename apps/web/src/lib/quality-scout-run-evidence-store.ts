/**
 * The SQL behind a runner-hosted Scout run's evidence objects
 * (quality-scout-run-evidence.ts). Every statement carries its scope in its
 * own WHERE: an object belongs to a run by `scout_run_id`, and the run to a
 * workspace by `workspace_id`. Pinned against real Postgres in
 * apps/web/tests/db/quality-scout-run-evidence.test.ts.
 */
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { evidenceObjects, qualityScoutRuns, workspaces } from '@buildd/core/db/schema';

export interface NewScoutRunEvidence {
  workspaceId: string;
  scoutRunId: string;
  kind: 'command_output' | 'test_report';
  backendId: string | null;
  objectKey: string;
  bytes: number;
  expiresAt: Date;
}

export interface ScoutRunEvidenceStore {
  /** Bytes the run's objects already hold or reserve (failed uploads do not count). */
  usedBytes(runId: string): Promise<number>;
  /** The workspace's data class (`sensitive` writes only to a team-owned backend). */
  workspaceDataClass(workspaceId: string): Promise<string | null>;
  /** Insert one `pending` row; its id. */
  insertPending(row: NewScoutRunEvidence): Promise<string | null>;
}

export const dbScoutRunEvidenceStore: ScoutRunEvidenceStore = {
  async usedBytes(runId) {
    const [row] = await db
      .select({ total: sql<number | string | null>`coalesce(sum(${evidenceObjects.bytes}), 0)` })
      .from(evidenceObjects)
      .where(and(eq(evidenceObjects.scoutRunId, runId), ne(evidenceObjects.uploadState, 'failed')));
    return Number(row?.total ?? 0);
  },

  async workspaceDataClass(workspaceId) {
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId), columns: { dataClass: true } });
    return ws?.dataClass ?? null;
  },

  async insertPending(row) {
    const [inserted] = await db.insert(evidenceObjects).values({
      workspaceId: row.workspaceId,
      scoutRunId: row.scoutRunId,
      kind: row.kind,
      backendId: row.backendId,
      objectKey: row.objectKey,
      bytes: row.bytes,
      uploadState: 'pending',
      // Read with read_evidence, never indexed: there is no task for a hit to link to.
      indexState: 'skipped',
      expiresAt: row.expiresAt,
    }).returning({ id: evidenceObjects.id });
    return inserted?.id ?? null;
  },
};

/**
 * Which of `ids` are this run's objects with an upload that has not failed.
 * The probes route keeps only these as `evidence:<id>` refs.
 */
export async function ownedScoutRunEvidenceIds(runId: string, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db.select({ id: evidenceObjects.id, scoutRunId: evidenceObjects.scoutRunId })
    .from(evidenceObjects)
    .where(and(
      eq(evidenceObjects.scoutRunId, runId),
      inArray(evidenceObjects.id, [...ids]),
      ne(evidenceObjects.uploadState, 'failed'),
    ));
  return new Set(rows.filter((r) => r.scoutRunId === runId).map((r) => r.id.toLowerCase()));
}

/** A Scout run's id and workspace, for a reader whose workspace access is checked next. */
export async function loadScoutRunScope(runId: string): Promise<{ id: string; workspaceId: string } | null> {
  const [row] = await db.select({ id: qualityScoutRuns.id, workspaceId: qualityScoutRuns.workspaceId })
    .from(qualityScoutRuns)
    .where(eq(qualityScoutRuns.id, runId))
    .limit(1);
  return row ?? null;
}
