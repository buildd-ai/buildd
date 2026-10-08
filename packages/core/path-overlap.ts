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
 * True when a single manifest entry names a real scope: not the repo-wide
 * sentinel, not a bare `'*'`, and not a glob that spans an entire monorepo
 * root (`apps/**`, `packages/**` — every package in that root, not one of
 * them). `apps/web/**` is fine: it is wide, but bounded to one package.
 */
function isManifestEntryTooWide(entry: string): boolean {
  if (entry === REPO_WIDE_SENTINEL || entry === '*') return true;
  const [root, pkg] = entry.split('/').filter(Boolean);
  if ((root === 'apps' || root === 'packages') && (!pkg || pkg.includes('*'))) {
    return true;
  }
  return false;
}

/**
 * Creation-time bar for "did the caller declare a real scope?" — stricter
 * than `isAdvisoryManifest`, which only catches the literal `'**'` sentinel.
 * A manifest of `['apps/**']` or `['*']` has told the overlap detector
 * nothing useful either, so it must not satisfy the mandatory-manifest gate
 * in `POST /api/tasks`. True when at least one entry is concrete.
 */
export function hasConcretePathManifest(manifest: string[] | null | undefined): boolean {
  if (!manifest || manifest.length === 0) return false;
  return manifest.some(entry => !isManifestEntryTooWide(entry));
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

// ── Hard vs soft overlap ─────────────────────────────────────────────────────
//
// A stored `dependsOn` edge is a hard rail: the dependent waits until the
// upstream task is completed AND its PR merged, and nothing re-checks it. That
// is right for anything in a migration namespace, and for a workspace's hard
// surfaces (serialized namespaces, generated files, the explicit hotspot list:
// the caller's `isSerialized`). It is wrong for a directory-prefix overlap
// (`scripts/` against `scripts/x.ts`): honest broad scope queued behind every
// task under it, which rewarded declaring less. It is also wrong for most
// same-file overlaps: of task pairs whose merged PRs touched the same files,
// only a small minority actually conflicted, so a hard hold wasted most of the
// wait. Both are SOFT: recorded as scheduling evidence
// (`PathDeclaration.softOverlaps`, kind `prefix` or `same_file`), decided at
// claim time by the HOLD/START decision, with live path leases still
// preventing simultaneous edits.

/**
 * Migration namespaces and the schema source, matched without workspace config
 * so an unconfigured workspace is still protected. A configured sequence
 * namespace is caught by the workspace's serialized surfaces too.
 */
const MIGRATION_PATH_RE = /(^|\/)(drizzle|migrations?|prisma\/migrations)(\/|$)|\.sql$|(^|\/)db\/schema\.ts$|(^|\/)schema\.prisma$/i;

export function isMigrationPath(path: string): boolean {
  return MIGRATION_PATH_RE.test(path);
}

/**
 * Does this manifest entry name a single file (a basename with an extension,
 * no glob)? `scripts` and `.github` are directories; `x.ts` and `_journal.json`
 * are files. Extensionless files (`Makefile`) read as directories, which only
 * ever makes an overlap softer, never a missed hard edge on a real collision:
 * live path leases still serialize the actual edit.
 */
export function isFileShapedPath(path: string): boolean {
  if (/[*?[\]{}]/.test(path)) return false;
  if (/\/$/.test(path)) return false;
  const base = path.split('/').filter(Boolean).pop() ?? '';
  return base.lastIndexOf('.') > 0;
}

export type ManifestOverlapKind = 'none' | 'exact_file' | 'migration' | 'prefix';

export interface ManifestOverlap {
  kind: ManifestOverlapKind;
  /** The overlapping paths, from both sides, deduplicated. */
  paths: string[];
}

/**
 * Only a migration overlap is hard on its own. A same-file overlap is hard only
 * when its files are a workspace hard surface, which the caller decides.
 */
export function isHardOverlapKind(kind: ManifestOverlapKind): boolean {
  return kind === 'migration';
}

/**
 * Classify how two declared manifests overlap. A sentinel on either side, or
 * an empty side, is `none` (advisory: see `isAdvisoryManifest`).
 *
 *  - `migration`: any overlapping path is in a migration namespace / schema;
 *  - `exact_file`: both sides name the same file;
 *  - `prefix`: only directory containment (or the same directory) overlaps.
 */
export function classifyManifestOverlap(
  a: string[] | null | undefined,
  b: string[] | null | undefined,
): ManifestOverlap {
  if (!a?.length || !b?.length || isAdvisoryManifest(a) || isAdvisoryManifest(b)) return { kind: 'none', paths: [] };
  const paths = [...new Set([...intersectPaths(a, b), ...intersectPaths(b, a)])];
  if (paths.length === 0) return { kind: 'none', paths: [] };
  if (paths.some(isMigrationPath)) return { kind: 'migration', paths };
  const setB = new Set(b.map(stripTrailingSep));
  const exact = [...new Set(a.map(stripTrailingSep))].filter(p => setB.has(p) && isFileShapedPath(p));
  // `paths` is ALWAYS the full intersection (prefix + exact): a pair that shares
  // a file can also share a serialized directory, and the hard-surface check
  // must see that directory too (`seq-dir/` vs `seq-dir/0042.ts` plus a shared
  // `src/a.ts` is hard, as it was before same-file overlap went soft).
  if (exact.length > 0) return { kind: 'exact_file', paths: [...exact, ...paths.filter(p => !exact.includes(p))] };
  return { kind: 'prefix', paths };
}

/** Soft overlap evidence for one pair, persisted on the newer task's path declaration. */
export interface SoftOverlapEdge {
  taskId: string;
  paths: string[];
  /**
   * `prefix` or `same_file` at creation; `legacy_inferred` for an edge minted
   * before the hard/soft split (reclassified at claim either way).
   */
  kind: 'prefix' | 'same_file' | 'legacy_inferred';
}

const softStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : []);

/** The well-formed soft entries on a path declaration. */
export function readSoftOverlaps(pathDeclaration: unknown): SoftOverlapEdge[] {
  const raw = (pathDeclaration as { softOverlaps?: unknown } | null)?.softOverlaps;
  if (!Array.isArray(raw)) return [];
  const out: SoftOverlapEdge[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const taskId = (e as { taskId?: unknown }).taskId;
    if (typeof taskId !== 'string' || taskId.length === 0) continue;
    const rawKind = (e as { kind?: unknown }).kind;
    const kind = rawKind === 'legacy_inferred' || rawKind === 'same_file' ? rawKind : 'prefix';
    out.push({ taskId, paths: softStrings((e as { paths?: unknown }).paths), kind });
  }
  return out;
}

/** At most this many soft pairs are stored per task. */
export const MAX_SOFT_OVERLAPS_PER_TASK = 20;
const MAX_SOFT_OVERLAP_PATHS = 10;

/**
 * Authoring-time split of a new task's manifest overlaps with in-flight tasks:
 * `hard` ids become `dependsOn` edges (a migration path, or a workspace hard
 * surface per `isSerialized`: serialized namespace, generated file, hotspot);
 * `soft` pairs (prefix-only or same-file) are scheduling evidence only. Replaces the
 * old "any overlap is an edge" rule (`shouldSerializeByManifest`) in the
 * creation pass and the conflict-retry pass, which must not drift.
 */
export function partitionOverlapEdges(
  manifest: string[] | null | undefined,
  others: ReadonlyArray<{ id: string; pathManifest: string[] | null | undefined }>,
  opts: {
    /** Workspace hard surface for these overlapping paths; `kind` lets same-file-only surfaces (generated, hotspot) apply only to a same-file overlap. */
    isSerialized?: (paths: string[], kind: ManifestOverlapKind) => boolean;
    skip?: (id: string) => boolean;
    maxSoft?: number;
  } = {},
): { hard: string[]; soft: SoftOverlapEdge[] } {
  const hard: string[] = [];
  const soft: SoftOverlapEdge[] = [];
  if (!manifest?.length || isAdvisoryManifest(manifest)) return { hard, soft };
  const maxSoft = opts.maxSoft ?? MAX_SOFT_OVERLAPS_PER_TASK;
  const candidates: SoftOverlapEdge[] = [];
  for (const o of others) {
    if (opts.skip?.(o.id)) continue;
    const overlap = classifyManifestOverlap(manifest, o.pathManifest ?? null);
    if (overlap.kind === 'none') continue;
    if (isHardOverlapKind(overlap.kind) || opts.isSerialized?.(overlap.paths, overlap.kind)) {
      if (!hard.includes(o.id)) hard.push(o.id);
    } else if (!candidates.some(s => s.taskId === o.id)) {
      candidates.push({ taskId: o.id, paths: overlap.paths.slice(0, MAX_SOFT_OVERLAP_PATHS), kind: overlap.kind === 'exact_file' ? 'same_file' : 'prefix' });
    }
  }
  // Same-file pairs take the soft budget first (they are the riskier evidence),
  // then prefix pairs, each in input order. Anything past the budget is HARD:
  // a pair with no stored evidence would otherwise run unheld (fail closed).
  const ordered = [...candidates.filter(c => c.kind === 'same_file'), ...candidates.filter(c => c.kind !== 'same_file')];
  for (const c of ordered) {
    if (soft.length < maxSoft) soft.push(c);
    else if (!hard.includes(c.taskId)) hard.push(c.taskId);
  }
  return { hard, soft };
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

/**
 * True when `candidateId` is already downstream of `subjectId` in the stored
 * `dependsOn` graph — i.e. walking `candidateId`'s `dependsOn` edges
 * (transitively) reaches `subjectId`.
 *
 * `dependsOnById` maps every in-flight task's id to its own `dependsOn`
 * array (upstream pointers — "I wait for these"), so the walk follows
 * candidate → its deps → their deps, looking for `subjectId`.
 *
 * Used to veto a newly-inferred path-overlap edge: minting
 * `subjectRepair.dependsOn = [...,candidateId]` on top of an existing
 * `candidateId` (transitively) depending on `subjectId` would make the
 * subject's own repair wait on something that is itself waiting on the
 * subject — a structural deadlock (the repair can never land the PR it
 * exists to land), not real serialization. See `shouldSerializeByManifest`
 * for the companion spatial check; callers combine both.
 */
export function isDownstreamOf(
  candidateId: string,
  subjectId: string,
  dependsOnById: ReadonlyMap<string, readonly string[] | null | undefined>,
): boolean {
  if (candidateId === subjectId) return true;
  const seen = new Set<string>([candidateId]);
  const queue: string[] = [...(dependsOnById.get(candidateId) ?? [])];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (id === subjectId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const next = dependsOnById.get(id);
    if (next) queue.push(...next);
  }
  return false;
}

/**
 * Open PRs stacked on top of one of `ownBranches` — directly (their base ref
 * is one of those branches) or transitively (based on a PR that is).
 *
 * A stacked PR's diff against the shared base contains every file of the PR it
 * sits on, so its manifest overlaps that PR by construction. Those overlaps are
 * the lower PR's own changes, not a competing writer: a review/CI/conflict fix
 * for PR C must not defer behind PR D just because D is based on C's branch.
 * The claim route drops the returned PRs from its open-PR backstop.
 */
export function findStackedPrs<T extends { branch?: string | null; prBaseRef?: string | null }>(
  ownBranches: Iterable<string>,
  openPrs: T[],
): Set<T> {
  const ancestors = new Set([...ownBranches].filter(Boolean));
  const stacked = new Set<T>();
  // Fixed point over the base→head edges; bounded by openPrs.length rounds.
  let grew = ancestors.size > 0;
  while (grew) {
    grew = false;
    for (const pr of openPrs) {
      if (stacked.has(pr) || !pr.prBaseRef || !ancestors.has(pr.prBaseRef)) continue;
      stacked.add(pr);
      if (pr.branch && !ancestors.has(pr.branch)) ancestors.add(pr.branch);
      grew = true;
    }
  }
  return stacked;
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
 * Paths a task's working set may lease: trimmed, trailing separators dropped,
 * de-duplicated (order preserved), never blank, never the repo-wide sentinel,
 * never a regenerable file (a generated file is not a mutex). The runner's
 * tracker and the server's reconciliation both apply this, so the two sides
 * agree on what "the set" is and no ACK is ever awaited for a path the server
 * would silently drop. Pure; see packages/core/working-set.ts.
 */
export function leasablePaths(paths: readonly unknown[] | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of paths ?? []) {
    if (typeof raw !== 'string') continue;
    const p = stripTrailingSep(raw.trim());
    if (!p || p === REPO_WIDE_SENTINEL || seen.has(p) || findRegenerable(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
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
