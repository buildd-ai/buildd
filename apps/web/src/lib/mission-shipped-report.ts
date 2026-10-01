/**
 * The "What shipped" store (docs/design/mission-shipped-report.md, "Storage").
 *
 * Called by the winner of the atomic completion claim in
 * `completeMissionIfVerified` and by the human-completion route, never anywhere
 * else. It reads the author task's `structuredOutput.shipped`, adds what the
 * model must not be trusted with (change type, which screenshots exist), and
 * upserts ONE artifact keyed `mission-shipped-<missionId>`. No migration.
 *
 * It never decides anything about completion: callers run it after the claim,
 * and a failure here leaves the mission completed and the page on its fallback.
 */
import { db } from '@buildd/core/db';
import { artifacts, githubRepos, missions, tasks, workers, workspaces } from '@buildd/core/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { isDeliverableTask } from '@buildd/core/mission-helpers';
import { githubApi } from '@/lib/github';
import { resolveMissionRepoWorkspaceId } from '@/lib/mission-repo-workspace';
import { visualShotsQuery } from '@/lib/visual-review-query';
import { toVisualShots } from '@/lib/mission-visual-review';
import {
  buildHeroPool,
  buildShippedRecord,
  changeTypeFromManifests,
  classifyChangedPaths,
  renderShippedMarkdown,
  type ShippedChangeType,
  type ShippedHeroShot,
  type ShippedRecord,
} from '@/lib/mission-shipped';

/**
 * PR-file reads per mission, one page of files each, each cut off after a few
 * seconds. 100 is GitHub's ceiling for `pulls/{n}/files`; a larger value is
 * silently served as 100, so a full page means there may be more.
 */
export const SHIPPED_MAX_PRS = 20;
export const SHIPPED_PR_FILES_PER_PAGE = 100;
export const SHIPPED_PR_FILES_TIMEOUT_MS = 5000;

export const shippedArtifactKey = (missionId: string) => `mission-shipped-${missionId}`;

/** The pool of hero shots the author may nominate from, read when needed (empty on failure). */
export async function loadShippedHeroPool(missionId: string): Promise<ShippedHeroShot[]> {
  try {
    const rows = await visualShotsQuery(db, missionId);
    return buildHeroPool(toVisualShots(rows));
  } catch (e) {
    console.error(`[mission-shipped] hero pool failed for ${missionId}:`, e);
    return [];
  }
}

type TaskRow = {
  id: string;
  title: string | null;
  status: string | null;
  mode: string | null;
  taskClass: string | null;
  kind: string | null;
  category: string | null;
  creationSource: string | null;
  pathManifest: string[] | null;
};

/**
 * Filenames of every merged PR of the mission's deliverable tasks, or null when
 * they cannot all be read (no repo, no PRs recorded, any fetch failing, a PR
 * with more files than one page holds): the
 * caller then falls back to declared manifests rather than guessing from a
 * partial diff.
 */
async function fetchChangedPaths(
  workspace: { githubRepoId: string | null },
  deliverableIds: string[],
): Promise<string[] | null> {
  if (!workspace.githubRepoId || deliverableIds.length === 0) return null;

  const rows = await db.query.workers.findMany({
    where: inArray(workers.taskId, deliverableIds),
    columns: { prNumber: true, mergedAt: true },
  });
  const prNumbers = [...new Set(
    rows.filter(r => r.prNumber != null && r.mergedAt != null).map(r => r.prNumber as number),
  )].slice(0, SHIPPED_MAX_PRS);
  if (prNumbers.length === 0) return null;

  const repo = await db.query.githubRepos.findFirst({
    where: eq(githubRepos.id, workspace.githubRepoId),
    columns: { fullName: true },
    with: { installation: { columns: { installationId: true } } },
  });
  const installationId = repo?.installation?.installationId;
  if (!repo?.fullName || !installationId) return null;

  const pages = await Promise.all(prNumbers.map(n =>
    githubApi(
      installationId,
      `/repos/${repo.fullName}/pulls/${n}/files?per_page=${SHIPPED_PR_FILES_PER_PAGE}`,
      { signal: AbortSignal.timeout(SHIPPED_PR_FILES_TIMEOUT_MS) },
    ).catch(() => null),
  ));
  const paths: string[] = [];
  for (const page of pages) {
    if (!Array.isArray(page)) return null;
    // A full page may be followed by more: that is a partial diff, not the diff.
    if (page.length >= SHIPPED_PR_FILES_PER_PAGE) return null;
    for (const f of page) if (typeof f?.filename === 'string') paths.push(f.filename);
  }
  return paths;
}

async function computeChangeType(
  workspace: { githubRepoId: string | null },
  deliverables: TaskRow[],
): Promise<ShippedChangeType> {
  let paths: string[] | null = null;
  try {
    paths = await fetchChangedPaths(workspace, deliverables.map(t => t.id));
  } catch (e) {
    console.error('[mission-shipped] PR files unavailable, using declared manifests:', e);
  }
  if (paths) return classifyChangedPaths(paths);
  return changeTypeFromManifests(deliverables.filter(t => t.status === 'completed').map(t => t.pathManifest));
}

/**
 * The author's `shipped` output, when the task really is this mission's author
 * and really authored it: a session that ended on runner-captured fallback text
 * has no outcome to speak of.
 */
async function readAuthorShipped(missionId: string, authorTaskId: string): Promise<unknown> {
  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, authorTaskId),
    columns: { missionId: true, result: true },
  });
  if (!task || task.missionId !== missionId) return null;
  const result = task.result as Record<string, unknown> | null;
  if (!result || result.summarySource === 'fallback' || result.reaperAutoCompleted === true) return null;
  return (result.structuredOutput as { shipped?: unknown } | undefined)?.shipped ?? null;
}

/**
 * Build and store the record for a completion this caller just won.
 *
 * `origin: 'manual'` is the human-completion path (no author, no lede, mechanical
 * facts only). Otherwise `authorTaskId` is the task that proposed completion, or
 * null when nothing did (dormancy, the criteria evaluator, a heartbeat).
 * Returns the stored record, or null when there was nowhere to store one.
 */
export async function storeMissionShippedReport(
  missionId: string,
  opts: { authorTaskId: string | null; origin: 'manual' | 'auto'; completedAt: Date },
): Promise<ShippedRecord | null> {
  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, missionId),
    columns: { id: true, title: true, workspaceId: true },
  });
  if (!mission) return null;

  const workspaceId = mission.workspaceId
    ?? (await resolveMissionRepoWorkspaceId({ missionId, missionWorkspaceId: null })).workspaceId;
  if (!workspaceId) return null;

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    columns: { dataClass: true, githubRepoId: true },
  });
  if (!workspace) return null;

  const manual = opts.origin === 'manual';
  const taskRows = (await db.query.tasks.findMany({
    where: eq(tasks.missionId, missionId),
    columns: {
      id: true, title: true, status: true, mode: true, taskClass: true,
      kind: true, category: true, creationSource: true, pathManifest: true,
    },
  })) as TaskRow[];
  const deliverables = taskRows.filter(isDeliverableTask);

  const [authorShipped, changeType, pool] = await Promise.all([
    !manual && opts.authorTaskId
      ? readAuthorShipped(missionId, opts.authorTaskId).catch(() => null)
      : Promise.resolve(null),
    computeChangeType(workspace, deliverables),
    loadShippedHeroPool(missionId),
  ]);

  const { record, ledeRejection } = buildShippedRecord({
    authorShipped,
    authorTaskId: opts.authorTaskId,
    manual,
    changeType,
    pool,
    sensitive: workspace.dataClass === 'sensitive',
    completedAt: opts.completedAt,
  });
  if (ledeRejection) {
    console.warn(`[mission-shipped] lede for ${missionId} not shown (${ledeRejection}); falling back to mechanical facts`);
  }

  const values = {
    type: 'report',
    title: `What shipped: ${mission.title}`,
    content: renderShippedMarkdown(record),
    metadata: { kind: 'mission_shipped_report', shipped: record } as Record<string, unknown>,
    missionId,
  };
  // Keyed (workspaceId, key) unique index: a second completion overwrites the
  // first, and a stale record from before a reopen is replaced, not stacked.
  await db
    .insert(artifacts)
    .values({ workspaceId, key: shippedArtifactKey(missionId), visibility: 'private', ...values })
    .onConflictDoUpdate({
      target: [artifacts.workspaceId, artifacts.key],
      set: { ...values, updatedAt: new Date() },
    });

  return record;
}

/** Fire-and-forget wrapper for callers that must not wait on, or fail from, the report. */
export function storeMissionShippedReportSafely(
  missionId: string,
  opts: Parameters<typeof storeMissionShippedReport>[1],
): Promise<void> {
  return storeMissionShippedReport(missionId, opts).then(
    () => undefined,
    e => console.error(`[mission-shipped] store failed for ${missionId}:`, e),
  );
}
