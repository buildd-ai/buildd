/**
 * Creation-time manifest prediction — the stores and the orchestration
 * (docs/design/conflict-aware-orchestration.md §5a). Pure rules live in
 * `./manifest-prediction.ts`.
 *
 * Runs in SHADOW, after the task-creation response (the web route schedules it
 * with `after()`), for teams that opted in to `orchestration_manifest`. It never
 * writes `tasks.path_manifest` or `dependsOn`, and it never throws.
 *
 * ── Candidates ─────────────────────────────────────────────────────────────
 *  - **Neighbours** are reused from task-area prediction (`findNeighbourTasks`
 *    over the workspace's `task` corpus). The retrieval experiment itself is
 *    untouched: its config switch, arms and rail are not read or written here.
 *  - **No future leakage**: each neighbour is dated by its first worker
 *    completion (workspace-scoped read) and must predate the new task's
 *    creation; its diff paths come from `pr` corpus chunks stamped before the
 *    same cutoff. At creation time this is trivially true; it matters for any
 *    replay over historical tasks, which reuses this exact code path.
 *  - **CBM**: a bounded adapter seam. codebase-memory runs only on runners (a
 *    stdio server per worktree) and the server has no revision-pinned index —
 *    the Step E finding (apps/web/src/lib/semantic-refresh.ts). The server
 *    adapter therefore answers `unavailable`, coverage is recorded as
 *    `neighbour_diff_only`, and candidate omissions are unknown scope.
 *
 * One overall deadline (5s default) covers access, retrieval and every pick.
 */
import { and, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { FAILED_WORKER_STATUSES } from '@buildd/shared';
import { db } from './db/client';
import { orchestrationManifestPredictions, workers } from './db/schema';
import { buildNamespace } from './knowledge-store/pg-vector-store';
import { inferPathsFromText } from './task-path-inference';
import { hasConcretePathManifest } from './path-overlap';
import { TASK_AREA_FALLBACK, unionNeighbourPaths, type TaskAreaConfig } from './task-area-prediction';
import { findNeighbourTasks, type TaskAreaQuerier } from './task-area-prediction-source';
import {
  ORCHESTRATION_DECISION_DEADLINE_MS,
  candidateDigest,
  runOrchestrationDecision,
  type OrchestrationDecisionDeps,
  type OrchestrationDecisionRow,
} from './orchestration-decision';
import type { DecisionAccess } from './decision-client';
import { manifestPickIdentity, resolveApplyingFraction, type PromotionEvidence } from './orchestration-promotion';
import {
  MANIFEST_APPLYING_FRACTION,
  MANIFEST_CANDIDATE_POLICY_VERSION,
  MANIFEST_DECISION_ID,
  MANIFEST_PICK_MODE,
  MANIFEST_PICK_QUESTION,
  MANIFEST_PROMPT_VERSION,
  buildManifestCandidates,
  predictionUnknownScope,
  resolvePickCap,
  runRepeatedManifestChoice,
  type CbmCandidateResult,
  type ManifestCandidateSet,
  type NeighbourEvidence,
  type RepeatedChoiceResult,
} from './manifest-prediction';

const CAPABILITY = 'orchestration_manifest' as const;

/** A session that ended in one of these did failed work (§5a): its touches are not the task's scope. */
const FAILED_STATUSES: ReadonlySet<string> = new Set<string>(FAILED_WORKER_STATUSES);

/** Neighbour retrieval config: the task-area defaults, diff source, a little wider. Not the experiment's runtime config. */
export const MANIFEST_NEIGHBOUR_CONFIG: TaskAreaConfig = { ...TASK_AREA_FALLBACK, topK: 10, pathSource: 'diff' };
/** Bound on CBM paths requested per prediction. */
export const MANIFEST_CBM_CANDIDATE_LIMIT = 64;
/** Task text sent to the model, per field. */
export const MANIFEST_STATE_DESCRIPTION_CHARS = 1_500;

// ── CBM adapter seam ─────────────────────────────────────────────────────────

export interface CbmCandidateRequest {
  workspaceId: string;
  /** The revision candidates must exist at (base ref/SHA). Null ⇒ nothing pinned. */
  revision: string | null;
  seedText: string;
  limit: number;
  signal?: AbortSignal;
}

export interface CbmCandidateAdapter {
  lookup(req: CbmCandidateRequest): Promise<CbmCandidateResult>;
}

export const UNAVAILABLE_CBM_CANDIDATE_ADAPTER: CbmCandidateAdapter = {
  async lookup() {
    return {
      status: 'unavailable',
      reason: 'no revision-pinned codebase index is reachable from the server (codebase-memory runs on runners only)',
    };
  },
};

/** The adapter the deployed server uses. A provider answering at the requested revision is the one change needed. */
export function getServerCbmCandidateAdapter(): CbmCandidateAdapter {
  return UNAVAILABLE_CBM_CANDIDATE_ADAPTER;
}

// ── Neighbour evidence (predicates rendered by the tests) ────────────────────

export function neighbourCompletionWhere(opts: { workspaceId: string; taskIds: string[] }) {
  return and(
    eq(workers.workspaceId, opts.workspaceId),
    inArray(workers.taskId, opts.taskIds),
    isNotNull(workers.completedAt),
  );
}

export function neighbourDiffPathsQuery(opts: { workspaceId: string; taskIds: string[]; cutoff: Date }) {
  const ns = buildNamespace(opts.workspaceId, 'pr');
  const idList = sql.join(opts.taskIds.map(id => sql`${id}`), sql`, `);
  return sql`
    SELECT metadata->>'taskId' AS "taskId",
           metadata->>'path'   AS "path",
           COUNT(*)            AS "chunks"
      FROM knowledge_chunks
     WHERE namespace = ${ns}
       AND corpus = 'pr'
       AND is_current = true
       AND metadata->>'taskId' IN (${idList})
       AND metadata->>'path' IS NOT NULL
       AND COALESCE(source_ts, updated_at) < ${opts.cutoff.toISOString()}
     GROUP BY 1, 2
     ORDER BY 1, 3 DESC
  `;
}

/** First completion per neighbour (a later retry cannot re-date it into the past). */
async function loadNeighbourCompletions(workspaceId: string, taskIds: string[]): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  if (taskIds.length === 0) return out;
  const rows = await db
    .select({ taskId: workers.taskId, completedAt: sql<Date>`MIN(${workers.completedAt})`.as('completed_at') })
    .from(workers)
    .where(neighbourCompletionWhere({ workspaceId, taskIds }))
    .groupBy(workers.taskId);
  for (const r of rows as Array<{ taskId: string | null; completedAt: Date | string | null }>) {
    if (!r.taskId || !r.completedAt) continue;
    const d = r.completedAt instanceof Date ? r.completedAt : new Date(r.completedAt);
    if (Number.isFinite(d.getTime())) out.set(r.taskId, d);
  }
  return out;
}

async function loadNeighbourDiffPaths(workspaceId: string, taskIds: string[], cutoff: Date, perNeighbour: number): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (taskIds.length === 0) return out;
  const result = await db.execute(neighbourDiffPathsQuery({ workspaceId, taskIds, cutoff }));
  for (const raw of (result.rows ?? []) as Array<{ taskId: string; path: string }>) {
    if (!raw?.taskId || !raw?.path) continue;
    const list = out.get(raw.taskId) ?? [];
    if (list.length < perNeighbour) list.push(raw.path);
    out.set(raw.taskId, list);
  }
  return out;
}

/** Completed neighbours with their completion date and pre-cutoff diff paths. */
export async function loadNeighbourEvidence(
  store: TaskAreaQuerier,
  args: { workspaceId: string; taskId: string; seedText: string; cutoff: Date; config?: TaskAreaConfig },
): Promise<NeighbourEvidence[]> {
  const config = args.config ?? MANIFEST_NEIGHBOUR_CONFIG;
  const found = await findNeighbourTasks(store, { workspaceId: args.workspaceId, taskId: args.taskId, seedText: args.seedText, config });
  if (found.length === 0) return [];
  const ids = found.map(n => n.taskId);
  const [completions, paths] = await Promise.all([
    loadNeighbourCompletions(args.workspaceId, ids),
    loadNeighbourDiffPaths(args.workspaceId, ids, args.cutoff, config.maxPathsPerNeighbour * 4),
  ]);
  return found.map(n => ({
    taskId: n.taskId,
    score: n.score,
    completedAt: completions.get(n.taskId) ?? null,
    paths: paths.get(n.taskId) ?? [],
  }));
}

async function defaultStore(): Promise<TaskAreaQuerier> {
  const { PgVectorStore, getVoyageEmbedder } = await import('./knowledge-store');
  return new PgVectorStore(getVoyageEmbedder()) as unknown as TaskAreaQuerier;
}

// ── The prediction ───────────────────────────────────────────────────────────

export interface CreationManifestInput {
  taskId: string;
  teamId: string;
  workspaceId: string;
  missionId?: string | null;
  accountId?: string | null;
  userId?: string | null;
  title: string;
  description?: string | null;
  /** The task row's createdAt: the leakage cutoff. */
  createdAt: Date;
  /** What the caller declared (before the route's `['**']` default). */
  callerManifest: readonly string[] | null;
  /** The base the task will branch from, for revision-scoped candidates. */
  baseRef?: string | null;
  pickCap?: number;
}

export interface CreationManifestDeps {
  resolveAccess?: OrchestrationDecisionDeps['resolveAccess'];
  call?: OrchestrationDecisionDeps['call'];
  recordDecision?: OrchestrationDecisionDeps['record'];
  onReceipt?: OrchestrationDecisionDeps['onReceipt'];
  recordPrediction?: (row: ManifestPredictionRow) => Promise<void>;
  loadNeighbours?: (args: { workspaceId: string; taskId: string; seedText: string; cutoff: Date; signal: AbortSignal }) => Promise<NeighbourEvidence[]>;
  cbm?: CbmCandidateAdapter;
  now?: () => number;
  deadlineMs?: number;
  /** The REQUESTED applying fraction (default `MANIFEST_APPLYING_FRACTION`); the promotion guard grants it. */
  applyingFraction?: number;
  /** Default: the committed `ORCHESTRATION_PROMOTIONS` (empty). */
  promotions?: readonly PromotionEvidence[];
}

export type ManifestPredictionRow = typeof orchestrationManifestPredictions.$inferInsert;

export type CreationManifestOutcome =
  | { skipped: 'caller_declared' | 'capability_disabled' | 'error' }
  | { row: ManifestPredictionRow };

/** The same "declared scope" test the creation gate uses: too-wide globs and the sentinel are missing scope. */
const isConcreteDeclaration = (m: readonly string[] | null | undefined) =>
  Array.isArray(m) && hasConcretePathManifest(m.filter((p): p is string => typeof p === 'string'));

const RETRIEVAL_DEADLINE = Symbol('retrieval_deadline');

const EMPTY_UNAVAILABLE: CbmCandidateResult = { status: 'unavailable', reason: 'not consulted' };

export async function predictCreationManifest(
  input: CreationManifestInput,
  deps: CreationManifestDeps = {},
): Promise<CreationManifestOutcome> {
  // Explicit caller manifests always win: nothing to predict.
  if (isConcreteDeclaration(input.callerManifest)) return { skipped: 'caller_declared' };

  const now = deps.now ?? (() => Date.now());
  const started = now();
  const deadlineAt = started + (deps.deadlineMs ?? ORCHESTRATION_DECISION_DEADLINE_MS);
  const remaining = () => deadlineAt - now();
  const pickCap = resolvePickCap(input.pickCap);
  const seedText = [input.title ?? '', input.description ?? ''].filter(Boolean).join('\n');
  const regexPaths = (() => { try { return inferPathsFromText(input.title, input.description); } catch { return []; } })();

  const persist = async (row: ManifestPredictionRow) => {
    try {
      await (deps.recordPrediction ?? recordManifestPrediction)(row);
    } catch (err) {
      console.warn('[manifest-prediction] record failed (non-fatal):', (err as Error)?.message ?? err);
    }
  };

  const rowOf = (c: ManifestCandidateSet, r: RepeatedChoiceResult | null, stop: string, neighbourUnion: string[]): ManifestPredictionRow => ({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    taskId: input.taskId,
    decisionId: MANIFEST_DECISION_ID,
    promptVersion: MANIFEST_PROMPT_VERSION,
    candidatePolicyVersion: MANIFEST_CANDIDATE_POLICY_VERSION,
    mode: MANIFEST_PICK_MODE,
    taskCreatedAt: input.createdAt,
    candidates: c.candidates,
    candidateSources: c.sources,
    candidateCount: c.candidates.length,
    candidateTruncated: c.truncated,
    candidateOmitted: c.omitted,
    coverage: { ...c.coverage },
    picks: (r?.picks ?? []) as unknown as Array<Record<string, unknown>>,
    selected: r?.selected ?? [],
    stopReason: stop,
    complete: r?.complete ?? false,
    unknownScope: predictionUnknownScope(c, r),
    allApplied: r?.allApplied ?? false,
    pickCap,
    regexPaths,
    neighbourUnionPaths: neighbourUnion,
    latencyMs: Math.max(0, Math.round(now() - started)),
  });

  try {
    // 1. Policy first: a team that has not opted in costs this one read.
    const resolveAccess = deps.resolveAccess ?? (async (opts) => {
      const { resolveDecisionAccess } = await import('./decision-client');
      return resolveDecisionAccess(opts);
    });
    let access: DecisionAccess;
    try {
      access = await resolveAccess({ capability: CAPABILITY, teamId: input.teamId, workspaceId: input.workspaceId, accountId: input.accountId ?? null, userId: input.userId ?? null });
    } catch {
      return { skipped: 'error' };
    }
    if (!access.ok && access.error.kind === 'capability_disabled') return { skipped: 'capability_disabled' };

    const emptyCandidates = buildManifestCandidates({ cutoff: input.createdAt, neighbours: [], cbm: EMPTY_UNAVAILABLE });
    if (!access.ok) {
      // Opted in, no key: record the miss; spend nothing on retrieval.
      const row = rowOf(emptyCandidates, null, 'missing_key', []);
      await persist(row);
      return { row };
    }

    // 2. Retrieval inside the shared deadline, abandoned on expiry.
    const controller = new AbortController();
    const retrieval = (async () => {
      const loadNeighbours = deps.loadNeighbours ?? (async (a) => loadNeighbourEvidence(await defaultStore(), a));
      const cbm = deps.cbm ?? getServerCbmCandidateAdapter();
      const [neighbours, cbmResult] = await Promise.all([
        loadNeighbours({ workspaceId: input.workspaceId, taskId: input.taskId, seedText, cutoff: input.createdAt, signal: controller.signal })
          .catch((err) => { console.warn('[manifest-prediction] neighbour lookup failed:', (err as Error)?.message ?? err); return [] as NeighbourEvidence[]; }),
        cbm.lookup({ workspaceId: input.workspaceId, revision: input.baseRef ?? null, seedText, limit: MANIFEST_CBM_CANDIDATE_LIMIT, signal: controller.signal })
          .catch((err): CbmCandidateResult => ({ status: 'unavailable', reason: `adapter error: ${String((err as Error)?.message ?? err).slice(0, 120)}` })),
      ]);
      return { neighbours, cbmResult };
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const raced = await Promise.race([
      retrieval,
      new Promise<typeof RETRIEVAL_DEADLINE>(resolve => { timer = setTimeout(() => resolve(RETRIEVAL_DEADLINE), Math.max(0, remaining())); }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
    if (raced === RETRIEVAL_DEADLINE) {
      controller.abort();
      retrieval.catch(() => {});
      const row = rowOf(emptyCandidates, null, 'retrieval_deadline', []);
      await persist(row);
      return { row };
    }

    const { neighbours, cbmResult } = raced;
    const candidates = buildManifestCandidates({ cutoff: input.createdAt, neighbours, cbm: cbmResult });
    // Same-task neighbour-union baseline over the same leakage-filtered neighbours.
    const pastNeighbours = neighbours
      .filter(n => n.completedAt && n.completedAt.getTime() < input.createdAt.getTime())
      .map(n => ({ taskId: n.taskId, score: n.score, paths: [...n.paths] }));
    const neighbourUnion = unionNeighbourPaths(pastNeighbours, MANIFEST_NEIGHBOUR_CONFIG).paths;

    // 3. The bounded repeated Choice, every pick on the shared deadline.
    const cachedAccess = async () => access;
    const pickIdentity = manifestPickIdentity();
    const description = (input.description ?? '').slice(0, MANIFEST_STATE_DESCRIPTION_CHARS);
    const result = await runRepeatedManifestChoice({
      candidates: candidates.candidates,
      pickCap,
      deadlineAt,
      now,
      runPick: (args) => runOrchestrationDecision({
        decision: args.decision,
        question: MANIFEST_PICK_QUESTION,
        capability: CAPABILITY,
        scope: {
          teamId: input.teamId,
          workspaceId: input.workspaceId,
          missionId: input.missionId ?? null,
          taskId: input.taskId,
          accountId: input.accountId ?? null,
          userId: input.userId ?? null,
          baseRef: input.baseRef ?? null,
        },
        ruleVerdict: args.ruleVerdict,
        candidatePolicy: {
          version: MANIFEST_CANDIDATE_POLICY_VERSION,
          digest: candidateDigest(Object.values(args.labelMap)),
          count: Object.keys(args.labelMap).length,
          truncated: candidates.truncated,
        },
        buildState: async () => ({
          task: { title: input.title, description },
          alreadySelected: args.selected,
          note: 'Candidates come from files that similar completed tasks actually changed. New files are never listed.',
        }),
        isValidAnswer: args.isValidAnswer,
        cohort: {
          unitId: input.taskId,
          fraction: resolveApplyingFraction({
            decision: args.decision,
            question: MANIFEST_PICK_QUESTION,
            candidatePolicyVersion: MANIFEST_CANDIDATE_POLICY_VERSION,
            requestedFraction: deps.applyingFraction ?? MANIFEST_APPLYING_FRACTION,
            identity: pickIdentity,
            promotions: deps.promotions,
          }).fraction,
        },
        deadlineAt: args.deadlineAt,
        step: args.step,
        deps: {
          resolveAccess: cachedAccess,
          ...(deps.call ? { call: deps.call } : {}),
          ...(deps.recordDecision ? { record: deps.recordDecision } : {}),
          ...(deps.onReceipt ? { onReceipt: deps.onReceipt } : {}),
          now,
        },
      }),
    });

    const row = rowOf(candidates, result, result.stop, neighbourUnion);
    await persist(row);
    return { row };
  } catch (err) {
    console.warn('[manifest-prediction] failed open (non-fatal):', (err as Error)?.message ?? err);
    return { skipped: 'error' };
  }
}

// ── Writes and readout predicates ────────────────────────────────────────────

/** One row per task per candidate policy; a re-run never double-counts. Never throws. */
export async function recordManifestPrediction(row: ManifestPredictionRow): Promise<void> {
  try {
    await db.insert(orchestrationManifestPredictions).values(row).onConflictDoNothing({
      target: [orchestrationManifestPredictions.taskId, orchestrationManifestPredictions.candidatePolicyVersion],
    });
  } catch (err) {
    console.warn('[manifest-prediction] insert failed (non-fatal):', (err as Error)?.message ?? err);
  }
}

export function manifestPredictionsWhere(opts: { workspaceId: string; since: Date; until: Date }) {
  return and(
    eq(orchestrationManifestPredictions.workspaceId, opts.workspaceId),
    gte(orchestrationManifestPredictions.createdAt, opts.since),
    lt(orchestrationManifestPredictions.createdAt, opts.until),
  );
}

/**
 * Labels for one workspace's predictions in a window, for Step I's readout:
 * each prediction graded against the task's terminal touch labels (F's
 * `orchestration_touch_labels`, unioned across sessions; `landed` when the
 * task's PR merged), with candidate misses and same-task baselines. Never the
 * caller manifest. Workspace-scoped reads throughout.
 */
export async function loadManifestPredictionLabels(opts: { workspaceId: string; since: Date; until: Date; limit?: number }) {
  const { labelsWhere, prWorkersWhere } = await import('./orchestration-ledger-source');
  const { orchestrationTouchLabels } = await import('./db/schema');
  const { labelManifestPrediction } = await import('./manifest-prediction');
  const predictions = await db
    .select()
    .from(orchestrationManifestPredictions)
    .where(manifestPredictionsWhere(opts))
    .limit(opts.limit ?? 5_000);
  const taskIds = [...new Set(predictions.map(p => p.taskId))];
  if (taskIds.length === 0) return [];
  const scope = { workspaceId: opts.workspaceId, taskIds };
  const [labels, prs] = await Promise.all([
    db.select({
      taskId: orchestrationTouchLabels.taskId,
      workerStatus: orchestrationTouchLabels.workerStatus,
      touchedPaths: orchestrationTouchLabels.touchedPaths,
      prNumber: orchestrationTouchLabels.prNumber,
    }).from(orchestrationTouchLabels).where(labelsWhere(scope)),
    db.select({ taskId: workers.taskId, mergedAt: workers.mergedAt }).from(workers).where(prWorkersWhere(scope)),
  ]);
  const merged = new Set((prs as Array<{ taskId: string | null; mergedAt: Date | null }>).filter(p => p.taskId && p.mergedAt).map(p => p.taskId!));
  return predictions.map(p => {
    const touched = (labels as Array<{ taskId: string; workerStatus: string; touchedPaths: string[] }>)
      .filter(l => l.taskId === p.taskId)
      .map(l => ({ paths: l.touchedPaths ?? [], landed: merged.has(p.taskId), failed: FAILED_STATUSES.has(l.workerStatus) }));
    return {
      predictionId: p.id,
      taskId: p.taskId,
      decisionId: p.decisionId,
      candidatePolicyVersion: p.candidatePolicyVersion,
      fingerprints: (p.picks as Array<{ fingerprint?: string }>).map(k => k.fingerprint ?? null),
      label: labelManifestPrediction({
        prediction: {
          candidates: p.candidates,
          selected: p.selected,
          picks: p.picks as never,
          stop: p.stopReason as never,
          complete: p.complete,
          unknownScope: p.unknownScope,
          allApplied: p.allApplied,
          decisionId: p.decisionId,
          candidatePolicyVersion: p.candidatePolicyVersion,
          regexPaths: p.regexPaths,
          neighbourUnionPaths: p.neighbourUnionPaths,
        },
        touched,
      }),
    };
  });
}

export type { OrchestrationDecisionRow };
