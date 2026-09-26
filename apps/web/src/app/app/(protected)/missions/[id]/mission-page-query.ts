/**
 * The mission detail page's query shape (docs/design/mission-feed-mobile-continuity.md,
 * slice S7, AC-18). Lifted out of `page.tsx` so the shape is one object the
 * page and its read-through re-query both use, and a test can pin it without
 * a database.
 *
 * The page is `force-dynamic` and re-renders on every structural realtime
 * event, so everything it selects is paid for on every one of those renders.
 * Three columns were the bulk of that payload and nothing on the first screen
 * reads them:
 *
 * - artifact `content` — full markdown/JSON bodies. The Records sheet fetches
 *   them on open (`/api/missions/[id]/artifacts/content`).
 * - task `result` — agent output. The page reads four small fields from it
 *   (the completion summary and the heartbeat status), so those arrive as a
 *   projected digest instead ({@link RESULT_DIGEST_SQL}).
 * - task `context` — the dispatch context, including failure logs and
 *   prompts. The attempt strip reads a handful of counters and markers from
 *   it, so those arrive the same way ({@link CONTEXT_DIGEST_SQL}).
 *
 * Pure: no `db` import. The page runs the queries.
 */
import { sql, eq, and, type SQL } from 'drizzle-orm';
import { artifacts, tasks } from '@buildd/core/db/schema';
import { VISUAL_AUDITOR_ROLE_SLUG } from '@/lib/mission-visual-review';
import { ArtifactType } from '@buildd/shared';

// ── The relational query ─────────────────────────────────────────────────────

export const MISSION_ARTIFACT_COLUMNS = {
  id: true,
  type: true,
  title: true,
  key: true,
  shareToken: true,
  visibility: true,
  metadata: true,
  createdAt: true,
} as const;

export const MISSION_WORKER_COLUMNS = {
  id: true,
  status: true,
  waitingFor: true,
  branch: true,
  prUrl: true,
  prNumber: true,
  prLifecycleStatus: true,
  mergedAt: true,
  supersededByPrNumber: true,
  supersededByPrUrl: true,
  supersededReason: true,
  costUsd: true,
  turns: true,
  completedAt: true,
  startedAt: true,
  // A claimed worker's lane starts at the claim until the runner stamps startedAt.
  createdAt: true,
  updatedAt: true,
  exitCause: true,
  currentAction: true,
  commitCount: true,
  filesChanged: true,
  // Board and Lanes (MissionBoard / MissionLanes): the runner a worker ran on
  // (lanes, fleet slots), its milestones (a tile's notches), and its diff size
  // (landed rows, completion record).
  runner: true,
  // With runner, joins the runner's heartbeat for its hostname (runner-display).
  accountId: true,
  localUiUrl: true,
  milestones: true,
  linesAdded: true,
  linesRemoved: true,
} as const;

export const MISSION_TASK_COLUMNS = {
  id: true,
  title: true,
  status: true,
  priority: true,
  createdAt: true,
  updatedAt: true,
  mode: true,
  roleSlug: true,
  creationSource: true,
  dependsOn: true,
  parentTaskId: true,
  // Read only to class Lane-2 rail edges as advisory ordering
  // (docs/specs/timeline-mobile-rail.md Rule D3-2).
  pathManifest: true,
  category: true,
  taskClass: true,
  loopConfig: true,
  loopState: true,
  loopIteration: true,
  startAt: true,
  // Attempt-strip provenance (U8): deriveTaskOrigin reads the three retry
  // counters plus the context digest to say why each attempt exists.
  reviewerRetryPrNumber: true,
  ciRetryPrNumber: true,
  conflictRetryPrNumber: true,
  // Authorship: computeMissionAuthorshipHealth's human-task-share input.
  createdByWorkerId: true,
  createdByAccountId: true,
  // Mission legibility (docs/specs/mission-legibility.md): the stored phase
  // and the work-kind glyph.
  missionPhaseIndex: true,
  missionPhaseLabel: true,
  kind: true,
  // Board: which tasks the "PRs merged" criterion counts before they open one.
  outputRequirement: true,
  // Board / Lanes: the short label a tile and a bar draw (taskDisplayLabel).
  label: true,
} as const;

/** `mission.tasks` for the detail page: newest first, three workers each, five artifacts per worker. */
export const MISSION_TASKS_WITH = {
  columns: MISSION_TASK_COLUMNS,
  orderBy: (t: any, { desc }: any) => [desc(t.createdAt)],
  with: {
    workers: {
      columns: MISSION_WORKER_COLUMNS,
      orderBy: (w: any, { desc }: any) => [desc(w.startedAt)],
      limit: 3,
      with: {
        artifacts: {
          columns: MISSION_ARTIFACT_COLUMNS,
          limit: 5,
        },
      },
    },
  },
} as const;

/** The mission row's relations on the detail page. */
export const MISSION_DETAIL_WITH = {
  workspace: { columns: { id: true, name: true, gitConfig: true, releaseConfig: true } },
  initiative: { columns: { id: true, title: true } },
  tasks: MISSION_TASKS_WITH,
  schedule: true,
} as const;

// ── The visual review shots ─────────────────────────────────────────────────

/**
 * Audit screenshots for the Visual review step (docs/design/visual-qa-auditor.md,
 * "Where the screenshots show"). A dedicated query, because the with-tree above
 * keeps five artifacts per worker and would cut a 40-shot run to five. Keyed on
 * `artifacts.mission_id`, which upload-url sets for an auditor's uploads.
 */
export const MISSION_VISUAL_SHOT_COLUMNS = {
  id: true,
  workerId: true,
  type: true,
  metadata: true,
  createdAt: true,
} as const;

/** Newest first: 40 shots a run (20 routes × 2 viewports) × up to three runs. */
export const MISSION_VISUAL_SHOTS_LIMIT = 120;

/** Newest first. With the limit above, ascending would keep the oldest runs and cut the newest. */
export const MISSION_VISUAL_SHOTS_ORDER = (
  a: { createdAt: typeof artifacts.createdAt },
  { desc }: { desc: (c: typeof artifacts.createdAt) => SQL },
) => [desc(a.createdAt)];

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

// ── The digest query ─────────────────────────────────────────────────────────

/**
 * `tasks.result` keys the page reads: the completion summary
 * (`selectMissionCompletionSummary` → `authoredSummary`) and the heartbeat
 * status and summary (`getHeartbeatStatus`, `HeartbeatTimeline`).
 */
export const RESULT_DIGEST_KEYS = ['summary', 'summarySource', 'reaperAutoCompleted'] as const;
export const RESULT_STRUCTURED_OUTPUT_KEYS = ['status', 'summary'] as const;

/**
 * `tasks.context` keys the attempt strip reads (`attemptKind`,
 * `deriveTaskOrigin`, the iteration counters in `attempt-strip.ts`), plus
 * `failureContext.errorType` for the failure reason, plus `visualQa` for the
 * Visual review's required routes.
 */
export const CONTEXT_DIGEST_KEYS = [
  'driftDiagnosis',
  'iteration',
  'maxIterations',
  'conflictIteration',
  'maxConflictIterations',
  'cycleNumber',
  'scheduleName',
  'prNumber',
  'prUrl',
  'ciRunUrl',
  // Visual review n/m coverage: the round-2 planner's frozen
  // visualQa.requiredRoutes (auditRequiredRoutes). Small: a route list.
  'visualQa',
] as const;
export const CONTEXT_FAILURE_KEYS = ['errorType'] as const;

type Json = Record<string, unknown>;

function pick(source: unknown, keys: readonly string[]): Json {
  const out: Json = {};
  if (!source || typeof source !== 'object' || Array.isArray(source)) return out;
  for (const k of keys) {
    const v = (source as Json)[k];
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

/**
 * JS twin of {@link RESULT_DIGEST_SQL}: what the page receives in place of the
 * full `result`. The parity test runs the page's readers over both.
 */
export function digestTaskResult(result: unknown): Json | null {
  if (result == null) return null;
  const out = pick(result, RESULT_DIGEST_KEYS);
  const so = pick((result as Json).structuredOutput, RESULT_STRUCTURED_OUTPUT_KEYS);
  if (Object.keys(so).length > 0) out.structuredOutput = so;
  return out;
}

/** JS twin of {@link CONTEXT_DIGEST_SQL}. */
export function digestTaskContext(context: unknown): Json | null {
  if (context == null) return null;
  const out = pick(context, CONTEXT_DIGEST_KEYS);
  const failure = pick((context as Json).failureContext, CONTEXT_FAILURE_KEYS);
  if (Object.keys(failure).length > 0) out.failureContext = failure;
  return out;
}

/**
 * `'k', col->'k'` pairs for `jsonb_build_object`. The keys are this module's
 * own constants, bound as `text` parameters (the cast picks the text `->`
 * overload over the integer one).
 */
function pairs(col: SQL, keys: readonly string[]): SQL {
  return sql.join(keys.map(k => sql`${k}::text, ${col}->${k}::text`), sql`, `);
}

/** An empty nested object becomes SQL NULL, so the outer `jsonb_strip_nulls` drops its key. */
function digestSql(col: SQL, keys: readonly string[], nestedKey: string, nestedKeys: readonly string[]): SQL {
  const nestedCol = sql`(${col}->${nestedKey}::text)`;
  const nested = sql`nullif(jsonb_strip_nulls(jsonb_build_object(${pairs(nestedCol, nestedKeys)})), '{}'::jsonb)`;
  return sql`case when ${col} is null then null else jsonb_strip_nulls(jsonb_build_object(${pairs(col, keys)}, ${nestedKey}::text, ${nested})) end`;
}

export const RESULT_DIGEST_SQL = digestSql(sql`${tasks.result}`, RESULT_DIGEST_KEYS, 'structuredOutput', RESULT_STRUCTURED_OUTPUT_KEYS);
export const CONTEXT_DIGEST_SQL = digestSql(sql`${tasks.context}`, CONTEXT_DIGEST_KEYS, 'failureContext', CONTEXT_FAILURE_KEYS);

/** Selection for the per-task digest read: the id plus the two projections. */
export const TASK_DIGEST_SELECTION = {
  id: tasks.id,
  result: sql<Json | null>`${RESULT_DIGEST_SQL}`.as('result_digest'),
  context: sql<Json | null>`${CONTEXT_DIGEST_SQL}`.as('context_digest'),
};

export const taskDigestWhere = (missionId: string) => eq(tasks.missionId, missionId);

export interface TaskDigest {
  result: Json | null;
  context: Json | null;
}

/** Digest rows → `id → digest`, for merging back onto the relational tasks. */
export function indexTaskDigests(rows: ReadonlyArray<{ id: string; result: unknown; context: unknown }>): Map<string, TaskDigest> {
  const out = new Map<string, TaskDigest>();
  for (const r of rows) {
    out.set(r.id, {
      result: (r.result as Json | null) ?? null,
      context: (r.context as Json | null) ?? null,
    });
  }
  return out;
}
