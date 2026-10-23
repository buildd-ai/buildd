/**
 * Claim-time overlap policy (spec: Overlap scheduling: serial lanes and file
 * locks). At claim time only lane paths are checked (I-10).
 *
 * Overlapping work starts by default: two tasks sharing a file or a directory
 * both start, and the merge settles it (runner pre-merge + mergiraf, mission
 * refresh, the conflict resolver). The edit-time lease stops two agents
 * editing one file at once. An overlap holds a claim only when the shared
 * paths touch a lane path:
 *
 *  - a migration namespace or schema in any repo (`isMigrationPath`),
 *  - the unmergeable-surface list (`@buildd/core/unmergeable-surfaces`), or
 *  - a surface the workspace marks serialized, generated or a hotspot
 *    (`touchesHardOverlapSurface`, passed in as `isHardSurface`).
 *
 * A holder that cannot start itself (pending with a future `startAt`, or in a
 * held mission: `holderCannotStart`) holds nobody, whatever the overlap kind:
 * pass its id in `idle` and the open-PR and lease checks skip it.
 *
 * The open-PR and live-lease checks both ask `overlapHolds`; no model is
 * asked (R-3). Pure, no DB.
 */
import { classifyManifestOverlap, findBlockingPr, intersectPaths, isMigrationPath, REPO_WIDE_SENTINEL, type ManifestOverlapKind } from '@buildd/core/path-overlap';
import { unmergeablePaths } from '@buildd/core/unmergeable-surfaces';
import type { WorkspaceGitConfig } from '@buildd/core/db/schema';
import { overlapIsHard, resolveSerializedSurfaces } from '@/lib/hard-overlap-surfaces';

export type HardSurfaceCheck = (paths: string[], kind: ManifestOverlapKind) => boolean;

/** Does an overlap on these shared paths hold the claim? Fails closed when the surface check throws. */
export function overlapHolds(paths: readonly string[], kind: ManifestOverlapKind, isHardSurface: HardSurfaceCheck): boolean {
  if (kind === 'migration' || paths.some(isMigrationPath)) return true;
  if (unmergeablePaths(paths).length > 0) return true;
  try {
    return isHardSurface([...paths], kind);
  } catch {
    return true;
  }
}

/** Both sides of an overlap, as `classifyManifestOverlap` reports it (falls back to the raw intersection). */
function sharedPaths(a: string[], b: string[]): { kind: ManifestOverlapKind; paths: string[] } {
  const o = classifyManifestOverlap(a, b);
  if (o.kind !== 'none') return { kind: o.kind, paths: o.paths };
  return { kind: 'prefix', paths: [...new Set([...intersectPaths(a, b), ...intersectPaths(b, a)])] };
}

/**
 * Do these paths touch a workspace hard surface (serialized namespace,
 * generated file, explicit hotspot)? Fails closed (true) on a malformed config.
 */
export function touchesHardOverlapSurface(paths: string[], kind: ManifestOverlapKind, gitConfig: WorkspaceGitConfig | null | undefined): boolean {
  return overlapIsHard(paths, kind, gitConfig, resolveSerializedSurfaces);
}

/** The workspace half of `overlapHolds`: its serialized surfaces, generated files and hotspots. */
export function workspaceHardSurface(gitConfig: WorkspaceGitConfig | null | undefined): HardSurfaceCheck {
  return (paths, kind) => touchesHardOverlapSurface(paths, kind, gitConfig ?? null);
}

/**
 * Does a live lease on these shared paths hold the claim? Only on a lane path.
 * A lease on any other file is the edit-time lock: it denies the second
 * agent's edit (409 + waiter, under `pathClaimEnforcement: 'enforce'` too),
 * never its start.
 */
export function leaseOverlapHolds(
  paths: readonly string[],
  gitConfig: WorkspaceGitConfig | null | undefined,
): boolean {
  return overlapHolds(paths, 'prefix', workspaceHardSurface(gitConfig)) || overlapHolds(paths, 'exact_file', workspaceHardSurface(gitConfig));
}

/**
 * The first open PR (in the order given) whose overlap with `manifest` holds
 * the claim, with the shared paths. Null when every overlapping PR shares only
 * mergeable files, which then start alongside it.
 */
export function findHoldingOpenPr<T extends { pathManifest?: string[] | null; prNumber?: number | null; prUrl?: string | null; taskId?: string | null }>(
  manifest: string[],
  openPrs: readonly T[],
  isHardSurface: HardSurfaceCheck,
  idle?: ReadonlySet<string>,
): { pr: T; paths: string[] } | null {
  for (const pr of openPrs) {
    if (pr.taskId && idle?.has(pr.taskId)) continue;
    if (!findBlockingPr(manifest, [pr])) continue;
    const { kind, paths } = sharedPaths(manifest, pr.pathManifest ?? []);
    if (overlapHolds(paths, kind, isHardSurface)) return { pr, paths };
  }
  return null;
}

/**
 * Of a starting task's declared paths, the ones it takes an exclusive lease on
 * before its claim: only the paths that would hold someone else. A mergeable
 * file is never leased up front, so a third task sharing it starts too.
 */
export function exclusiveStartPaths(paths: readonly string[], isHardSurface: HardSurfaceCheck): string[] {
  return paths.filter(p => p !== REPO_WIDE_SENTINEL && overlapHolds([p], 'exact_file', isHardSurface));
}

/**
 * The first live lease (in map order) whose overlap with `manifest` holds the
 * claim under `leaseOverlapHolds`, shaped like `findActiveClaimBlocker`'s
 * answer. Null when every overlapping lease is on mergeable files or held by
 * a task in `idle`.
 */
export function findHoldingLease(
  taskId: string,
  manifest: readonly string[],
  activeClaims: Map<string, string[]> | null | undefined,
  exempt: ReadonlySet<string> | undefined,
  gitConfig: WorkspaceGitConfig | null | undefined,
  idle?: ReadonlySet<string>,
): { holderTaskId: string; claimedPaths: string[]; overlapPaths: string[] } | null {
  const concrete = manifest.filter(p => p !== REPO_WIDE_SENTINEL);
  if (concrete.length === 0 || !activeClaims) return null;
  for (const [holderTaskId, claimed] of activeClaims) {
    if (holderTaskId === taskId || exempt?.has(holderTaskId) || idle?.has(holderTaskId)) continue;
    const claimedPaths = claimed.filter(p => p !== REPO_WIDE_SENTINEL);
    const overlapPaths = intersectPaths(concrete, claimedPaths);
    if (overlapPaths.length === 0) continue;
    const shared = [...new Set([...overlapPaths, ...intersectPaths(claimedPaths, concrete)])];
    if (leaseOverlapHolds(shared, gitConfig)) return { holderTaskId, claimedPaths, overlapPaths };
  }
  return null;
}
