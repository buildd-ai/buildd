/**
 * The I/O around lib/runner-size.ts: read a workspace's recent cloud run
 * reports, store a fresh derivation once, and find the class a parked worker
 * ran in.
 */
import { db } from '@buildd/core/db';
import { artifacts, workspaces } from '@buildd/core/db/schema';
import { and, desc, eq, like, sql } from 'drizzle-orm';
import { isRunnerSize, type RunnerSize } from '@buildd/shared';
import { RECENT_REPORTS, resolveRunnerSize, type RunnerSizeDecision, type RunnerSizeDerived } from './runner-size';

/** Mirrors RUN_REPORT_KEY_PREFIX in apps/cloud-runner/src/run-report.ts. */
export const RUN_REPORT_KEY_PREFIX = 'cloud-run-report';

/** The newest run reports of a workspace (artifact `metadata.report`), newest first. */
export async function loadRecentRunReports(workspaceId: string): Promise<unknown[]> {
  const rows = await db
    .select({ metadata: artifacts.metadata })
    .from(artifacts)
    .where(and(eq(artifacts.workspaceId, workspaceId), like(artifacts.key, `${RUN_REPORT_KEY_PREFIX}:%`)))
    .orderBy(desc(artifacts.updatedAt))
    .limit(RECENT_REPORTS);
  return rows.map(r => (r.metadata as { report?: unknown } | null)?.report).filter(r => r !== undefined);
}

/**
 * Store the first derivation. Atomic and first-write-wins: the row is only
 * touched while it has no marker (absent, or a JSON null an admin cleared it
 * to), so two dispatches racing write one.
 */
export async function persistRunnerSizeDerived(workspaceId: string, marker: RunnerSizeDerived): Promise<void> {
  await db
    .update(workspaces)
    .set({ gitConfig: sql`jsonb_set(COALESCE(${workspaces.gitConfig}, '{}'::jsonb), '{runnerSizeDerived}', ${JSON.stringify(marker)}::jsonb)` })
    .where(and(eq(workspaces.id, workspaceId), sql`jsonb_typeof(${workspaces.gitConfig}->'runnerSizeDerived') IS DISTINCT FROM 'object'`));
}

/**
 * The workspace's effective size. `persist: true` (the dispatch route) stores
 * a fresh derivation; the settings page only reads.
 */
export async function resolveWorkspaceRunnerSize(
  ws: { id: string; gitConfig: unknown },
  opts: { persist?: boolean } = {},
): Promise<RunnerSizeDecision> {
  const explicit = isRunnerSize((ws.gitConfig as { runnerSize?: unknown } | null)?.runnerSize);
  const decision = resolveRunnerSize({ gitConfig: ws.gitConfig, reports: explicit ? [] : await loadRecentRunReports(ws.id) });
  if (opts.persist && decision.persist) {
    await persistRunnerSizeDerived(ws.id, decision.persist).catch(err =>
      console.error(`[runner-size] storing the derived size for workspace ${ws.id} failed:`, err instanceof Error ? err.message : String(err)));
  }
  return decision;
}

/**
 * The class a worker's last cloud attempt ran in, from its run report
 * (`runnerSize.size`), or null when it has none. A resume must land in the
 * same class: the parked run's state lives in that class's agent.
 */
export async function runnerSizeOfWorker(workspaceId: string, workerId: string): Promise<RunnerSize | null> {
  const row = await db.query.artifacts.findFirst({
    where: and(eq(artifacts.workspaceId, workspaceId), eq(artifacts.key, `${RUN_REPORT_KEY_PREFIX}:${workerId}`)),
    columns: { metadata: true },
  });
  const size = (row?.metadata as { report?: { runnerSize?: { size?: unknown } } } | null)?.report?.runnerSize?.size;
  return isRunnerSize(size) ? size : null;
}
