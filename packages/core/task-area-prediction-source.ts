/**
 * The stores half of task-area prediction: where a neighbour comes from, where
 * its files come from, and where the prediction is written down.
 *
 * Kept apart from `./task-area-prediction.ts` for the reason the memory-digest
 * readout is split the same way: mocking `db` makes every WHERE predicate in a
 * file unobservable, so a test that mocks the client can prove a union rule is
 * correct while it runs over the wrong rows. The union rules, the config
 * resolution and the overlap arithmetic live in the pure module and are tested
 * against literal values; this module is the part that talks to Postgres and
 * to the vector store.
 *
 * ── Two stores, both already maintained ────────────────────────────────────
 *
 *  1. **Neighbours** come from the `task` corpus of the knowledge store, which
 *     is embedded on every task completion and is therefore already current.
 *     No new index, no refit, nothing to go stale.
 *  2. **A neighbour's files** come from either the `pr` corpus — whose chunks
 *     carry `metadata.taskId` and `metadata.path` per changed file, i.e. the
 *     merged diff — or from `tasks.path_manifest`. Which one is a runtime
 *     config field, because which predicts better is measurable rather than
 *     assertable.
 *
 * Everything here is best-effort. A prediction that cannot be computed is a
 * prompt without a scope hint, never a failed claim.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from './db/client';
import { systemCache, taskAreaPredictionEvents, tasks } from './db/schema';
import { buildNamespace } from './knowledge-store/pg-vector-store';
import type { Corpus, QueryMode, QueryResult } from './knowledge-store/types';
import { inferPathsFromText } from './task-path-inference';
import {
  TASK_AREA_CONFIG_CACHE_KEY,
  TASK_AREA_EXPERIMENT_ID,
  assignTaskAreaArm,
  resolveTaskAreaConfig,
  taskAreaConfigFromEnv,
  unionNeighbourPaths,
  type NeighbourTask,
  type TaskAreaArm,
  type TaskAreaConfig,
  type TaskAreaPredictionResult,
} from './task-area-prediction';

/** The slice of the knowledge store this needs, so tests can stub it. */
export interface TaskAreaQuerier {
  query(ns: string, params: { text: string; topK?: number; mode?: QueryMode; filters?: { corpus?: Corpus } }): Promise<QueryResult[]>;
}

// ── Config ───────────────────────────────────────────────────────────────────

/**
 * How long a resolved config is reused inside one process.
 *
 * Short on purpose. The whole point of the `system_cache` row is that an
 * operator can change the fraction or the path source without a deploy, and a
 * long TTL would turn "without a deploy" into "within an hour, on whichever
 * instances happen to recycle".
 */
const CONFIG_TTL_MS = 60_000;

let cached: { at: number; config: TaskAreaConfig } | null = null;

/** Drop the in-process config cache. Tests only. */
export function resetTaskAreaConfigCache(): void {
  cached = null;
}

/**
 * Resolve the effective config: in-code fallback ← env ← `system_cache`.
 *
 * The DB row wins because it is the layer that needs no deploy; env exists so
 * a knob is settable before anyone has written the row, and so a runner-style
 * operator override keeps working.
 *
 * A refused override is logged once per resolution rather than swallowed. An
 * experiment whose fraction silently reverted to 0 because someone typed `15`
 * would otherwise report a perfectly clean readout on a cohort of nobody.
 */
export async function loadTaskAreaConfig(): Promise<TaskAreaConfig> {
  if (cached && Date.now() - cached.at < CONFIG_TTL_MS) return cached.config;

  let row: Record<string, unknown> | null = null;
  try {
    const found = await db.query.systemCache.findFirst({
      where: eq(systemCache.key, TASK_AREA_CONFIG_CACHE_KEY),
    });
    const value = found?.value;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      row = value as Record<string, unknown>;
    }
  } catch {
    // No row, no table, no DB. The fallback is a working configuration.
  }

  const { config, rejected } = resolveTaskAreaConfig(taskAreaConfigFromEnv(process.env), row);
  for (const r of rejected) {
    console.warn(`[task-area] ignoring ${String(r.field)}=${r.value}: ${r.why}`);
  }

  cached = { at: Date.now(), config };
  return config;
}

// ── Neighbours ───────────────────────────────────────────────────────────────

/** `task:<uuid>` is the source id `buildTaskCard` writes. */
function taskIdFromResult(r: QueryResult): string | null {
  const fromMeta = r.metadata?.taskId;
  if (typeof fromMeta === 'string' && fromMeta) return fromMeta;
  const m = /^task:([0-9a-f-]{36})/i.exec(r.id ?? '');
  return m ? m[1] : null;
}

/**
 * The completed tasks most similar to this one.
 *
 * Only completed tasks are eligible, and the corpus enforces that by
 * construction: `buildTaskCard` writes a `task:<id>` chunk at completion and at
 * no other time, so an in-flight task is simply not in the namespace. The
 * task's own card is excluded explicitly anyway — a re-claimed task that
 * completed once before would otherwise predict its own previous diff, which
 * scores beautifully and means nothing.
 *
 * `metadata.success === false` rows are kept. A failed task still touched real
 * files in the right area, and dropping them would bias the neighbourhood
 * toward work that went smoothly.
 */
export async function findNeighbourTasks(
  store: TaskAreaQuerier,
  args: { workspaceId: string; taskId: string; seedText: string; config: TaskAreaConfig },
): Promise<Array<{ taskId: string; score: number }>> {
  const { workspaceId, taskId, seedText, config } = args;
  if (!seedText.trim()) return [];

  const results = await store.query(buildNamespace(workspaceId, 'task'), {
    text: seedText,
    // Over-fetch: the task's own card and any duplicate chunks come out of this
    // budget, and a topK of exactly `topK` would silently return fewer.
    topK: config.topK + 2,
    filters: { corpus: 'task' },
  });

  const seen = new Set<string>();
  const out: Array<{ taskId: string; score: number }> = [];
  for (const r of results) {
    const id = taskIdFromResult(r);
    if (!id || id === taskId || seen.has(id)) continue;
    seen.add(id);
    out.push({ taskId: id, score: typeof r.score === 'number' ? r.score : 0 });
    if (out.length >= config.topK) break;
  }
  return out;
}

/**
 * The files each neighbour actually touched, keyed by task id.
 *
 * `diff`: the `pr` corpus. Its chunks are per-file diff hunks carrying
 * `metadata.taskId` and `metadata.path`, written when a merged PR is ingested —
 * so this is what landed, not what anyone declared. A neighbour whose PR was
 * never merged or never ingested contributes nothing, which is correct: there
 * is no diff to learn from.
 *
 * `manifest`: `tasks.path_manifest`, read-only. Nothing in this file writes
 * that column and nothing may.
 */
export async function fetchNeighbourPaths(
  neighbourIds: readonly string[],
  args: { workspaceId: string; config: TaskAreaConfig },
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (neighbourIds.length === 0) return out;

  if (args.config.pathSource === 'manifest') {
    const rows = await db.query.tasks.findMany({
      where: inArray(tasks.id, [...neighbourIds]),
      columns: { id: true, pathManifest: true },
    });
    for (const row of rows) {
      const manifest = Array.isArray(row.pathManifest) ? row.pathManifest : [];
      out.set(row.id, manifest.filter((p): p is string => typeof p === 'string'));
    }
    return out;
  }

  // Distinct paths per neighbour, ordered by how many chunks of that PR touched
  // the file. A file the diff barely grazed and a file it rewrote are both one
  // row here otherwise, and the per-neighbour cap has to drop one of them.
  const ns = buildNamespace(args.workspaceId, 'pr');
  const idList = sql.join(neighbourIds.map(id => sql`${id}`), sql`, `);
  const result = await db.execute(sql`
    SELECT metadata->>'taskId' AS "taskId",
           metadata->>'path'   AS "path",
           COUNT(*)            AS "chunks"
      FROM knowledge_chunks
     WHERE namespace = ${ns}
       AND corpus = 'pr'
       AND is_current = true
       AND metadata->>'taskId' IN (${idList})
       AND metadata->>'path' IS NOT NULL
     GROUP BY 1, 2
     ORDER BY 1, 3 DESC
  `);

  for (const raw of result.rows as Array<{ taskId: string; path: string }>) {
    if (!raw?.taskId || !raw?.path) continue;
    const list = out.get(raw.taskId) ?? [];
    list.push(raw.path);
    out.set(raw.taskId, list);
  }
  return out;
}

// ── The prediction ───────────────────────────────────────────────────────────

export interface TaskAreaPrediction {
  taskId: string;
  workspaceId: string;
  arm: TaskAreaArm;
  propensity: number;
  fraction: number;
  policyVersion: string;
  /** The predicted area. Empty when the corpus had nothing similar to offer. */
  predictedPaths: string[];
  /** The shipped regex over the same task, for the comparison. */
  regexPaths: string[];
  result: TaskAreaPredictionResult;
  config: TaskAreaConfig;
}

export interface PredictTaskAreaInput {
  taskId: string;
  workspaceId: string;
  title?: string | null;
  description?: string | null;
}

/**
 * Compute the predicted area for a task, and the regex baseline beside it.
 *
 * Both are computed in EVERY arm. The arm decides only whether the prediction
 * reaches retrieval — measuring it on the control too is what lets the readout
 * answer "did this beat the regex" over the same tasks in the same run, and it
 * is also the only way to see whether using a prediction changes which files a
 * task ends up touching.
 */
export async function predictTaskArea(
  store: TaskAreaQuerier,
  task: PredictTaskAreaInput,
  config: TaskAreaConfig,
): Promise<TaskAreaPrediction | null> {
  if (!config.enabled) return null;

  const assignment = assignTaskAreaArm(task.taskId, config);
  const regexPaths = inferPathsFromText(task.title, task.description);
  const seedText = [task.title ?? '', task.description ?? ''].filter(Boolean).join('\n');

  let neighbours: Array<{ taskId: string; score: number }> = [];
  try {
    neighbours = await findNeighbourTasks(store, {
      workspaceId: task.workspaceId,
      taskId: task.taskId,
      seedText,
      config,
    });
  } catch (err) {
    console.warn('[task-area] neighbour lookup failed:', (err as Error)?.message ?? err);
  }

  let pathsByTask = new Map<string, string[]>();
  if (neighbours.length > 0) {
    try {
      pathsByTask = await fetchNeighbourPaths(neighbours.map(n => n.taskId), {
        workspaceId: task.workspaceId,
        config,
      });
    } catch (err) {
      console.warn('[task-area] neighbour path lookup failed:', (err as Error)?.message ?? err);
    }
  }

  const withPaths: NeighbourTask[] = neighbours.map(n => ({
    taskId: n.taskId,
    score: n.score,
    paths: pathsByTask.get(n.taskId) ?? [],
  }));
  const result = unionNeighbourPaths(withPaths, config);

  return {
    taskId: task.taskId,
    workspaceId: task.workspaceId,
    arm: assignment.arm,
    propensity: assignment.propensity,
    fraction: assignment.fraction,
    policyVersion: assignment.policyVersion,
    predictedPaths: result.paths,
    regexPaths,
    result,
    config,
  };
}

/**
 * Write the prediction to its rail.
 *
 * `onConflictDoNothing` on (task_id, policy_version): a task reclaimed after a
 * retry draws the same arm, so a second row would double-count the unit without
 * adding an observation. The first claim's prediction is the one the readout
 * scores, which is also the honest one — a later claim's neighbourhood may
 * already contain work done by the earlier attempt.
 */
export async function recordTaskAreaPrediction(prediction: TaskAreaPrediction): Promise<void> {
  try {
    await db.insert(taskAreaPredictionEvents).values({
      taskId: prediction.taskId,
      workspaceId: prediction.workspaceId,
      experimentId: TASK_AREA_EXPERIMENT_ID,
      policyVersion: prediction.policyVersion,
      arm: prediction.arm,
      propensity: prediction.propensity.toFixed(4),
      fraction: prediction.fraction.toFixed(4),
      predictedPaths: prediction.predictedPaths,
      predictedPathSource: prediction.config.pathSource,
      neighbourTaskIds: prediction.result.contributors.map(c => c.taskId),
      neighboursConsidered: prediction.result.considered,
      topScore: prediction.result.topScore === null ? null : prediction.result.topScore.toFixed(5),
      regexPaths: prediction.regexPaths,
    }).onConflictDoNothing({
      target: [taskAreaPredictionEvents.taskId, taskAreaPredictionEvents.policyVersion],
    });
  } catch (err) {
    console.warn('[task-area] failed to record prediction:', (err as Error)?.message ?? err);
  }
}

/**
 * Record what the task's diff actually touched — the ground truth the overlap
 * metric scores both predictors against.
 *
 * Written once, at terminal worker status, from the paths the runner observed
 * via `git diff --name-only` and accumulated in `workers.observed_touches`.
 * That column is cleared on the same transition, so this has to read it before
 * the clear, not after: there is no other durable per-task file list — the
 * `pr` corpus only covers merged, ingested PRs and would silently restrict the
 * cohort to work that landed.
 *
 * `WHERE actual_paths IS NULL` so a second terminal PATCH (a reaper
 * auto-completion after a worker already reported, say) cannot overwrite the
 * first observation with a shorter one.
 */
export async function recordTaskAreaOutcome(taskId: string, actualPaths: readonly string[]): Promise<void> {
  const paths = [...new Set(actualPaths.filter(p => typeof p === 'string' && p.trim()))];
  if (paths.length === 0) return;
  try {
    await db
      .update(taskAreaPredictionEvents)
      .set({ actualPaths: paths, actualRecordedAt: new Date() })
      .where(and(
        eq(taskAreaPredictionEvents.taskId, taskId),
        isNull(taskAreaPredictionEvents.actualPaths),
      ));
  } catch (err) {
    console.warn('[task-area] failed to record outcome:', (err as Error)?.message ?? err);
  }
}
