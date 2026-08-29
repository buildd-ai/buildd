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
 * Repo-wide sentinel manifest entry.
 *
 * Written by the mission-task default in POST /api/tasks when a task belongs to
 * a mission but declares no paths. It means "this task never declared its
 * scope" — NOT "this task touches every file in the repo".
 */
export const REPO_WIDE_SENTINEL = '**';

/**
 * True when a manifest carries the repo-wide sentinel, i.e. the task never
 * declared a concrete scope.
 *
 * Such a manifest is **advisory only**. It must never:
 *  - produce a stored `dependsOn` edge (authoring time), or
 *  - block / be blocked by another task's paths (claim time).
 *
 * Both rules are enforced through this one predicate — `shouldSerializeByManifest`
 * (authoring) and `findBlockingPr` (claim) call it, so the two cannot drift.
 * Rationale: a stored `dependsOn` edge blocks until the upstream task is
 * `completed` AND its PR is `merged` (see workers/claim/deps-gate.ts), whereas a
 * path conflict is a short mutex. Minting hard edges from an undeclared scope
 * turned creation-order FIFO into a permanent dependency graph.
 */
export function isAdvisoryManifest(manifest: string[] | null | undefined): boolean {
  return !!manifest && manifest.includes(REPO_WIDE_SENTINEL);
}

/**
 * True when a task never declared a file scope at all: no manifest, an empty
 * manifest, or the repo-wide sentinel.
 *
 * A STRICT SUPERSET of `isAdvisoryManifest`, and deliberately a separate
 * predicate rather than a widening of it, because the two answer different
 * questions and the existing callers need the narrow one:
 *
 *  - `findBlockingPr` / `shouldSerializeByManifest` treat an empty manifest as
 *    "nothing to compare" and bail before the sentinel check — same verdict
 *    either way, but the early return is the load-bearing part.
 *  - the wildcard rejections in `PUT /api/tasks/[id]/path-claim` and the
 *    `check_path_claim` MCP tool emit a sentinel-specific 400; an empty `paths`
 *    array is already rejected upstream with its own message and must not start
 *    reporting itself as a wildcard claim.
 *  - `renderManifestGuidance` (apps/web/src/lib/reviewer.ts) has separate
 *    branches for "sentinel" and "no manifest" with different prompt text;
 *    widening `isAdvisoryManifest` would make the second branch dead code.
 *
 * The one caller that needs the wide reading is the claim loop's
 * advisory-manifest serialization guard (`/api/workers/claim`): it asks "did
 * this task declare a scope?", and two tasks in one mission that both answer
 * "no" collide on the same files whether the undeclared-ness is spelled `['**']`
 * or `null`. Tasks predating the `['**']` mission default, and any task created
 * without a manifest, are `null` — so the sentinel-only reading let the exact
 * collision the guard exists to prevent in through the front door.
 */
export function declaresNoScope(manifest: string[] | null | undefined): boolean {
  return !manifest || manifest.length === 0 || manifest.includes(REPO_WIDE_SENTINEL);
}

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

  // '**' is a repo-wide sentinel that overlaps with every path.
  // NOTE: this is deliberately a *spatial* answer ("could these touch the same
  // file?"), not a policy answer. Callers that decide whether to create a
  // dependency edge must use shouldSerializeByManifest() instead, which treats
  // the sentinel as advisory. Other callers (path_claims conflict detection in
  // packages/core/path-claim.ts, the claim-route layer-2 backstop, the
  // path-claim route, the check_path_claim MCP tool) rely on this spatial
  // reading and reject/skip '**' themselves — so the sentinel rule stays here.
  if (a.includes(REPO_WIDE_SENTINEL) || b.includes(REPO_WIDE_SENTINEL)) return true;

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

/**
 * Authoring-time predicate: should an auto-inferred `dependsOn` edge be stored
 * between two tasks based on their path manifests?
 *
 * TRUE only when both manifests declare concrete scope and those concrete paths
 * genuinely overlap. A repo-wide sentinel on *either* side yields FALSE — see
 * `isAdvisoryManifest`. This is the exact complement of `findBlockingPr`'s
 * runtime rule (asserted by a cross-check test in
 * packages/core/__tests__/path-overlap.test.ts).
 *
 * Callers: the auto-dependsOn pass in POST /api/tasks and the same pass in
 * apps/web/src/lib/conflict-retry.ts. Explicit caller-supplied `dependsOn` is
 * never affected — only inferred edges.
 */
export function shouldSerializeByManifest(
  a: string[] | null | undefined,
  b: string[] | null | undefined,
): boolean {
  if (!a?.length || !b?.length) return false;
  if (isAdvisoryManifest(a) || isAdvisoryManifest(b)) return false;
  return pathsOverlap(a, b);
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

  // The candidate hasn't declared specific scope — advisory only, so don't block
  // a broad task on other tasks' specific paths. Same predicate the authoring
  // pass uses (shouldSerializeByManifest), so the two gates cannot diverge.
  if (isAdvisoryManifest(candidateManifest)) return null;

  for (const t of openPrTasks) {
    if (!t.pathManifest?.length) continue;
    // A sibling with an undeclared scope is also advisory — it cannot
    // legitimately claim to block all paths.
    if (isAdvisoryManifest(t.pathManifest)) continue;
    if (pathsOverlap(candidateManifest, t.pathManifest)) {
      return { prNumber: t.prNumber ?? null, prUrl: t.prUrl ?? null };
    }
  }
  return null;
}
