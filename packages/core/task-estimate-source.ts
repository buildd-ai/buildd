/**
 * The I/O half of the task-estimates experiment (the pure blend is
 * `./task-estimate.ts`; removal steps in `./TASK-ESTIMATES-REMOVAL.md`).
 *
 * Every new work task on an opted-in team (`teams.task_estimates.enabled`)
 * gets ONE frozen row in `task_estimates`, written after the creation response
 * (`writeTaskEstimate`, scheduled by apps/web/src/lib/task-estimate-hook.ts).
 * Insert-only: a re-estimate is a new estimator version, never an update.
 *
 * Evidence, all cut off at the task's `createdAt` so nothing the task could
 * not have known at creation counts:
 *
 * - neighbours: the completed tasks most similar to this one in the same
 *   workspace (`findNeighbourTasks`, the task-size estimate's retrieval), sized
 *   by their completed worker sessions: minutes = Σ(completedAt − startedAt),
 *   tokens = Σ(inputTokens + outputTokens), the backtest's `actualOf`.
 * - clusters: the same workspace's area-cluster model
 *   (`./task-area-clusters.ts`), the task mapped by its declared manifest or
 *   its neighbours' diffs.
 * - prior: aggregates over completed `task_class='work'` tasks in every
 *   workspace, grouped by (kind, size bucket) ONLY. Numbers and enum keys:
 *   never a path, title, text or id, and never a row of another workspace.
 *
 * Size bucket: the Jev S/M/L size-bucket decision is an inference call that
 * writes ledger rows, so it is never called from here. Its recorded verdict
 * (`orchestration_manifest_predictions.expected_size`, source 'jev') is read
 * when it exists; otherwise the bucket is null and the estimator falls back.
 * History without a recorded bucket counts as 'M', the decision's own rule
 * verdict (the same floor the estimate backtest replays with).
 *
 * Local sources are best-effort: one that cannot be read is left out, and the
 * row's explanation names only the sources that counted. A failure to read the
 * task or to write the row returns 'failed'. Nothing here throws, and nothing
 * here logs task text: ids and error names only.
 */
import { and, desc, eq, inArray, isNotNull, lt, sql, type SQL } from 'drizzle-orm';
import { db } from './db/client';
import { orchestrationManifestPredictions, systemCache, taskEstimates, tasks, teams, workers, type TaskEstimate } from './db/schema';
import { buildClusterTasks, loadDiffFiles, loadRepairCounts } from './task-area-clusters-source';
import type { ReplaySession, ReplayTask } from './estimate-backtest-source';
import {
  deriveClusters, estimateFromClusters, groupKey, mapNewTaskToClusters, weightedQuantile,
  type ClusterGroupStats, type ClusterModel, type ClusterWeight,
} from './task-area-clusters';
import { TASK_AREA_FALLBACK } from './task-area-prediction';
import { fetchNeighbourPaths, findNeighbourTasks, type TaskAreaQuerier } from './task-area-prediction-source';
import {
  ESTIMATOR_VERSION, estimateTask,
  type ClusterEvidence, type EstimateInputs, type NeighbourEvidence, type PriorCell, type PriorTable, type SizeBucket,
  type TaskEstimateResult,
} from './task-estimate';
import { defaultStore, neighbourSessionsWhere } from './task-size-estimate';

// ── Team switch ──────────────────────────────────────────────────────────────

/** The stored value, read fail-closed: only a literal `enabled: true` is on. */
export function readTaskEstimatesSetting(raw: unknown): boolean {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw) && (raw as Record<string, unknown>).enabled === true;
}

/** Whether a team opted in. A read error is "off". */
export async function taskEstimatesEnabled(teamId: string): Promise<boolean> {
  try {
    const row = await db.query.teams.findFirst({ where: eq(teams.id, teamId), columns: { taskEstimates: true } });
    return readTaskEstimatesSetting(row?.taskEstimates);
  } catch {
    return false;
  }
}

// ── k0 config ────────────────────────────────────────────────────────────────

/** `system_cache` key holding `{ k0 }`. Wins over env, so it changes without a deploy. */
export const TASK_ESTIMATE_CONFIG_CACHE_KEY = 'task_estimate_config';
export const TASK_ESTIMATE_K0_ENV = 'BUILDD_TASK_ESTIMATE_K0';
/** Local samples at which local evidence and the prior weigh the same. */
export const TASK_ESTIMATE_K0_FALLBACK = 8;

const k0From = (raw: unknown): number | undefined => {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 1_000 ? n : undefined;
};

/**
 * Pure: fallback ← env ← system_cache row, like `resolveTaskAreaConfig`. An
 * out-of-range or non-numeric value is refused (and reported), never clamped.
 */
export function resolveTaskEstimateK0(
  env: Record<string, string | undefined>,
  row: Record<string, unknown> | null | undefined,
): { k0: number; rejected: string[] } {
  let k0 = TASK_ESTIMATE_K0_FALLBACK;
  const rejected: string[] = [];
  for (const [where, raw] of [[TASK_ESTIMATE_K0_ENV, env[TASK_ESTIMATE_K0_ENV]], [`${TASK_ESTIMATE_CONFIG_CACHE_KEY}.k0`, row?.k0]] as const) {
    if (raw === undefined || raw === null || raw === '') continue;
    const v = k0From(raw);
    if (v === undefined) rejected.push(`${where}=${String(raw)}`);
    else k0 = v;
  }
  return { k0, rejected };
}

const CONFIG_TTL_MS = 60_000;
let k0Cache: { at: number; k0: number } | null = null;

export async function loadTaskEstimateK0(): Promise<number> {
  if (k0Cache && Date.now() - k0Cache.at < CONFIG_TTL_MS) return k0Cache.k0;
  let row: Record<string, unknown> | null = null;
  try {
    const found = await db.query.systemCache.findFirst({ where: eq(systemCache.key, TASK_ESTIMATE_CONFIG_CACHE_KEY) });
    if (found?.value && typeof found.value === 'object' && !Array.isArray(found.value)) row = found.value as Record<string, unknown>;
  } catch {
    // No row, no table: the fallback is a working value.
  }
  const { k0, rejected } = resolveTaskEstimateK0(process.env, row);
  for (const r of rejected) console.warn(`[task-estimate] ignoring k0 override ${r}: not a number in [0, 1000]`);
  k0Cache = { at: Date.now(), k0 };
  return k0;
}

// ── Pure evidence builders ───────────────────────────────────────────────────

const quantile = (xs: readonly number[], q: number) => weightedQuantile(xs.map(value => ({ value, weight: 1 })), q);
const toMs = (d: Date | string | null | undefined) => (d ? new Date(d).getTime() : NaN);

export interface NeighbourSessionRow {
  taskId: string | null;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

/**
 * p50/p80 minutes and tokens over the neighbours with a positive duration.
 * Sessions that ended at or after the cutoff, and neighbours created at or
 * after it (when `createdAtById` knows them), are the future and are dropped.
 */
export function neighbourEvidenceFrom(
  neighbourIds: readonly string[],
  sessions: readonly NeighbourSessionRow[],
  opts: { cutoff: Date; createdAtById?: ReadonlyMap<string, Date | string>; minN?: number },
): NeighbourEvidence | null {
  const cutoff = opts.cutoff.getTime();
  const wanted = new Set(neighbourIds.filter(id => {
    const c = opts.createdAtById?.get(id);
    return c === undefined || toMs(c) < cutoff;
  }));
  const spent = new Map<string, { minutes: number; tokens: number }>();
  for (const s of sessions) {
    if (!s.taskId || !wanted.has(s.taskId)) continue;
    const end = toMs(s.completedAt);
    const span = (end - toMs(s.startedAt)) / 60_000;
    if (!Number.isFinite(span) || span <= 0 || end >= cutoff) continue;
    const acc = spent.get(s.taskId) ?? { minutes: 0, tokens: 0 };
    acc.minutes += span;
    acc.tokens += (s.inputTokens ?? 0) + (s.outputTokens ?? 0);
    spent.set(s.taskId, acc);
  }
  const sized = [...spent.values()].filter(v => v.minutes > 0);
  if (sized.length < (opts.minN ?? 2)) return null;
  const minutes = sized.map(v => v.minutes);
  const tokens = sized.map(v => v.tokens);
  return {
    n: sized.length,
    p50Minutes: quantile(minutes, 0.5),
    p80Minutes: quantile(minutes, 0.8),
    p50Tokens: quantile(tokens, 0.5),
    p80Tokens: quantile(tokens, 0.8),
  };
}

/**
 * Cluster evidence: `estimateFromClusters` for minutes, p50 tokens and
 * repairs, plus p80 tokens by the same rule (the task's (kind, complexity)
 * group in each cluster when it has ≥ 2 tasks there, else the cluster's
 * overall stats). n is the weighted task count behind the mapped clusters.
 */
export function clusterEvidenceFrom(
  mapped: readonly ClusterWeight[],
  model: Pick<ClusterModel, 'clusters'>,
  task: { kind?: string | null; complexity?: string | null },
): ClusterEvidence | null {
  const est = estimateFromClusters(mapped, model, task);
  if (!est || est.minutes <= 0) return null;
  const byLabel = new Map(model.clusters.map(c => [c.label, c]));
  const key = groupKey(task.kind, task.complexity);
  const rows: Array<{ s: ClusterGroupStats; weight: number }> = [];
  for (const m of mapped) {
    const c = byLabel.get(m.label);
    if (!c) continue;
    const g = c.byGroup[key];
    rows.push({ s: g && g.n >= 2 ? g : c.overall, weight: m.weight });
  }
  const p80Tokens = weightedQuantile(rows.map(r => ({ value: r.s.tokens.p80, weight: r.weight })), 0.5);
  const n = Math.max(1, Math.round(rows.reduce((s, r) => s + r.weight * r.s.n, 0)));
  return {
    n,
    label: mapped[0]?.label ?? est.clusters[0] ?? null,
    p50Minutes: est.minutes,
    p80Minutes: est.p80Minutes,
    p50Tokens: est.tokens,
    p80Tokens,
    repairsPerTask: est.repairRate,
  };
}

// ── The cross-workspace prior ────────────────────────────────────────────────

/** The `tasks.kind` vocabulary. A kind outside it is dropped, so a free-text value can never become a key. */
export const PRIOR_KINDS = ['coordination', 'engineering', 'research', 'writing', 'design', 'analysis', 'observation', 'unknown'] as const;
const PRIOR_KIND_SET: ReadonlySet<string> = new Set(PRIOR_KINDS);
const BUCKETS: ReadonlySet<string> = new Set<SizeBucket>(['S', 'M', 'L']);
/** A cell needs this many tasks, so no cell is one tenant's one task. */
export const PRIOR_MIN_CELL_N = 3;

/**
 * One row per (kind, bucket): counts and quantiles, nothing else. Selected
 * columns are the two enum keys and numbers; grouped by the two keys only.
 * Snake-case aliases (mapped in `buildPriorTable`).
 */
export function priorAggregateQuery(cutoff: Date): SQL {
  const at = cutoff.toISOString();
  return sql`
    WITH done AS (
      SELECT t.id,
             COALESCE(t.kind, 'unknown') AS kind,
             COALESCE((
               SELECT p.expected_size->>'bucket'
                 FROM orchestration_manifest_predictions p
                WHERE p.task_id = t.id AND p.expected_size->>'source' = 'jev'
                ORDER BY p.created_at DESC
                LIMIT 1
             ), 'M') AS bucket
        FROM tasks t
       WHERE t.task_class = 'work'
         AND t.status = 'completed'
         AND t.created_at < ${at}::timestamptz
    ),
    spent AS (
      SELECT w.task_id,
             SUM(EXTRACT(EPOCH FROM (w.completed_at - w.started_at)) / 60.0) AS minutes,
             SUM(COALESCE(w.input_tokens, 0) + COALESCE(w.output_tokens, 0)) AS tokens
        FROM workers w
        JOIN done d ON d.id = w.task_id
       WHERE w.status = 'completed'
         AND w.started_at IS NOT NULL
         AND w.completed_at IS NOT NULL
         AND w.completed_at > w.started_at
         AND w.completed_at < ${at}::timestamptz
       GROUP BY w.task_id
    ),
    repairs AS (
      SELECT a.parent_task_id AS task_id, COUNT(*) AS n
        FROM tasks a
        JOIN done d ON d.id = a.parent_task_id
       WHERE a.task_class = 'attempt'
         AND a.created_at < ${at}::timestamptz
       GROUP BY a.parent_task_id
    )
    SELECT d.kind AS kind,
           d.bucket AS bucket,
           COUNT(*) AS n,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY s.minutes) AS p50_minutes,
           percentile_cont(0.8) WITHIN GROUP (ORDER BY s.minutes) AS p80_minutes,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY s.tokens) AS p50_tokens,
           percentile_cont(0.8) WITHIN GROUP (ORDER BY s.tokens) AS p80_tokens,
           AVG(COALESCE(r.n, 0)) AS repairs_per_task
      FROM done d
      JOIN spent s ON s.task_id = d.id
      LEFT JOIN repairs r ON r.task_id = d.id
     WHERE s.minutes > 0
     GROUP BY d.kind, d.bucket
  `;
}

const finiteNonNeg = (raw: unknown): number | null => {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * Pure: aggregate rows → PriorTable. Only known kinds and S/M/L become keys;
 * every value is re-typed as a finite number, and nothing else on a row is
 * carried. Cells under `PRIOR_MIN_CELL_N` are dropped.
 */
export function buildPriorTable(rows: ReadonlyArray<Record<string, unknown>>): PriorTable {
  const out: Record<string, Partial<Record<SizeBucket, PriorCell>>> = {};
  for (const r of rows) {
    const kind = typeof r.kind === 'string' && PRIOR_KIND_SET.has(r.kind) ? r.kind : null;
    const bucket = typeof r.bucket === 'string' && BUCKETS.has(r.bucket) ? (r.bucket as SizeBucket) : null;
    if (!kind || !bucket) continue;
    const n = finiteNonNeg(r.n);
    const cell = {
      p50Minutes: finiteNonNeg(r.p50_minutes),
      p80Minutes: finiteNonNeg(r.p80_minutes),
      p50Tokens: finiteNonNeg(r.p50_tokens),
      p80Tokens: finiteNonNeg(r.p80_tokens),
      repairsPerTask: finiteNonNeg(r.repairs_per_task),
    };
    if (n === null || n < PRIOR_MIN_CELL_N || Object.values(cell).some(v => v === null)) continue;
    (out[kind] ??= {})[bucket] = {
      n: Math.round(n),
      p50Minutes: cell.p50Minutes!,
      p80Minutes: cell.p80Minutes!,
      p50Tokens: cell.p50Tokens!,
      p80Tokens: cell.p80Tokens!,
      repairsPerTask: cell.repairsPerTask!,
    };
  }
  return out;
}

/**
 * A model built at an earlier cutoff is still leakage-free for a later task,
 * so the prior and each workspace's cluster model are reused for a while
 * within one process instead of being rebuilt per task.
 */
const MODEL_TTL_MS = 10 * 60_000;
let priorCache: { at: number; cutoff: number; table: PriorTable } | null = null;
const clusterCache = new Map<string, { at: number; cutoff: number; model: ClusterModel }>();

/** Tests only. */
export function resetTaskEstimateCaches(): void {
  priorCache = null;
  clusterCache.clear();
  k0Cache = null;
}

const fresh = (c: { at: number; cutoff: number } | null | undefined, cutoff: Date) =>
  !!c && c.cutoff <= cutoff.getTime() && Date.now() - c.at < MODEL_TTL_MS;

export async function loadPriorTable(cutoff: Date): Promise<PriorTable> {
  if (fresh(priorCache, cutoff)) return priorCache!.table;
  const result = await db.execute(priorAggregateQuery(cutoff));
  const table = buildPriorTable((result.rows ?? []) as Array<Record<string, unknown>>);
  priorCache = { at: Date.now(), cutoff: cutoff.getTime(), table };
  return table;
}

// ── Workspace-local loaders ──────────────────────────────────────────────────

/** Completed work tasks in one workspace created before the cutoff, with their pre-cutoff sessions, as a cluster model. */
async function loadClusterModel(workspaceId: string, cutoff: Date): Promise<ClusterModel> {
  const hit = clusterCache.get(workspaceId);
  if (fresh(hit, cutoff)) return hit!.model;
  const rows = await db
    .select({ id: tasks.id, workspaceId: tasks.workspaceId, createdAt: tasks.createdAt, kind: tasks.kind, complexity: tasks.complexity })
    .from(tasks)
    .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.taskClass, 'work'), eq(tasks.status, 'completed'), lt(tasks.createdAt, cutoff)));
  const history: ReplayTask[] = rows.map(r => ({ ...r, title: '', description: null, completedAt: null }));
  const sessions: ReplaySession[] = [];
  for (let i = 0; i < history.length; i += 500) {
    const ids = history.slice(i, i + 500).map(t => t.id);
    const part = await db
      .select({
        taskId: workers.taskId, filesChanged: workers.filesChanged, startedAt: workers.startedAt,
        completedAt: workers.completedAt, inputTokens: workers.inputTokens, outputTokens: workers.outputTokens,
      })
      .from(workers)
      .where(and(inArray(workers.taskId, ids), eq(workers.status, 'completed'), isNotNull(workers.startedAt), lt(workers.completedAt, cutoff)));
    sessions.push(...(part as ReplaySession[]));
  }
  const [files, repairs] = await Promise.all([loadDiffFiles(history), loadRepairCounts(history.map(t => t.id))]);
  const model = deriveClusters(buildClusterTasks(history, sessions, files, repairs, { asOf: cutoff }), { asOf: cutoff });
  clusterCache.set(workspaceId, { at: Date.now(), cutoff: cutoff.getTime(), model });
  return model;
}

/** The size-bucket decision's recorded verdict for this task, if one exists yet. Never calls the decision. */
async function loadRecordedBucket(taskId: string): Promise<SizeBucket | null> {
  const rows = await db
    .select({ expectedSize: orchestrationManifestPredictions.expectedSize })
    .from(orchestrationManifestPredictions)
    .where(eq(orchestrationManifestPredictions.taskId, taskId))
    .orderBy(desc(orchestrationManifestPredictions.createdAt));
  for (const r of rows) {
    const s = r.expectedSize as { source?: unknown; bucket?: unknown } | null;
    if (s?.source === 'jev' && typeof s.bucket === 'string' && BUCKETS.has(s.bucket)) return s.bucket as SizeBucket;
  }
  return null;
}

/** Neighbours to retrieve; the estimate uses every one with a duration. */
const NEIGHBOUR_TOP_K = 10;

export interface EstimateTask {
  id: string;
  workspaceId: string;
  title: string;
  description?: string | null;
  kind?: string | null;
  complexity?: string | null;
  createdAt: Date | string;
  pathManifest?: string[] | null;
}

export interface LoadEstimateInputsDeps {
  /** The `task` corpus store. Default: the task-size estimate's, built only once the team is known to be opted in. */
  storeFactory?: () => Promise<TaskAreaQuerier>;
}

const bestEffort = async <T>(what: string, taskId: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    console.warn(`[task-estimate] ${what} unavailable for task ${taskId}: ${(err as Error)?.name ?? 'Error'}`);
    return fallback;
  }
};

export async function loadEstimateInputs(task: EstimateTask, deps: LoadEstimateInputsDeps = {}): Promise<EstimateInputs> {
  const cutoff = task.createdAt instanceof Date ? task.createdAt : new Date(task.createdAt);
  const kind = typeof task.kind === 'string' && PRIOR_KIND_SET.has(task.kind) && task.kind !== 'unknown' ? task.kind : null;
  const seedText = [task.title ?? '', task.description ?? ''].filter(Boolean).join('\n');

  const neighbourIds = await bestEffort('neighbour retrieval', task.id, async () => {
    const store = await (deps.storeFactory ?? defaultStore)();
    const found = await findNeighbourTasks(store, {
      workspaceId: task.workspaceId,
      taskId: task.id,
      seedText,
      config: { ...TASK_AREA_FALLBACK, topK: NEIGHBOUR_TOP_K },
    });
    return found.filter(n => n.score >= TASK_AREA_FALLBACK.similarityFloor && n.taskId !== task.id).map(n => n.taskId);
  }, [] as string[]);

  const neighbours = neighbourIds.length === 0 ? null : await bestEffort('neighbour sessions', task.id, async () => {
    const [sessions, created] = await Promise.all([
      db.select({
        taskId: workers.taskId, startedAt: workers.startedAt, completedAt: workers.completedAt,
        inputTokens: workers.inputTokens, outputTokens: workers.outputTokens,
      }).from(workers).where(neighbourSessionsWhere({ workspaceId: task.workspaceId, taskIds: neighbourIds, cutoff })),
      db.select({ id: tasks.id, createdAt: tasks.createdAt }).from(tasks)
        .where(and(eq(tasks.workspaceId, task.workspaceId), inArray(tasks.id, neighbourIds))),
    ]);
    return neighbourEvidenceFrom(neighbourIds, sessions as NeighbourSessionRow[], {
      cutoff,
      createdAtById: new Map((created as Array<{ id: string; createdAt: Date }>).map(r => [r.id, r.createdAt])),
    });
  }, null);

  const clusters = await bestEffort('cluster evidence', task.id, async () => {
    const model = await loadClusterModel(task.workspaceId, cutoff);
    if (model.clusters.length === 0) return null;
    const manifest = Array.isArray(task.pathManifest) ? task.pathManifest : [];
    let neighbourPaths: string[] = [];
    if (neighbourIds.length > 0) {
      const paths = await fetchNeighbourPaths(neighbourIds, { workspaceId: task.workspaceId, config: { ...TASK_AREA_FALLBACK, pathSource: 'diff' } });
      neighbourPaths = [...paths.values()].flat();
    }
    const mapped = mapNewTaskToClusters({ pathManifest: manifest, neighbourPaths }, model);
    return mapped.source === 'none' ? null : clusterEvidenceFrom(mapped.clusters, model, { kind: task.kind, complexity: task.complexity });
  }, null);

  const [bucket, prior, k0] = await Promise.all([
    bestEffort('recorded bucket', task.id, () => loadRecordedBucket(task.id), null),
    bestEffort('prior', task.id, () => loadPriorTable(cutoff), {} as PriorTable),
    loadTaskEstimateK0(),
  ]);

  return { kind, bucket, neighbours, clusters, prior, k0 };
}

// ── Write / read ─────────────────────────────────────────────────────────────

export type WriteTaskEstimateOutcome = 'written' | 'skipped' | 'exists' | 'failed';

export interface WriteTaskEstimateDeps extends LoadEstimateInputsDeps {
  loadInputs?: (task: EstimateTask, deps: LoadEstimateInputsDeps) => Promise<EstimateInputs>;
  estimate?: (inputs: EstimateInputs) => TaskEstimateResult;
}

/**
 * Freeze this task's estimate. 'skipped': no such task, not a work task, or
 * its team has not opted in. 'exists': a row for this estimator version is
 * already there (checked first, and again by ON CONFLICT DO NOTHING on
 * (task_id, estimator_version) for a concurrent writer). Never throws.
 */
export async function writeTaskEstimate(taskId: string, deps: WriteTaskEstimateDeps = {}): Promise<WriteTaskEstimateOutcome> {
  try {
    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, taskId),
      columns: {
        id: true, workspaceId: true, title: true, description: true, kind: true, complexity: true,
        createdAt: true, pathManifest: true, taskClass: true,
      },
      with: { workspace: { columns: { teamId: true } } },
    });
    if (!task || (task.taskClass ?? 'work') !== 'work') return 'skipped';
    const teamId = (task as { workspace?: { teamId?: string | null } | null }).workspace?.teamId ?? null;
    if (!teamId || !(await taskEstimatesEnabled(teamId))) return 'skipped';

    const already = await db
      .select({ id: taskEstimates.id })
      .from(taskEstimates)
      .where(and(eq(taskEstimates.taskId, taskId), eq(taskEstimates.estimatorVersion, ESTIMATOR_VERSION)))
      .limit(1);
    if (already.length > 0) return 'exists';

    const inputs = await (deps.loadInputs ?? loadEstimateInputs)(task as EstimateTask, { storeFactory: deps.storeFactory });
    const r = (deps.estimate ?? estimateTask)(inputs);
    const inserted = await db
      .insert(taskEstimates)
      .values({
        teamId,
        workspaceId: task.workspaceId,
        taskId,
        estimatorVersion: ESTIMATOR_VERSION,
        p50Minutes: r.p50Minutes,
        p80Minutes: r.p80Minutes,
        p50Tokens: Math.round(r.p50Tokens),
        p80Tokens: Math.round(r.p80Tokens),
        expectedRepairs: r.expectedRepairs,
        explanation: r.explanation,
      })
      .onConflictDoNothing({ target: [taskEstimates.taskId, taskEstimates.estimatorVersion] })
      .returning({ id: taskEstimates.id });
    return inserted.length > 0 ? 'written' : 'exists';
  } catch (err) {
    const e = err as { name?: string; code?: string } | null;
    console.warn(`[task-estimate] write failed for task ${taskId}: ${e?.name ?? 'Error'}${e?.code ? ` (${e.code})` : ''}`);
    return 'failed';
  }
}

/** The task's latest frozen estimate, or null. */
export async function readTaskEstimate(taskId: string): Promise<TaskEstimate | null> {
  const rows = await db
    .select()
    .from(taskEstimates)
    .where(eq(taskEstimates.taskId, taskId))
    .orderBy(desc(taskEstimates.createdAt))
    .limit(1);
  return rows[0] ?? null;
}
