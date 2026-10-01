/**
 * Spec conformance root detection — Slice 7 (§14) of
 * docs/design/spec-conformance.md.
 *
 * `resolveConformanceConfig` (spec-conformance.ts) already accepts
 * `specsRoot`/`designRoot` overrides; this module supplies the other half —
 * detecting sensible defaults for a workspace that isn't buildd, from
 * nothing but its file tree. Mirrors `detectAllRiskClasses` in
 * `apps/web/src/lib/workspace-policy.ts`: never ask a user to type a path,
 * detect it from the repo they already have.
 */

export interface DetectedSpecConformanceRoots {
  specsRoot: string | null;
  designRoot: string | null;
}

// Ordered by specificity — a repo with both `docs/specs` and `spec` should
// resolve to the more explicit, buildd-shaped convention first.
const SPECS_ROOT_CANDIDATES = ['docs/specs', 'docs/spec', 'specs', 'spec'];
const DESIGN_ROOT_CANDIDATES = ['docs/design', 'docs/designs', 'docs/rfcs', 'docs/adr', 'design', 'rfcs', 'adr'];

function hasDirectory(files: string[], root: string): boolean {
  const prefix = `${root}/`;
  return files.some((f) => f.startsWith(prefix));
}

/**
 * `files` is a flat list of repo-relative blob paths (e.g. the GitHub
 * git-trees API's `recursive=1` output filtered to `type === 'blob'`) —
 * the same shape `policy-init` already fetches for risk-class detection.
 */
export function detectSpecConformanceRoots(files: string[]): DetectedSpecConformanceRoots {
  return {
    specsRoot: SPECS_ROOT_CANDIDATES.find((root) => hasDirectory(files, root)) ?? null,
    designRoot: DESIGN_ROOT_CANDIDATES.find((root) => hasDirectory(files, root)) ?? null,
  };
}

// Path-shaped, ORM/tool-neutral names; matched as the tail of a directory path
// so `services/api/migrations` is found as well as a root `migrations`.
const MIGRATIONS_DIR_CANDIDATES = ['migrations', 'db/migrate', 'drizzle', 'prisma/migrations', 'alembic'];

/**
 * The repo's migrations directory, or null. Ties between candidates at the
 * same depth resolve in candidate order; a shallower directory wins over a
 * deeper one. Absent is a normal answer — many repos have no database.
 */
export function detectMigrationsDir(files: string[]): string | null {
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  let best: { dir: string; depth: number; rank: number } | null = null;
  for (const dir of dirs) {
    const rank = MIGRATIONS_DIR_CANDIDATES.findIndex((c) => dir === c || dir.endsWith(`/${c}`));
    if (rank === -1) continue;
    const depth = dir.split('/').length;
    if (!best || depth < best.depth || (depth === best.depth && rank < best.rank)) best = { dir, depth, rank };
  }
  return best?.dir ?? null;
}
