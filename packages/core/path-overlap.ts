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
 * Strip any trailing slash(es) from a path for consistent comparison.
 * Examples: `'packages/core/'` → `'packages/core'`, `'foo'` → `'foo'`.
 */
export function stripTrailingSep(path: string): string {
  return path.replace(/\/+$/, '');
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

  const na = a.map(stripTrailingSep);
  const nb = b.map(stripTrailingSep);

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
 * The paths two touch sets actually share — the same exact/prefix rule
 * `pathsOverlap` answers yes/no with, returning the evidence instead.
 *
 * Used by the `explain` read to name WHICH files two branches collide on, so a
 * conflicted PR reports "these three files, touched by that merged PR" rather
 * than "conflicts with base". The repo-wide sentinel is deliberately NOT
 * expanded here: `['**']` means "scope undeclared", and reporting it as a
 * conflicting path would name a file nobody touched.
 *
 * Returns entries from `a`, deduplicated, in `a`'s order.
 */
export function intersectPaths(a: string[], b: string[]): string[] {
  if (a.length === 0 || b.length === 0) return [];

  const na = a.filter(p => p !== REPO_WIDE_SENTINEL).map(stripTrailingSep);
  const nb = b.filter(p => p !== REPO_WIDE_SENTINEL).map(stripTrailingSep);
  if (na.length === 0 || nb.length === 0) return [];

  const setB = new Set(nb);
  const out: string[] = [];
  const seen = new Set<string>();

  for (const pa of na) {
    if (seen.has(pa)) continue;
    const hit =
      setB.has(pa) ||
      nb.some(pb => pb.startsWith(pa + '/') || pa.startsWith(pb + '/'));
    if (hit) {
      seen.add(pa);
      out.push(pa);
    }
  }
  return out;
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

// ── Regenerable paths ─────────────────────────────────────────────────────────

/**
 * A path whose contents are produced by a command from a source of truth
 * elsewhere in the tree.
 */
export interface RegenerablePath {
  /** Repo-relative path, no trailing separator. */
  path: string;
  /** The command that reproduces it. */
  command: string;
  /** What it is generated from — the reason it is safe to overwrite. */
  why: string;
}

/**
 * Generated files that two agents routinely "collide" on without being in
 * conflict at all.
 *
 * Over one recent week these were among the most contended files in the repo by
 * concurrent-PR overlap, and every one of those overlaps was noise: the losing
 * side does not need to know what the winning side wrote, only to re-run one
 * command. Treating them as a mutex costs a message round trip at best and an
 * abandoned PR at worst.
 *
 * Strictly wholly-generated paths only. Deliberately NOT here:
 *  - `packages/core/drizzle/*.sql` — the journal is rebuilt from these, but each
 *    file carries DDL only its author can reproduce. Telling an agent to
 *    regenerate one is telling it to drop a migration. Index collisions between
 *    them are the schema-change skill's problem, not this list's.
 *  - `packages/core/package.json` — the recurring collision is the version
 *    field, which is release-owned. There is no command an agent can run to
 *    settle it.
 */
export const REGENERABLE_PATHS: readonly RegenerablePath[] = [
  {
    path: 'docs/specs/INDEX.md',
    command: 'bun run specs:check',
    why: 'generated from the frontmatter of every docs/specs/*.md',
  },
  {
    path: 'packages/core/drizzle/meta/_journal.json',
    command: 'cd packages/core && bun db:generate',
    why: 'rewritten by drizzle-kit from the migration files on disk',
  },
];

/** The registry entry for a path, or null when the path is real work. */
export function findRegenerable(path: string): RegenerablePath | null {
  const p = stripTrailingSep(path);
  return REGENERABLE_PATHS.find(e => e.path === p) ?? null;
}

/**
 * Split observed overlapping paths into the ones that are a genuine contention
 * signal and the ones that just need a command re-run.
 *
 * Callers should treat an empty `contended` as "no collision": there is nothing
 * for the two agents to agree about.
 */
export function partitionRegenerableOverlaps(paths: string[]): {
  contended: string[];
  regenerable: RegenerablePath[];
} {
  const contended: string[] = [];
  const regenerable: RegenerablePath[] = [];
  for (const path of paths) {
    const hit = findRegenerable(path);
    if (!hit) {
      contended.push(path);
    } else if (!regenerable.some(r => r.path === hit.path)) {
      regenerable.push(hit);
    }
  }
  return { contended, regenerable };
}
