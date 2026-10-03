/**
 * The visual review's queries, as pure builders (docs/design/visual-qa-human-review.md,
 * "Read"). No `db` import: `visual-review-load.ts` runs them, and the tests
 * render them through drizzle's QueryBuilder (PgDialect), because a mocked db
 * hides every WHERE predicate.
 *
 * `missionVisualShotsWhere` moved here from the mission page's query module
 * (which re-exports it): it is the one scoping rule for audit shots, and
 * every surface reaches it through the loader.
 */
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { artifacts, missionNotes, missions, tasks, visualShotReviews, workers, workspaces } from '@buildd/core/db/schema';
import { ArtifactType, VISUAL_AUDITOR_ROLE_SLUG } from '@buildd/shared';
import { SURFACE_AUDIT_ROUND_CAP_NOTE_TITLE, SURFACE_FIX_TITLE_PREFIX } from '@buildd/core/surface-audit';

// ── Shots ───────────────────────────────────────────────────────────────────

/**
 * Audit screenshots for the Visual review (docs/design/visual-qa-auditor.md,
 * "Where the screenshots show"). A dedicated query, because the mission
 * page's with-tree keeps five artifacts per worker and would cut a 40-shot run
 * to five. Keyed on `artifacts.mission_id`, which upload-url sets for an
 * auditor's uploads.
 */
export const MISSION_VISUAL_SHOT_COLUMNS = {
  id: true,
  workerId: true,
  // The filename by default: the caption's variant when two shots share a
  // route and viewport (`withVariants`).
  title: true,
  type: true,
  metadata: true,
  createdAt: true,
} as const;

/** Newest first: 40 shots a run (20 routes × 2 viewports) × up to three runs. */
export const MISSION_VISUAL_SHOTS_LIMIT = 120;

/** Newest first. With the limit above, ascending would keep the oldest runs and cut the newest. */
export const MISSION_VISUAL_SHOTS_ORDER = (
  a: { createdAt: typeof artifacts.createdAt },
  { desc: d }: { desc: (c: typeof artifacts.createdAt) => SQL },
) => [d(a.createdAt)];

/**
 * Only the auditor's shots are evidence. Any worker on the mission can upload
 * a screenshot with a hand-made `metadata.qa`, so the rows are limited to
 * workers of this mission's `visual-auditor` tasks.
 */
export const missionVisualShotsWhere = (missionId: string): SQL =>
  and(
    eq(artifacts.missionId, missionId),
    eq(artifacts.type, ArtifactType.SCREENSHOT),
    sql`jsonb_typeof(${artifacts.metadata} -> 'qa') = 'object'`,
    // Plain aliased identifiers, not workers/tasks column objects: the
    // relational query maps every column in a raw `where` onto the queried
    // table, which turned `workers.id` into `"artifacts"."id"`.
    sql`${artifacts.workerId} in (select "w"."id" from "workers" "w" inner join "tasks" "t" on "t"."id" = "w"."task_id" where "t"."mission_id" = ${missionId} and "t"."role_slug" = ${VISUAL_AUDITOR_ROLE_SLUG})`,
  )!;

/** The shot row plus the worker's task, so a shot's round never depends on a worker limit. */
export const VISUAL_SHOT_SELECTION = {
  id: artifacts.id,
  workerId: artifacts.workerId,
  title: artifacts.title,
  type: artifacts.type,
  metadata: artifacts.metadata,
  createdAt: artifacts.createdAt,
  taskId: workers.taskId,
};

/** Anything with drizzle's `select`: the db, or a QueryBuilder in a test. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Selectable = { select: (...args: any[]) => any };

export function visualShotsQuery(q: Selectable, missionId: string) {
  return q
    .select(VISUAL_SHOT_SELECTION)
    .from(artifacts)
    .leftJoin(workers, eq(workers.id, artifacts.workerId))
    .where(missionVisualShotsWhere(missionId))
    .orderBy(desc(artifacts.createdAt))
    .limit(MISSION_VISUAL_SHOTS_LIMIT);
}

// ── Tasks ───────────────────────────────────────────────────────────────────

/**
 * The mission's tasks, light: what the model needs to find audits, their
 * dependencies and `[surface fix]` tasks. `context` is projected to the two
 * keys an audit reads, and only for audits; `result` to its `errorType`.
 */
export const VISUAL_REVIEW_TASK_SELECTION = {
  id: tasks.id,
  title: tasks.title,
  status: tasks.status,
  roleSlug: tasks.roleSlug,
  dependsOn: tasks.dependsOn,
  pathManifest: tasks.pathManifest,
  createdAt: tasks.createdAt,
  updatedAt: tasks.updatedAt,
  context: sql<Record<string, unknown> | null>`case when ${tasks.roleSlug} = ${VISUAL_AUDITOR_ROLE_SLUG} then jsonb_build_object('surfaceAuditRound', ${tasks.context} -> 'surfaceAuditRound', 'visualQa', ${tasks.context} -> 'visualQa') else null end`.as('visual_context'),
  errorType: sql<string | null>`${tasks.result} ->> 'errorType'`.as('error_type'),
  // An audit's `why` (cancelled, failed): the summary only, never the whole result.
  resultSummary: sql<string | null>`case when ${tasks.roleSlug} = ${VISUAL_AUDITOR_ROLE_SLUG} then left(${tasks.result} ->> 'summary', 500) else null end`.as('result_summary'),
};

export function visualReviewTasksQuery(q: Selectable, missionId: string) {
  return q.select(VISUAL_REVIEW_TASK_SELECTION).from(tasks).where(eq(tasks.missionId, missionId));
}

/** `[surface fix]` titles as `isSurfaceFixTask` reads them: loose on case and leading space. */
const SURFACE_FIX_LIKE = `${SURFACE_FIX_TITLE_PREFIX.trimEnd().toLowerCase()}%`;

/** Workers of this mission's audit and `[surface fix]` tasks: boot questions, PRs and merges. */
export function visualReviewWorkersQuery(q: Selectable, missionId: string) {
  return q
    .select({
      id: workers.id,
      taskId: workers.taskId,
      status: workers.status,
      startedAt: workers.startedAt,
      waitingFor: workers.waitingFor,
      prUrl: workers.prUrl,
      prNumber: workers.prNumber,
      mergedAt: workers.mergedAt,
      error: workers.error,
    })
    .from(workers)
    .where(sql`${workers.taskId} in (select "t"."id" from "tasks" "t" where "t"."mission_id" = ${missionId} and ("t"."role_slug" = ${VISUAL_AUDITOR_ROLE_SLUG} or lower(ltrim("t"."title")) like ${SURFACE_FIX_LIKE}))`);
}

// ── The capture ref ─────────────────────────────────────────────────────────

/**
 * What `resolveVisualQaCaptureRef` needs: the mission's integration fields and
 * its workspace's git config (docs/design/visual-qa-auditor.md, "Page source").
 */
export function missionCaptureRefQuery(q: Selectable, missionId: string) {
  return q
    .select({
      workingBranch: missions.workingBranch,
      integrationBranchEnabled: missions.integrationBranchEnabled,
      gitConfig: workspaces.gitConfig,
    })
    .from(missions)
    .leftJoin(workspaces, eq(workspaces.id, missions.workspaceId))
    .where(eq(missions.id, missionId))
    .limit(1);
}

// ── Reviews and the round-cap question ──────────────────────────────────────

export function visualShotReviewsQuery(q: Selectable, missionId: string) {
  return q
    .select()
    .from(visualShotReviews)
    .where(eq(visualShotReviews.missionId, missionId))
    .orderBy(asc(visualShotReviews.createdAt));
}

export function roundCapNoteQuery(q: Selectable, missionId: string, title: string) {
  return q
    .select({ id: missionNotes.id })
    .from(missionNotes)
    .where(and(eq(missionNotes.missionId, missionId), eq(missionNotes.title, title), eq(missionNotes.status, 'open')))
    .limit(1);
}

// ── A workspace's missions with screens awaiting a human ────────────────────

/** How many candidate missions GET /api/workspaces/[id]/visual-review loads a model for. */
export const WORKSPACE_AWAITING_MISSIONS_LIMIT = 10;

/**
 * Candidate missions of a workspace for "what waits on me": one with an
 * auditor-scoped (`missionVisualShotsWhere`'s rule) unsure screenshot and no
 * active review, the open round-cap question, or an auditor worker waiting on
 * a question. Newest first. A superset: a later round may have re-shot the
 * cell, so the caller builds each mission's model for the exact answer.
 * Scoped to the caller's teams as well as the workspace.
 */
export function workspaceAwaitingMissionsQuery(q: Selectable, workspaceId: string, teamIds: readonly string[], limit = WORKSPACE_AWAITING_MISSIONS_LIMIT) {
  const auditorWorkers = sql`select "w"."id" from "workers" "w" inner join "tasks" "t" on "t"."id" = "w"."task_id" where "t"."mission_id" = ${missions.id} and "t"."role_slug" = ${VISUAL_AUDITOR_ROLE_SLUG}`;
  return q
    .select({
      id: missions.id,
      title: missions.title,
      status: missions.status,
      workspaceId: missions.workspaceId,
    })
    .from(missions)
    .where(and(
      eq(missions.workspaceId, workspaceId),
      inArray(missions.teamId, [...teamIds]),
      sql`(exists (select 1 from "artifacts" "a" where "a"."mission_id" = ${missions.id} and "a"."type" = 'screenshot' and "a"."metadata" -> 'qa' ->> 'verdict' = 'unsure' and "a"."worker_id" in (${auditorWorkers}) and not exists (select 1 from "visual_shot_reviews" "r" where "r"."artifact_id" = "a"."id" and "r"."superseded_at" is null)) or exists (select 1 from "mission_notes" "n" where "n"."mission_id" = ${missions.id} and "n"."title" = ${SURFACE_AUDIT_ROUND_CAP_NOTE_TITLE} and "n"."status" = 'open') or exists (select 1 from "workers" "w" inner join "tasks" "t" on "t"."id" = "w"."task_id" where "t"."mission_id" = ${missions.id} and "t"."role_slug" = ${VISUAL_AUDITOR_ROLE_SLUG} and "w"."status" = 'waiting_input'))`,
    ))
    .orderBy(desc(missions.updatedAt))
    .limit(limit + 1);
}
