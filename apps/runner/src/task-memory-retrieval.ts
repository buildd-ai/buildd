/**
 * Which memories go in the `### Relevant to This Task` block, and why.
 *
 * Two ordered steps, not one blended query:
 *
 *  1. **Declared paths.** `tasks.path_manifest` against `memories.files`. This
 *     is the strongest signal available and it was going unused on both sides.
 *  2. **Title.** The previous behaviour, kept as a fallback.
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

/** Which step produced the injected memories. */
export type TaskMemoryDerivedBy =
  /** Step 1 hit: the task's declared paths overlapped a memory's files. */
  | 'path_manifest'
  /** Step 2 hit: the task title matched. */
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
  /**
   * `tasks.path_manifest`. Typed as unknown because the column is jsonb with
   * only a compile-time `$type` assertion — its runtime shape is an assumption
   * about every writer, and this runs inside a claim that has already committed
   * worker rows.
   */
  pathManifest?: unknown;
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

  if (scopePaths.length === 0 && !title) {
    return { results: [], derivedBy: 'not_attempted', scopePaths, pathScopeMissed: false };
  }

  let pathScopeMissed = false;
  if (scopePaths.length > 0) {
    const byPath = await client
      .searchObservations(task.workspaceId, '', limit, scopePaths)
      .catch(() => [] as TaskMemoryObservation[]);
    if (byPath.length > 0) {
      return { results: byPath, derivedBy: 'path_manifest', scopePaths, pathScopeMissed: false };
    }
    pathScopeMissed = true;
  }

  if (title) {
    const byTitle = await client
      .searchObservations(task.workspaceId, title, limit)
      .catch(() => [] as TaskMemoryObservation[]);
    if (byTitle.length > 0) {
      return { results: byTitle, derivedBy: 'title_phrase', scopePaths, pathScopeMissed };
    }
  }

  return { results: [], derivedBy: 'no_match', scopePaths, pathScopeMissed };
}
