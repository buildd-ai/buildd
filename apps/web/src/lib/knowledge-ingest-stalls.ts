/**
 * Stalled knowledge-ingest jobs, for get_failure_analytics.
 *
 * A full ingest job that no runner takes never becomes a failed worker, so it
 * was invisible to every failure report: the only place it surfaced was the
 * `stalled` list in the runner claim response, which no person reads. This
 * reports, per scope, the full jobs that are stalled (queued past the stall
 * window, waiting on the serverless fallback) and those the fallback is
 * working through, with the reason a runner gave when it handed one back.
 */
import { and, asc, eq, inArray, or } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { knowledgeIngestJobs } from '@buildd/core/db/schema';
import type { StalledIngestJob, StalledIngestReport } from '@buildd/shared';
import { classifyIngestJobLiveness, queuedAgeMs } from '@/lib/knowledge-ingest-lease';
import { FALLBACK_LEASE_OWNER } from '@/lib/knowledge-full-ingest-fallback';

/** Rows listed in the report; counts always cover every row scanned. */
export const STALLED_INGEST_LIST_LIMIT = 10;
const MAX_SCAN = 200;

export interface StallRowInput {
  id: string;
  workspaceId: string;
  repo: string;
  scope: string;
  status: string;
  attempts: number | null;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  heartbeatAt: Date | null;
  startedAt: Date | null;
  createdAt: Date;
  stats: Record<string, unknown> | null;
}

/** Pure: classify rows into the report. Returns null when nothing is stuck. */
export function summarizeStalledIngest(rows: StallRowInput[], now: Date = new Date()): StalledIngestReport | null {
  const jobs: StalledIngestJob[] = [];
  for (const row of rows) {
    if (row.scope !== 'full') continue;
    const stats = (row.stats ?? {}) as Record<string, any>;
    const checkoutReason: string | undefined =
      typeof stats.checkoutReport?.reason === 'string' ? stats.checkoutReport.reason : undefined;
    const progress = stats.fallback && typeof stats.fallback === 'object' ? stats.fallback : null;

    if (row.status === 'running' && row.leaseOwner === FALLBACK_LEASE_OWNER) {
      jobs.push({
        id: row.id,
        workspaceId: row.workspaceId,
        repo: row.repo,
        state: 'fallback',
        // Waiting since it was first queued, not since the fallback took it.
        ageMs: now.getTime() - row.createdAt.getTime(),
        attempts: row.attempts ?? 0,
        ...(checkoutReason ? { checkoutReason } : {}),
        ...(progress && typeof progress.cursor === 'number'
          ? { progress: { cursor: progress.cursor, total: typeof progress.total === 'number' ? progress.total : null } }
          : {}),
        ...(progress && typeof progress.lastError === 'string' ? { lastError: progress.lastError } : {}),
      });
      continue;
    }
    if (row.status === 'queued' && classifyIngestJobLiveness(row, now) === 'stalled') {
      jobs.push({
        id: row.id,
        workspaceId: row.workspaceId,
        repo: row.repo,
        state: 'stalled',
        ageMs: queuedAgeMs(row, now),
        attempts: row.attempts ?? 0,
        ...(checkoutReason ? { checkoutReason } : {}),
      });
    }
  }
  if (jobs.length === 0) return null;
  jobs.sort((a, b) => b.ageMs - a.ageMs);
  return {
    stalled: jobs.filter(j => j.state === 'stalled').length,
    inFallback: jobs.filter(j => j.state === 'fallback').length,
    oldestAgeMs: jobs[0].ageMs,
    jobs: jobs.slice(0, STALLED_INGEST_LIST_LIMIT),
  };
}

/** Stalled/fallback full ingest jobs in the given workspaces. Null when none, or on a read failure. */
export async function getStalledIngestReport(
  workspaceIds: string[],
  now: Date = new Date(),
): Promise<StalledIngestReport | null> {
  if (workspaceIds.length === 0) return null;
  try {
    const rows = await db
      .select()
      .from(knowledgeIngestJobs)
      .where(
        and(
          inArray(knowledgeIngestJobs.workspaceId, workspaceIds),
          eq(knowledgeIngestJobs.scope, 'full'),
          or(eq(knowledgeIngestJobs.status, 'queued'), eq(knowledgeIngestJobs.status, 'running')),
        ),
      )
      .orderBy(asc(knowledgeIngestJobs.createdAt))
      .limit(MAX_SCAN);
    return summarizeStalledIngest(rows as unknown as StallRowInput[], now);
  } catch (err) {
    console.error('[knowledge-ingest] stalled-job report failed (non-fatal):', err);
    return null;
  }
}
