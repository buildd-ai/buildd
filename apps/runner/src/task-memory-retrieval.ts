/**
 * Which memories go in the `### Relevant to This Task` block, and why.
 *
 * Two ordered steps, not one blended query:
 *
 *  1. **Declared paths.** `tasks.path_manifest` against `memories.files`. This
 *     is the strongest signal available and it was going unused on both sides.
 *  2. **Predicted area.** The union of what similar COMPLETED tasks actually
 *     touched, computed server-side at claim time and delivered on
 *     `task.context.predictedTaskArea`. Ahead of the regex because it is built
 *     from diffs that happened rather than from path-shaped tokens in prose.
 *     Present ONLY for tasks enrolled in the treatment arm of the task-area
 *     experiment — its absence is how the control arm stays byte-identical to
 *     the behaviour that shipped before it, so there is no arm logic here.
 *     See @buildd/core/task-area-prediction.
 *  3. **Inferred paths.** Only about a tenth of tasks declare a manifest, so
 *     for the rest the paths are regexed out of the task's own title and
 *     description. Weaker than a declaration — hence third, and reported
 *     separately so the steps can be compared rather than blurred. These are
 *     never persisted; see @buildd/core/task-path-inference for why writing
 *     them to `path_manifest` would be unsafe.
 *  4. **Title.** The previous behaviour, kept as a last resort.
 *
 * They are steps rather than a single OR because the store has no ranking — it
 * orders by `updated_at` — so blending them would let a weak title hit outrank
 * an exact path hit with no way to tell them apart afterwards. Running them in
 * order means a path hit wins when there is one, and `derivedBy` records which
 * step actually produced the result.
 *
 * Recording that provenance is the point. Retrieval quality is impossible to
 * reason about from a count alone: `taskMatchCount: 5` looks identical whether
 * those five came from a declared path overlap or from a title that happened to
 * share the word "the" with five recent memories. The reason is emitted by this
 * code, from what it did, and is never inferred later.
 */
import { normalizeMemoryFileScope } from '@buildd/core/memory-file-scope';
import { inferPathsFromText } from '@buildd/core/task-path-inference';
import { readTaskAreaHint } from '@buildd/core/task-area-prediction';

/** Which step produced the injected memories. */
export type TaskMemoryDerivedBy =
  /** Step 1 hit: the task's declared paths overlapped a memory's files. */
  | 'path_manifest'
  /** Step 2 hit: the predicted file area overlapped. Treatment arm only. */
  | 'predicted_area'
  /** Step 3 hit: paths regexed from the task's own text overlapped. */
  | 'inferred_paths'
  /** Step 4 hit: the task title matched. */
  | 'title_phrase'
  /** Both steps ran and neither returned anything. */
  | 'no_match'
  /** No scope and no title to search with — neither step was attempted. */
  | 'not_attempted';

export interface TaskMemoryObservation {
  id: string;
  title?: string;
  type?: string;
  files?: string[];
}

export interface TaskMemoryRetrieval {
  results: TaskMemoryObservation[];
  derivedBy: TaskMemoryDerivedBy;
  /** Concrete paths the path step used, after the sentinel and blanks are dropped. */
  scopePaths: string[];
  /** The claim-time predicted area, when this task was enrolled in the treatment arm. */
  predictedPaths: string[];
  /** Paths inferred from the task's own text, used only when none were declared. */
  inferredPaths: string[];
  /** True when a path scope existed and step 1 still returned nothing. */
  pathScopeMissed: boolean;
}

/** The narrow slice of the buildd client this needs, so tests can stub it. */
export interface ObservationSearcher {
  searchObservations(
    workspaceId: string,
    query: string,
    limit?: number,
    files?: readonly string[],
  ): Promise<TaskMemoryObservation[]>;
}

export interface TaskMemoryInput {
  workspaceId: string;
  title?: string | null;
  /** Task description, read only to infer paths when none were declared. */
  description?: string | null;
  /**
   * `tasks.path_manifest`. Typed as unknown because the column is jsonb with
   * only a compile-time `$type` assertion — its runtime shape is an assumption
   * about every writer, and this runs inside a claim that has already committed
   * worker rows.
   */
  pathManifest?: unknown;
  /**
   * `task.context` from the claim payload. Read ONLY for
   * `predictedTaskArea` — the advisory file-area hint the claim route mirrors
   * in for treatment-arm tasks. Typed unknown for the same reason as
   * `pathManifest`: it is jsonb, and `readTaskAreaHint` validates every field
   * rather than asserting a shape.
   */
  context?: unknown;
}

/**
 * Retrieve task-relevant memories, best-effort.
 *
 * Never throws: a retrieval failure must degrade the prompt, not fail the
 * session. A step that throws is treated as a miss and the next step still
 * runs, so a transient error on the path query does not also suppress the
 * title fallback.
 */
export async function retrieveTaskMemory(
  client: ObservationSearcher,
  task: TaskMemoryInput,
  limit = 5,
): Promise<TaskMemoryRetrieval> {
  const scopePaths = normalizeMemoryFileScope(
    Array.isArray(task.pathManifest) ? task.pathManifest : undefined,
  );
  const title = (task.title ?? '').trim();

  // Both weaker path sources are computed only when nothing was declared: a
  // declaration is strictly better evidence, and widening a good scope with a
  // guess would just add noise to it.
  const predictedPaths = scopePaths.length === 0
    ? normalizeMemoryFileScope(readTaskAreaHint(task.context)?.paths)
    : [];
  const inferredPaths = scopePaths.length === 0
    ? normalizeMemoryFileScope(inferPathsFromText(task.title, task.description))
    : [];

  if (scopePaths.length === 0 && predictedPaths.length === 0 && inferredPaths.length === 0 && !title) {
    return { results: [], derivedBy: 'not_attempted', scopePaths, predictedPaths, inferredPaths, pathScopeMissed: false };
  }

  const byFiles = async (paths: string[]) => client
    .searchObservations(task.workspaceId, '', limit, paths)
    .catch(() => [] as TaskMemoryObservation[]);

  let pathScopeMissed = false;
  if (scopePaths.length > 0) {
    const hit = await byFiles(scopePaths);
    if (hit.length > 0) {
      return { results: hit, derivedBy: 'path_manifest', scopePaths, predictedPaths, inferredPaths, pathScopeMissed: false };
    }
    pathScopeMissed = true;
  }

  if (predictedPaths.length > 0) {
    const hit = await byFiles(predictedPaths);
    if (hit.length > 0) {
      return { results: hit, derivedBy: 'predicted_area', scopePaths, predictedPaths, inferredPaths, pathScopeMissed };
    }
  }

  if (inferredPaths.length > 0) {
    const hit = await byFiles(inferredPaths);
    if (hit.length > 0) {
      return { results: hit, derivedBy: 'inferred_paths', scopePaths, predictedPaths, inferredPaths, pathScopeMissed };
    }
  }

  if (title) {
    const byTitle = await client
      .searchObservations(task.workspaceId, title, limit)
      .catch(() => [] as TaskMemoryObservation[]);
    if (byTitle.length > 0) {
      return { results: byTitle, derivedBy: 'title_phrase', scopePaths, predictedPaths, inferredPaths, pathScopeMissed };
    }
  }

  return { results: [], derivedBy: 'no_match', scopePaths, predictedPaths, inferredPaths, pathScopeMissed };
}
