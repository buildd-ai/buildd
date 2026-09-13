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
