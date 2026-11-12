/**
 * The per-workspace knowledge ingest switch (`workspaces.knowledge_ingest`).
 *
 * A workspace with the switch off never has its repo content (code, docs, PR
 * diffs) chunked or embedded. Every path that would enqueue, hand out or run an
 * ingest job asks this module, so the rule lives in one place:
 *
 *  - enqueue: full (`enqueueFullIngestJobDetailed` → `{status:'disabled'}`),
 *    diff / merged-PR / push (`workspacesBoundToRepo` drops disabled rows), the
 *    first-index backfill and diff escalation, workspace create and repo change;
 *  - hand out: `POST /api/knowledge/ingest-jobs` (409 ingest_disabled), the
 *    runner claim (closes the job instead), `/files` (409 ingest_disabled), the
 *    serverless full-ingest fallback cron;
 *  - run: `runDiffIngestJob` closes a queued job instead of running it.
 *
 * A job that exists for a disabled workspace is closed as skipped: status
 * 'error' (it frees the idempotency index, so re-enabling and a redelivery can
 * run again, and it never counts as a successful ingest for freshness), error
 * `ingest_disabled`, stats.skipped `ingest_disabled`. Every skip logs one line
 * under INGEST_SKIP_LOG_KEY.
 *
 * Turning the switch off deletes nothing; `purgeWorkspaceRepoKnowledge` does,
 * and only when asked explicitly (PATCH /api/workspaces/[id] purgeKnowledge).
 *
 * Other indexers (memory, task / artifact mirror, evidence) are not gated here;
 * see docs/specs/knowledge-ingest-pipeline.md for what each embeds.
 */
import { db } from '@buildd/core/db';
import { knowledgeIngestJobs, workspaces } from '@buildd/core/db/schema';
import { and, eq, inArray, sql } from 'drizzle-orm';

/** The stable error / stats / response value for an ingest refused by the switch. */
export const INGEST_DISABLED = 'ingest_disabled' as const;

/** One log key for every skip, so a search finds all of them. */
export const INGEST_SKIP_LOG_KEY = 'knowledge_ingest.skipped_disabled';

/** The corpora repo ingest writes, and so the ones a purge deletes. */
export const REPO_INGEST_CORPORA = ['code', 'docs', 'pr'] as const;

/**
 * Of these workspace ids, the ones with the switch off. A missing row is not
 * reported as disabled (there is nothing to ingest for it either way). DB
 * errors propagate: a caller that cannot read the switch must not ingest.
 */
export async function knowledgeIngestDisabledAmong(workspaceIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(workspaceIds.filter(Boolean))];
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: workspaces.id, knowledgeIngest: workspaces.knowledgeIngest })
    .from(workspaces)
    .where(inArray(workspaces.id, ids));
  return new Set(
    (rows as Array<{ id: string; knowledgeIngest?: boolean | null }>)
      .filter(r => r.knowledgeIngest === false)
      .map(r => r.id),
  );
}

/** Whether repo content of this workspace may be ingested. */
export async function isKnowledgeIngestEnabled(workspaceId: string): Promise<boolean> {
  return !(await knowledgeIngestDisabledAmong([workspaceId])).has(workspaceId);
}

/** Where a skip happened, for the log line. */
export type IngestSkipSite =
  | 'enqueue_full'
  | 'enqueue_diff'
  | 'backfill'
  | 'escalation'
  | 'run_diff'
  | 'manual_enqueue'
  | 'claim'
  | 'files'
  | 'fallback'
  | 'workspace_create'
  | 'repo_change';

export function logIngestSkip(site: IngestSkipSite, ctx: { workspaceId: string; repo?: string; jobId?: string }): void {
  console.info(
    `[${INGEST_SKIP_LOG_KEY}] site=${site} workspace=${ctx.workspaceId}` +
      (ctx.repo ? ` repo=${ctx.repo}` : '') +
      (ctx.jobId ? ` job=${ctx.jobId}` : ''),
  );
}

/**
 * Close a queued or running job of a disabled workspace as skipped. Returns
 * whether this call closed it (false when another executor already moved it).
 */
export async function closeIngestJobAsSkipped(
  job: { id: string; workspaceId: string; repo?: string },
  site: IngestSkipSite,
): Promise<boolean> {
  const closed = await db
    .update(knowledgeIngestJobs)
    .set({
      status: 'error',
      error: INGEST_DISABLED,
      stats: { skipped: INGEST_DISABLED },
      finishedAt: new Date(),
      leaseOwner: null,
      leaseExpiresAt: null,
    })
    .where(and(eq(knowledgeIngestJobs.id, job.id), inArray(knowledgeIngestJobs.status, ['queued', 'running'])))
    .returning({ id: knowledgeIngestJobs.id });
  logIngestSkip(site, { workspaceId: job.workspaceId, repo: job.repo, jobId: job.id });
  return closed.length > 0;
}

/**
 * Delete this workspace's repo-ingested chunks (code, docs, pr). Memory, task,
 * artifact and other corpora are left alone. Returns the rows deleted.
 */
export async function purgeWorkspaceRepoKnowledge(workspaceId: string): Promise<number> {
  const namespaces = REPO_INGEST_CORPORA.map(c => `${workspaceId}:${c}`);
  const res = await db.execute(sql`
    WITH deleted AS (
      DELETE FROM knowledge_chunks
      WHERE namespace IN (${sql.join(namespaces.map(ns => sql`${ns}`), sql`, `)})
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM deleted
  `);
  const rows = (res as unknown as { rows?: Array<{ n?: unknown }> }).rows ?? [];
  return Number(rows[0]?.n ?? 0) || 0;
}

export interface IngestSwitchHealth {
  /** workspaces.knowledge_ingest. */
  enabled: boolean;
  /** Ingest jobs closed as skipped because the switch was off. */
  skippedJobs: number;
}

/** The switch and its skip count, for the knowledge health panel. */
export async function getIngestSwitchHealth(workspaceId: string): Promise<IngestSwitchHealth> {
  const res = await db.execute(sql`
    SELECT
      w.knowledge_ingest AS enabled,
      (SELECT count(*)::int FROM knowledge_ingest_jobs j
        WHERE j.workspace_id = w.id AND j.error = ${INGEST_DISABLED}) AS skipped
    FROM workspaces w
    WHERE w.id = ${workspaceId}
  `);
  const row = ((res as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? [])[0];
  return { enabled: row?.enabled !== false, skippedJobs: Number(row?.skipped ?? 0) || 0 };
}
