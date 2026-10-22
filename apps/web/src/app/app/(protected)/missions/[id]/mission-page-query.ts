/**
 * The mission detail page's query shape (knowledge-base: buildd/design/mission-feed-mobile-continuity.md,
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
import { sql, eq, type SQL } from 'drizzle-orm';
import { tasks, workers } from '@buildd/core/db/schema';
import { sqlExtras, sqlOrderByFn } from '@buildd/core/db/relational-sql';
import { BOARD_MILESTONES_MAX, BOARD_MILESTONE_LABEL_MAX } from '@/lib/mission-board-limits';
import { DELIVERABLE_ROLE_CONTEXT_KEYS } from '@buildd/core/mission-helpers';

// ── The relational query ─────────────────────────────────────────────────────

export const MISSION_ARTIFACT_COLUMNS = {
  id: true,
  type: true,
  title: true,
  key: true,
  shareToken: true,
  visibility: true,
  metadata: true,
  // The object key for uploads (upload-url writes the column, not metadata).
  storageKey: true,
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
  // The Overview's `Closed → #N`: a replacement someone named before it merged.
  namedReplacementPrNumber: true,
  namedReplacementPrUrl: true,
  abandonedAt: true,
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
  // Board (MissionBoard): the runner a worker ran on
  // (fleet slots) and its diff size (landed rows, completion record). Its
  // milestones (a tile's notches) arrive projected (MISSION_WORKER_EXTRAS).
  runner: true,
  // With runner, joins the runner's heartbeat for its hostname (runner-display).
  accountId: true,
  localUiUrl: true,
  linesAdded: true,
  linesRemoved: true,
  // The Landed drawer's audit evidence: the head this worker pushed, which a
  // review verdict must match to count (lib/activity-delivery.ts).
  lastCommitSha: true,
  // The after() PR fact import records a fact in the worker's own workspace (AC-3).
  workspaceId: true,
  // The mission's state (explainMission) and completion gate read these from
  // the page's rows instead of loading the tasks again (spec 3ef37387 R-11).
  prBaseRef: true,
  abandonedReason: true,
  supersessionScan: true,
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
  // Flow: the same-files waits Buildd added (`softOverlaps`), which gate like dependencies.
  pathDeclaration: true,
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
  // Board / Flow: the short label a tile and a row draw (taskDisplayLabel).
  label: true,
  // Board: the Landed drawer's task actions (Retry on / Switch to).
  backend: true,
  // The mission's state and completion gate (explainMission, canCompleteMission)
  // read these from the page's rows: the PR a review targets, and each PR's repo.
  subjectPrNumber: true,
  workspaceId: true,
} as const;

/**
 * A worker's milestones as the board reads them (`selectMilestones`): the
 * newest {@link BOARD_MILESTONES_MAX} status entries with a numeric time and a
 * label, the label cut one past {@link BOARD_MILESTONE_LABEL_MAX} so the board
 * still marks it cut. The column is the session's whole progress log; the
 * board draws a tail of it. Same order and ties as `selectMilestones`.
 */
export const BOARD_MILESTONES_SQL = sql`coalesce((
  select jsonb_agg(m.v order by m.t, m.o) from (
    select jsonb_build_object('ts', coalesce(e->'ts', e->'timestamp'), 'label', left(e->>'label', ${BOARD_MILESTONE_LABEL_MAX + 1}::int)) as v,
      (coalesce(e->'ts', e->'timestamp'))::numeric as t, o
    from jsonb_array_elements(case when jsonb_typeof(${workers.milestones}) = 'array' then ${workers.milestones} else '[]'::jsonb end) with ordinality as x(e, o)
    where jsonb_typeof(e) = 'object'
      and (not (e ? 'type') or e->>'type' = 'status')
      and jsonb_typeof(coalesce(e->'ts', e->'timestamp')) = 'number'
      and coalesce(e->>'label', '') <> ''
    order by t desc, o desc
    limit ${BOARD_MILESTONES_MAX}::int
  ) m
), '[]'::jsonb)`;

/** The first line of a worker's error, as the mission's state names a failure (`errorSignature`). */
export const WORKER_ERROR_LINE_SQL = sql`left(split_part(${workers.error}, E'\n', 1), 200)`;

export const MISSION_WORKER_EXTRAS = sqlExtras({
  milestones: sql<Array<{ ts: number; label: string }>>`${BOARD_MILESTONES_SQL}`,
  error: sql<string | null>`${WORKER_ERROR_LINE_SQL}`,
});

/** `mission.tasks` for the detail page: newest first, three workers each, five artifacts per worker. */
export const MISSION_TASKS_WITH = {
  columns: MISSION_TASK_COLUMNS,
  orderBy: sqlOrderByFn((t: any, { desc }: any) => [desc(t.createdAt)]),
  with: {
    workers: {
      columns: MISSION_WORKER_COLUMNS,
      extras: MISSION_WORKER_EXTRAS,
      orderBy: sqlOrderByFn((w: any, { desc }: any) => [desc(w.startedAt)]),
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

// The one scoping rule for audit shots lives with the visual review's other
// queries (docs/design/visual-qa-human-review.md, "Read"); re-exported so this
// module's shape stays one import for the page.
export {
  MISSION_VISUAL_SHOT_COLUMNS,
  MISSION_VISUAL_SHOTS_LIMIT,
  MISSION_VISUAL_SHOTS_ORDER,
  missionVisualShotsWhere,
} from '@/lib/visual-review-query';

// ── The digest query ─────────────────────────────────────────────────────────

/**
 * `tasks.result` keys the page reads: the completion summary
 * (`selectMissionCompletionSummary` → `authoredSummary`) and the heartbeat
 * status and summary (`getHeartbeatStatus`, `HeartbeatTimeline`), and a
 * reviewer run's verdict (`reviewOf`: `effectiveVerdict`, else
 * `structuredOutput.verdict`) for the Landed drawer's audit evidence.
 */
export const RESULT_DIGEST_KEYS = [
  'summary', 'summarySource', 'reaperAutoCompleted', 'effectiveVerdict',
  // The mission's state and completion gate: an infrastructure failure
  // (`isInfraFailedTask`, the `infra_stalled` refusal).
  'errorType', 'error',
] as const;
export const RESULT_STRUCTURED_OUTPUT_KEYS = ['status', 'summary', 'verdict'] as const;

/**
 * `tasks.context` keys the attempt strip reads (`attemptKind`,
 * `deriveTaskOrigin`, the iteration counters in `attempt-strip.ts`), plus
 * `failureContext.errorType` for the failure reason, plus `visualQa` for the
 * Visual review's required routes, plus `triggerSource` / `triggerTaskId`
 * for the Organizer runs timeline.
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
  // Organizer runs timeline: what started each run (lib/mission-checkins.ts).
  'triggerSource',
  'triggerTaskId',
  // The head a reviewer run read (`reviewOf`): binds its verdict to a commit.
  'headSha',
  // The mission's state (explainMission): a reviewer a runner can claim, and
  // the waits a provider pause or an infrastructure retry set (mission-wait.ts).
  'reviewerFor',
  'budgetExhausted',
  'infraRetryCount',
  // Which kind of deliverable a task is (`deliverableRole`, with `isTrunkRefreshTask`).
  ...DELIVERABLE_ROLE_CONTEXT_KEYS.values,
] as const;
/** Object markers `deliverableRole` reads only for being objects: each arrives as `{}`. */
export const CONTEXT_MARKER_KEYS = DELIVERABLE_ROLE_CONTEXT_KEYS.objectMarkers;
export const CONTEXT_FAILURE_KEYS = ['errorType', 'summary'] as const;

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
  for (const k of CONTEXT_MARKER_KEYS) {
    const v = (context as Json)[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = {};
  }
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

/** `'k', '{}'` for each key that holds an object, else `'k', null` (stripped). */
function markers(col: SQL, keys: readonly string[]): SQL {
  return sql.join(keys.map(k => sql`${k}::text, case when jsonb_typeof(${col}->${k}::text) = 'object' then '{}'::jsonb end`), sql`, `);
}

/** An empty nested object becomes SQL NULL, so the outer `jsonb_strip_nulls` drops its key. */
function digestSql(col: SQL, keys: readonly string[], nestedKey: string, nestedKeys: readonly string[], markerKeys: readonly string[] = []): SQL {
  const nestedCol = sql`(${col}->${nestedKey}::text)`;
  const nested = sql`nullif(jsonb_strip_nulls(jsonb_build_object(${pairs(nestedCol, nestedKeys)})), '{}'::jsonb)`;
  const marked = markerKeys.length > 0 ? sql`, ${markers(col, markerKeys)}` : sql``;
  return sql`case when ${col} is null then null else jsonb_strip_nulls(jsonb_build_object(${pairs(col, keys)}, ${nestedKey}::text, ${nested}${marked})) end`;
}

export const RESULT_DIGEST_SQL = digestSql(sql`${tasks.result}`, RESULT_DIGEST_KEYS, 'structuredOutput', RESULT_STRUCTURED_OUTPUT_KEYS);
export const CONTEXT_DIGEST_SQL = digestSql(sql`${tasks.context}`, CONTEXT_DIGEST_KEYS, 'failureContext', CONTEXT_FAILURE_KEYS, CONTEXT_MARKER_KEYS);

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
