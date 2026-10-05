/**
 * Prompt-context injection — everything that rides the
 * `resolvedContextProviders` rail into the agent's prompt at claim time.
 *
 * ORDER MATTERS. The three attach functions append to the same array and the
 * runner concatenates it in order, so the call sequence in route.ts is the
 * contract: external providers, then retrieved knowledge, then subject-anchor
 * prior work. Every one is best-effort — a failure attaches nothing and the
 * claim still succeeds.
 */
import type { ClaimTasksResponse } from '@buildd/shared';
import {
  buildEntityCatalogContext,
  buildClusteredKnowledgeContext,
  buildFanOutAssembly,
  buildKnowledgeContext,
  logContextAssembly,
  type ClusterKeys,
} from '@/lib/knowledge-context';
import type { ContextAssembly } from '@buildd/core/retrieval-clusters';
import { selectExecCluster } from '@buildd/core/retrieval-clusters';
import { REPO_WIDE_SENTINEL } from '@buildd/core/path-overlap';
import { componentTablePaths, extractExcerptPaths } from '@buildd/core/friction-manifest';
import { resolveSubjectPolicy } from '@buildd/core/subject-anchor-observe';
import { resolveLinkedDocsWorkspaces, type LinkedDocsAccount } from '@/lib/linked-knowledge';
import { findDispatchDiscrepancyBlock } from '@buildd/core/spec-discrepancy-dispatch';
import {
  TASK_AREA_CONTEXT_KEY,
  TASK_AREA_TREATMENT_ARM,
  renderTaskAreaBlock,
  type TaskAreaContextHint,
} from '@buildd/core/task-area-prediction';
import {
  loadTaskAreaConfig,
  predictTaskArea,
  recordTaskAreaPrediction,
  type TaskAreaPrediction,
} from '@buildd/core/task-area-prediction-source';
import { PgVectorStore, getVoyageEmbedder } from '@buildd/core/knowledge-store';
import { memoryScopeFor } from '@buildd/core/memory-hit-scope';
import {
  isMemoryIndexEnabled,
  memoryIndexTokenBudget,
  MEMORY_INDEX_CONTEXT_KEY,
  type MemoryIndexEntry,
} from '@buildd/core/memory-claim-index';
import { buildSubjectPriorWork } from './subject-prior-work';
import { CLAIM_FANOUT_CONCURRENCY, mapWithConcurrency } from './concurrency-limit';

/** The claim-candidate rows these blocks look tasks up in. */
type ClaimedTask = { id: string; title: string; workspaceId: string };

/** Prefixes stripped from a title before it seeds the knowledge-context embedding query. */
const SEED_TITLE_PREFIX_RE = /^\[(?:builder\s+·\s+after\s+(?:review|conflict|CI) #\d+|reviewer #\d+|CI Retry #\d+|reviewer retry #\d+|reviewer|friction)\]\s*/i;

/** Description chars kept in the seed query — a full CI-retry/friction body would dominate the embedding. */
const SEED_DESCRIPTION_MAX_CHARS = 600;

/**
 * Normalise a task's title/description into the text embedded for claim-time
 * knowledge retrieval (spec f14a3d02 §1).
 *
 * Strips templated prefixes including:
 * - New format: [builder · after review #N], [builder · after conflict #N], [builder · after CI #N], [reviewer #N]
 * - Legacy format: [CI Retry #N], [reviewer], [reviewer retry #N]
 * - Other: [friction]
 * These carry no semantic content but would otherwise dominate the embedding, and caps
 * the description so a long templated body doesn't drown out the title. Repeats the prefix
 * strip since a retried reviewer task can stack more than one prefix (e.g. "[builder · after CI #2] [reviewer] Fix the sandbox").
 */
function buildSeedQuery(title: string, description: string | null | undefined): string {
  let normalizedTitle = title ?? '';
  let stripped: string;
  do {
    stripped = normalizedTitle.replace(SEED_TITLE_PREFIX_RE, '');
    if (stripped === normalizedTitle) break;
    normalizedTitle = stripped;
  } while (true);
  normalizedTitle = normalizedTitle.trim();

  const truncatedDescription = (description ?? '').slice(0, SEED_DESCRIPTION_MAX_CHARS);
  return [normalizedTitle, truncatedDescription].filter(Boolean).join('\n');
}

/**
 * Concrete search paths from a task's pathManifest, for the knowledge-store
 * path lookup ("Recent work on relevant paths"). `path_manifest` is jsonb with
 * only a compile-time $type assertion, so a non-array or non-string entry is a
 * live possibility, not a hypothetical — mirrors the guard in
 * deriveErrorClusterKeys above. The repo-wide sentinel `'**'` records that scope
 * was never declared and would otherwise search for a file literally named `**`.
 */
function manifestPaths(pathManifest: unknown): string[] {
  if (!Array.isArray(pathManifest)) return [];
  return pathManifest.filter(
    (p): p is string => typeof p === 'string' && p.trim() !== '' && p !== REPO_WIDE_SENTINEL,
  );
}

/**
 * Derive the search keys for an error-subject cluster, deterministically.
 *
 * Paths come from `tasks.path_manifest` when it holds anything concrete. When it
 * does not, they are extracted from the error excerpt by `inferFrictionManifest`
 * — the same extractor POST /api/tasks already runs to populate the column, so
 * the two paths agree by construction instead of by coincidence. The `'**'`
 * sentinel is not a path: it records that the filer never declared scope, and
 * keying a query on it would retrieve the whole repo.
 *
 * The two sources are reported separately in the assembly record, because
 * "read off the column" and "regexed out of an error line" are different claims
 * about where the query came from.
 */
function deriveErrorClusterKeys(task: {
  subjectErrorSignature?: string | null;
  pathManifest?: string[] | null;
  context?: Record<string, unknown> | null;
  description?: string | null;
}): ClusterKeys {
  const signature = task.subjectErrorSignature ?? null;
  // `path_manifest` is jsonb with only a compile-time $type assertion, so the
  // array shape is an assumption about every writer rather than a guarantee.
  // This function runs inside a claim that has already committed worker rows.
  const manifest = Array.isArray(task.pathManifest) ? task.pathManifest : [];
  const declared = manifest.filter(p => typeof p === 'string' && p.trim() && p !== REPO_WIDE_SENTINEL);
  if (declared.length > 0) {
    return { signature, paths: declared, pathsDerivedBy: 'path_manifest' };
  }

  const excerpt = typeof task.context?.frictionExcerpt === 'string'
    ? task.context.frictionExcerpt
    : task.description ?? '';
  if (!signature || !excerpt) return { signature, paths: [] };

  // inferFrictionManifest returns EITHER regex matches from the excerpt OR a
  // static per-slug component guess. Reporting both as `regex_path_extract`
  // would make the obvious cohort question — did a path the error actually
  // named beat a hardcoded guess — unanswerable, so the two are distinguished
  // by re-running the extraction and checking which branch produced the answer.
  const named = extractExcerptPaths(excerpt);
  if (named.length > 0) {
    return { signature, paths: named, pathsDerivedBy: 'regex_path_extract' };
  }
  const guessed = componentTablePaths(signature);
  if (guessed.length > 0) {
    return { signature, paths: guessed, pathsDerivedBy: 'pattern_component_table' };
  }
  return { signature, paths: [] };
}

/**
 * Append one context block to both rails the runner reads: the response field
 * and the task context it is mirrored into.
 *
 * Shared by the knowledge and subject-prior-work blocks, which carried
 * identical copies. The external-provider block below deliberately does NOT
 * use this — it runs first and assigns, and it only mirrors into an existing
 * task context rather than creating one.
 */
export function appendContextBlock(cw: ClaimTasksResponse['workers'][number], block: string): void {
  (cw as any).resolvedContextProviders = [...((cw as any).resolvedContextProviders ?? []), block];
  const taskObj = cw.task as any;
  if (taskObj) {
    taskObj.context = taskObj.context ?? {};
    taskObj.context.resolvedContextProviders = [...(taskObj.context.resolvedContextProviders ?? []), block];
  }
}

/**
 * Where a computed block goes. Defaults to {@link appendContextBlock} so every
 * existing caller is unaffected; ./prompt-context-pipeline passes a buffering
 * sink instead so several of these attach functions can compute concurrently
 * while still landing on the rail in the fixed contract order — see that
 * file for why the order can't just be "whoever resolves first".
 */
export type ContextBlockSink = (cw: ClaimTasksResponse['workers'][number], block: string) => void;

/**
 * Fetch the task's declared external context providers (5s timeout each) and
 * attach the ones that answered. Failures are logged, never fatal.
 */
export async function attachExternalContextProviders(
  claimedWorkers: ClaimTasksResponse['workers'],
  claimedTasks: readonly ClaimedTask[],
): Promise<void> {
  for (const cw of claimedWorkers) {
    const task = claimedTasks.find(t => t.id === cw.taskId);
    const ctx = (task as any)?.context as { contextProviders?: Array<{ url: string; headers?: Record<string, string>; label?: string }> } | undefined;
    if (!ctx?.contextProviders?.length) continue;

    const results = await Promise.allSettled(
      ctx.contextProviders.map(async (provider) => {
        const res = await fetch(provider.url, {
          headers: { ...provider.headers, "Accept": "text/markdown, text/plain" },
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error(`Context provider ${provider.url} returned ${res.status}`);
        const body = await res.text();
        return provider.label ? `## ${provider.label}\n\n${body}` : body;
      }),
    );
    const resolved = results
      .filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled")
      .map(r => r.value);

    if (resolved.length > 0) {
      (cw as any).resolvedContextProviders = resolved;
      // Also merge into task context so runner can read it from task.context
      const taskObj = cw.task as any;
      if (taskObj?.context) {
        taskObj.context.resolvedContextProviders = resolved;
      }
    }

    // Log failures for debugging
    for (const r of results) {
      if (r.status === "rejected") {
        console.warn("[claim] context provider failed:", r.reason?.message || r.reason);
      }
    }
  }
}

/**
 * Predict each claimed task's file area from what similar completed tasks
 * actually touched, and record it on the experiment's own rail.
 *
 * Runs BEFORE the context blocks because `attachKnowledgeContext` uses the
 * prediction as its path filter when the task declared no manifest — that is
 * one of the two uses the prediction exists for (the other being the scope
 * hint `attachTaskAreaScope` renders).
 *
 * Every arm is predicted and recorded; only the treatment arm's prediction is
 * allowed to change retrieval. See @buildd/core/task-area-prediction for why
 * measuring the control too is the point rather than waste.
 *
 * Best-effort throughout: a claim must never fail because a prediction could
 * not be computed. Returns an empty map when the experiment is disabled.
 */
export async function predictTaskAreas(
  claimedTasks: readonly ClaimedTask[],
): Promise<Map<string, TaskAreaPrediction>> {
  const out = new Map<string, TaskAreaPrediction>();
  if (claimedTasks.length === 0) return out;

  try {
    const config = await loadTaskAreaConfig();
    if (!config.enabled) return out;

    // No reranker: predictTaskArea only needs neighbour task ids + scores to
    // union their paths (see findNeighbourTasks/unionNeighbourPaths), so the
    // cross-encoder rerank step is pure overhead here — a store built without
    // one skips it entirely (PgVectorStore.query no-ops rerank when `reranker`
    // is null).
    const store = new PgVectorStore(getVoyageEmbedder());
    // One task's prediction (a Voyage query plus a neighbour-paths lookup) does
    // not depend on any other task's — the loop body's only writes are to this
    // task's own `out` entry and its own DB row, so running the batch
    // concurrently instead of one task at a time is safe. Capped so a claim
    // with a deep candidate pool cannot fan out unbounded Neon queries.
    await mapWithConcurrency(claimedTasks, CLAIM_FANOUT_CONCURRENCY, async (task) => {
      const prediction = await predictTaskArea(store, {
        taskId: task.id,
        workspaceId: task.workspaceId,
        title: task.title,
        description: (task as any).description,
      }, config).catch(err => {
        console.warn('[claim] task-area prediction failed:', err?.message ?? err);
        return null;
      });
      if (!prediction) return;
      out.set(task.id, prediction);
      await recordTaskAreaPrediction(prediction);
    });
  } catch (err) {
    console.warn('[claim] task-area prediction unavailable:', (err as Error)?.message ?? err);
  }
  return out;
}

/**
 * The hint a treatment-arm task carries, or null.
 *
 * Null for the control arm and for an empty prediction, so every consumer gets
 * today's behaviour by simply finding nothing here.
 */
function taskAreaHint(prediction: TaskAreaPrediction | undefined): TaskAreaContextHint | null {
  if (!prediction) return null;
  if (prediction.arm !== TASK_AREA_TREATMENT_ARM) return null;
  if (prediction.predictedPaths.length === 0) return null;
  return {
    arm: TASK_AREA_TREATMENT_ARM,
    policyVersion: prediction.policyVersion,
    paths: prediction.predictedPaths,
    source: prediction.config.pathSource,
  };
}

/**
 * Inject related prior work into the agent's prompt — the worker analog of the
 * orchestrator's plan-time injection.
 *
 * Best-effort: buildKnowledgeContext returns [] on any failure.
 */
export async function attachKnowledgeContext(
  claimedWorkers: ClaimTasksResponse['workers'],
  claimedTasks: readonly ClaimedTask[],
  predictions?: ReadonlyMap<string, TaskAreaPrediction>,
  handoffExcludedSources?: Set<string>,
  sink: ContextBlockSink = appendContextBlock,
  /** Caller of the claim; linked docs workspaces are authorised against it. */
  account?: LinkedDocsAccount | null,
): Promise<void> {
  // Independent per worker — each iteration only reads the shared predictions
  // map and excluded-sources set (both fully populated by the time this runs)
  // and only writes its own `cw`, so the batch can run concurrently instead of
  // one Voyage embed+rerank round trip at a time. Capped for the same reason
  // as predictTaskAreas' batch — see ./concurrency-limit.
  await mapWithConcurrency(claimedWorkers, CLAIM_FANOUT_CONCURRENCY, async (cw) => {
    // task.context is client-writable jsonb, so a memoryIndex already on it is
    // not the claim route's and must not reach the runner or the claim_task
    // reply as if it were. Cleared on every claim, set again below only when
    // the flag is on.
    const ctxObj = (cw.task as any)?.context;
    if (ctxObj && typeof ctxObj === 'object' && MEMORY_INDEX_CONTEXT_KEY in ctxObj) {
      delete ctxObj[MEMORY_INDEX_CONTEXT_KEY];
    }
    const task = claimedTasks.find(t => t.id === cw.taskId);
    if (!task) return;
    const goal = [task.title, (task as any).description].filter(Boolean).join('\n');
    const teamId = (task as any).workspace?.teamId;
    const sensitive = (task as any).workspace?.dataClass === 'sensitive';

    // Cluster selection. Returns null for every trigger with no registered
    // recipe, which is the default and is a no-op — the fan-out below is
    // reached unchanged. Steps are priorities, not exclusions: a recipe that
    // yields nothing renderable also falls through to the fan-out, and that
    // escalation is recorded as fallbackFired rather than left invisible.
    const recipe = selectExecCluster(task as any);
    const trigger = {
      layer: 'exec' as const,
      subjectKind: (task as any).subjectKind ?? null,
      signature: (task as any).subjectErrorSignature ?? null,
    };
    const chain = {
      taskId: task.id,
      workerId: cw.id,
      missionId: (task as any).missionId ?? null,
    };

    // Resolved once for both the recipe and the fan-out below. Each used to
    // resolve it itself, so a recipe that came back empty paid for the two
    // workspace lookups twice on the claim path.
    const memoryScope = teamId && !sensitive
      ? await memoryScopeFor(undefined, task.workspaceId, teamId)
      : null;

    // Index injection (@buildd/core/memory-claim-index), per workspace flag.
    // Off: no option is passed and the block is what it always was. On: the
    // entries the block showed are mirrored onto the claim response's
    // task.context (never the tasks row), where the runner and the claim_task
    // reply read them to dedupe against and to charge the same budget.
    const wsGitConfig = (task as any).workspace?.gitConfig;
    let indexEntries: MemoryIndexEntry[] = [];
    const memoryIndex = isMemoryIndexEnabled(wsGitConfig)
      ? { budgetTokens: memoryIndexTokenBudget(wsGitConfig), onEntries: (e: MemoryIndexEntry[]) => { indexEntries = e; } }
      : undefined;

    let parts: string[] = [];
    let recipeAssembly: ContextAssembly | null = null;
    if (recipe) {
      const keys = deriveErrorClusterKeys(task as any);
      const { parts: clustered, assembly } = await buildClusteredKnowledgeContext({
        recipe,
        keys,
        workspaceId: task.workspaceId,
        teamId,
        trigger,
        chain,
        opts: { sensitive, excludedSourceIds: handoffExcludedSources, memoryScope, ...(memoryIndex ? { memoryIndex } : {}) },
      });
      parts = clustered;
      recipeAssembly = assembly;
    }

    if (parts.length === 0) {
      const seedQuery = buildSeedQuery(task.title, (task as any).description);
      // A declared manifest always wins: it is an author's statement about this
      // task, where the prediction is a union over other tasks' diffs. The
      // prediction fills the ~90% of tasks that declare nothing, and only for
      // the treatment arm — `taskAreaHint` returns null otherwise, leaving the
      // control's query byte-identical to what it was before this experiment.
      const declared = manifestPaths((task as any).pathManifest);
      const hint = declared.length === 0 ? taskAreaHint(predictions?.get(task.id)) : null;
      const paths = declared.length > 0 ? declared : (hint?.paths ?? []);
      const linkedDocsWorkspaceIds = sensitive
        ? []
        : await resolveLinkedDocsWorkspaces({ workspaceId: task.workspaceId, account });
      parts = await buildKnowledgeContext(seedQuery, task.workspaceId, teamId, undefined, {
        sensitive,
        ...(linkedDocsWorkspaceIds.length > 0 ? { linkedDocsWorkspaceIds } : {}),
        paths,
        excludedSourceIds: handoffExcludedSources,
        memoryScope,
        caller: 'claim_context',
        attribution: { taskId: task.id, workerId: cw.id },
        ...(memoryIndex ? { memoryIndex } : {}),
      });
    }

    if (memoryIndex) {
      const taskObj = cw.task as any;
      if (taskObj) {
        taskObj.context = taskObj.context ?? {};
        taskObj.context[MEMORY_INDEX_CONTEXT_KEY] = indexEntries;
      }
    }

    // One record per claim, always — the recipe's when it served the request,
    // the fan-out's otherwise. The fan-out record is the denominator: without
    // it, no recipe lines is indistinguishable from no eligible tasks.
    logContextAssembly(recipeAssembly ?? buildFanOutAssembly({
      workspaceId: task.workspaceId,
      teamId,
      trigger,
      chain,
      rendered: parts.length > 0,
    }));
    // Known-entities catalog (§8.4): canonical entity names for the task's
    // likely files so agents don't invent loose refs. Best-effort — returns ''
    // on any failure; the extra .catch is belt-and-braces (claim must not 500).
    const entityCatalog = await buildEntityCatalogContext(goal, task.workspaceId).catch(() => '');
    if (entityCatalog) parts.push(entityCatalog);
    if (parts.length === 0) return;

    sink(cw, parts.join('\n'));
  });
}

/**
 * Subject-anchor prior work injection (§7 of docs/design/task-subject-anchors.md).
 *
 * For tasks anchored to a subject PR, error, or mission, surface existing
 * sibling tasks so the agent doesn't re-discover or re-implement work already
 * in flight. Gated by priorWorkInjection in the workspace subjectPolicy
 * (default: true). Best-effort: failures are logged and the claim still succeeds.
 */
export async function attachSubjectPriorWork(
  claimedWorkers: ClaimTasksResponse['workers'],
  claimedTasks: readonly ClaimedTask[],
  sink: ContextBlockSink = appendContextBlock,
): Promise<void> {
  for (const cw of claimedWorkers) {
    const task = claimedTasks.find(t => t.id === cw.taskId);
    if (!task || !(task as any).subjectKind) continue;

    const wsGitConfig = (task as any).workspace?.gitConfig;
    const subjectPolicy = resolveSubjectPolicy(wsGitConfig?.subjectPolicy);

    const priorWork = await buildSubjectPriorWork(task as any, subjectPolicy).catch(err => {
      console.warn('[claim] subject-prior-work injection failed:', err);
      return null;
    });
    if (!priorWork) continue;

    sink(cw, priorWork);
  }
}

/**
 * Predicted-file-area injection — the second of the prediction's two uses.
 *
 * Appends the advisory scope block to the prompt rail and mirrors the hint onto
 * `task.context.predictedTaskArea`, where the runner reads it as the file
 * filter for its own memory retrieval (`apps/runner/src/task-memory-retrieval.ts`).
 *
 * The mirror is on the in-memory claim RESPONSE only. Nothing here writes to
 * the `tasks` row, and in particular nothing writes `tasks.path_manifest` —
 * that column drives path-overlap serialisation and inferred `dependsOn`, and a
 * prediction landing in it would defer or serialise unrelated work on a guess.
 *
 * Runs last on the rail so the predicted area reads as a closing hint rather
 * than as the frame for the retrieved knowledge above it.
 */
export async function attachTaskAreaScope(
  claimedWorkers: ClaimTasksResponse['workers'],
  claimedTasks: readonly ClaimedTask[],
  predictions: ReadonlyMap<string, TaskAreaPrediction>,
): Promise<void> {
  if (predictions.size === 0) return;
  for (const cw of claimedWorkers) {
    const task = claimedTasks.find(t => t.id === cw.taskId);
    if (!task) continue;
    const hint = taskAreaHint(predictions.get(task.id));
    if (!hint) continue;

    const taskObj = cw.task as any;
    if (taskObj) {
      taskObj.context = taskObj.context ?? {};
      taskObj.context[TASK_AREA_CONTEXT_KEY] = hint;
    }
    appendContextBlock(cw, renderTaskAreaBlock(hint));
  }
}

/**
 * Discrepancy-ledger dispatch injection (§11 of docs/design/spec-conformance.md).
 *
 * For a claimed task whose `pathManifest` intersects an open ledger row's spec
 * doc or resolved code path, surface the exact claim the worker is expected to
 * either satisfy or update. Sourced from the ledger's already-computed rows —
 * see spec-discrepancy-dispatch.ts for why this never re-runs the checker at
 * claim time. Best-effort: a failure attaches nothing and the claim still
 * succeeds, same as the other two injections on this rail.
 */
export async function attachDiscrepancyContext(
  claimedWorkers: ClaimTasksResponse['workers'],
  claimedTasks: readonly ClaimedTask[],
  sink: ContextBlockSink = appendContextBlock,
): Promise<void> {
  for (const cw of claimedWorkers) {
    const task = claimedTasks.find(t => t.id === cw.taskId);
    if (!task) continue;
    const pathManifest = Array.isArray((task as any).pathManifest) ? (task as any).pathManifest as string[] : null;

    const block = await findDispatchDiscrepancyBlock({ workspaceId: task.workspaceId, pathManifest }).catch(err => {
      console.warn('[claim] discrepancy dispatch injection failed:', err);
      return null;
    });
    if (!block) continue;

    sink(cw, block);
  }
}
