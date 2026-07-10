/**
 * Path-overlap utilities for task serialization.
 *
 * When two tasks declare pathManifests that share one or more paths, running
 * them in parallel causes them to edit the same files and produce conflicting
 * PRs (the root cause of the mcp-oauth.ts incident: PRs #1126 / #1129).
 *
 * These helpers are pure functions with no DB access — the callers
 * (task creation API, claim route) own the DB queries and wire them in.
 */

/**
 * Returns true if the two path manifests share at least one entry.
 *
 * Matching rules (in order):
 *  1. Exact match: `apps/web/src/lib/foo.ts` in both arrays.
 *  2. Prefix match: one path is a directory prefix of the other
 *     (`apps/web/src/lib` overlaps `apps/web/src/lib/foo.ts`).
 *
 * Globs are NOT evaluated — they are compared as literal strings.  The common
 * case is exact file paths extracted from task descriptions; prefix matching
 * covers tasks that declare a whole directory.
 */
export function pathsOverlap(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;

  const normalize = (p: string) => p.replace(/\/+$/, ''); // strip trailing slashes
  const na = a.map(normalize);
  const nb = b.map(normalize);

  const setB = new Set(nb);
  for (const pa of na) {
    // Exact match
    if (setB.has(pa)) return true;

    // Prefix match: pa is a directory that contains one of b's paths,
    // or one of b's directories contains pa.
    for (const pb of nb) {
      if (pb.startsWith(pa + '/') || pa.startsWith(pb + '/')) return true;
    }
  }
  return false;
}

export interface ManifestTask {
  id: string;
  pathManifest?: string[] | null;
  dependsOn?: string[] | null;
}

export interface OverlapEdge {
  taskId: string;
  /** Task IDs that must complete before taskId is claimable (due to path overlap). */
  addDependsOn: string[];
}

/**
 * Given a batch of tasks (typically all newly created for a mission), compute
 * the additional `dependsOn` edges needed to serialize tasks that share paths.
 *
 * Algorithm:
 *  - Process tasks in the order they appear in the array (preserves creation order).
 *  - For each task B at position i, find all tasks A at position j < i whose
 *    pathManifest overlaps with B's.  A must run before B.
 *  - Also respect already-declared dependsOn edges — do not add edges that are
 *    already implied by transitivity (simple de-dup by direct task ID is fine;
 *    we don't need a full transitive-reduction here).
 *  - Tasks without a pathManifest are skipped (not constrained).
 *
 * Returns only entries that have at least one edge to add.
 */
export function serializeBatchByManifest(tasks: ManifestTask[]): OverlapEdge[] {
  const edges: OverlapEdge[] = [];

  for (let i = 1; i < tasks.length; i++) {
    const taskB = tasks[i];
    if (!taskB.pathManifest?.length) continue;

    const existing = new Set<string>(taskB.dependsOn ?? []);
    const toAdd: string[] = [];

    for (let j = 0; j < i; j++) {
      const taskA = tasks[j];
      if (!taskA.pathManifest?.length) continue;
      if (existing.has(taskA.id)) continue; // already declared

      if (pathsOverlap(taskA.pathManifest, taskB.pathManifest)) {
        toAdd.push(taskA.id);
        existing.add(taskA.id); // prevent duplicates within toAdd
      }
    }

    if (toAdd.length > 0) {
      edges.push({ taskId: taskB.id, addDependsOn: toAdd });
    }
  }

  return edges;
}

/**
 * Check whether a candidate task (identified by its pathManifest) is blocked
 * by an open PR whose owning task also declares overlapping paths.
 *
 * Returns the first blocking PR number (or URL) if found, null otherwise.
 * Called by the claim route as a cheap backstop — no GitHub API required.
 */
export function findBlockingPr(
  candidateManifest: string[],
  openPrTasks: Array<{
    pathManifest?: string[] | null;
    prNumber?: number | null;
    prUrl?: string | null;
  }>,
): { prNumber: number | null; prUrl: string | null } | null {
  if (candidateManifest.length === 0) return null;

  for (const t of openPrTasks) {
    if (!t.pathManifest?.length) continue;
    if (pathsOverlap(candidateManifest, t.pathManifest)) {
      return { prNumber: t.prNumber ?? null, prUrl: t.prUrl ?? null };
    }
  }
  return null;
}
