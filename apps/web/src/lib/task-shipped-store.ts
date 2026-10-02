/**
 * The task "What shipped" store. Runs once, after a task's completion has been
 * written (`api/workers/[id]` post-completion steps): reads the author's
 * `structuredOutput.shipped`, computes the change type from the PR diff (or the
 * declared manifest when the diff cannot be read), and merges the record into
 * `tasks.result.shipped`. It never decides anything about completion.
 */
import { db } from '@buildd/core/db';
import { githubRepos, tasks, workers, workspaces } from '@buildd/core/db/schema';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { changeTypeFromManifests, classifyChangedPaths, type ShippedChangeType } from '@/lib/mission-shipped';
import { fetchPrFilePaths } from '@/lib/mission-shipped-report';
import { authorShippedOf, buildTaskShippedRecord, type TaskShippedRecord } from '@/lib/task-shipped';

export interface StoreTaskShippedInput {
  taskId: string;
  /** The completion body's `structuredOutput`. */
  structuredOutput: unknown;
  /** `'fallback'` = the runner captured last-message text; never an author. */
  summarySource: unknown;
}

async function computeTaskChangeType(
  workspace: { githubRepoId: string | null } | null,
  prNumber: number | null,
  pathManifest: string[] | null,
): Promise<ShippedChangeType> {
  if (workspace?.githubRepoId && prNumber != null) {
    try {
      const repo = await db.query.githubRepos.findFirst({
        where: eq(githubRepos.id, workspace.githubRepoId),
        columns: { fullName: true },
        with: { installation: { columns: { installationId: true } } },
      });
      const installationId = repo?.installation?.installationId;
      if (repo?.fullName && installationId) {
        const paths = await fetchPrFilePaths(installationId, repo.fullName, [prNumber]);
        if (paths) return classifyChangedPaths(paths);
      }
    } catch (e) {
      console.error('[task-shipped] PR files unavailable, using the declared manifest:', e);
    }
  }
  return changeTypeFromManifests([pathManifest]);
}

/**
 * Build and store the record. Returns null (and writes nothing) when there is
 * nothing to say: no lede written and no PR to read a change type from.
 */
export async function storeTaskShippedRecord(input: StoreTaskShippedInput): Promise<TaskShippedRecord | null> {
  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, input.taskId),
    columns: { id: true, workspaceId: true, pathManifest: true, mode: true },
  });
  if (!task || task.mode === 'planning') return null;

  const prWorker = await db.query.workers.findFirst({
    where: and(eq(workers.taskId, input.taskId), isNotNull(workers.prNumber)),
    orderBy: desc(workers.createdAt),
    columns: { prNumber: true },
  });
  const prNumber = prWorker?.prNumber ?? null;
  const authorShipped = authorShippedOf(input.structuredOutput, input.summarySource);
  if (authorShipped == null && prNumber == null) return null;

  const workspace = task.workspaceId
    ? await db.query.workspaces.findFirst({
        where: eq(workspaces.id, task.workspaceId),
        columns: { dataClass: true, githubRepoId: true },
      })
    : null;

  const changeType = await computeTaskChangeType(
    workspace ?? null,
    prNumber,
    Array.isArray(task.pathManifest) ? (task.pathManifest as string[]) : null,
  );
  const { record, ledeRejection } = buildTaskShippedRecord({
    authorShipped,
    changeType,
    prNumber,
    sensitive: workspace?.dataClass === 'sensitive',
    now: new Date(),
  });
  if (ledeRejection) {
    console.warn(`[task-shipped] lede for ${input.taskId} not shown (${ledeRejection}); the page shows the title`);
  }

  // A key merge, not a rewrite: other post-completion steps write `result` too.
  await db
    .update(tasks)
    .set({ result: sql`COALESCE(${tasks.result}, '{}'::jsonb) || jsonb_build_object('shipped', ${JSON.stringify(record)}::jsonb)` })
    .where(eq(tasks.id, input.taskId));
  return record;
}
