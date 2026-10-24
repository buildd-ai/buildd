/**
 * Surface merge-ordering configuration — pure, dependency-free, so every merge
 * door can ask "is this workspace opted in?" without loading the ordering module
 * (and its DB bindings) on the default path. See lib/surface-ordering.ts.
 */
import type { WorkspaceGitConfig } from '@buildd/core/db/schema';
import { matchesSurface, resolveSerializedSurfaces } from './hard-overlap-surfaces';

export type SurfaceOrderingMode = 'off' | 'shadow' | 'enforce';

/** Default off: absent, null, 'off' or any unrecognised value. */
export function resolveSurfaceOrderingMode(gitConfig: WorkspaceGitConfig | null | undefined): SurfaceOrderingMode {
  const mode = (gitConfig as { surfaceOrdering?: unknown } | null | undefined)?.surfaceOrdering;
  return mode === 'shadow' || mode === 'enforce' ? mode : 'off';
}

// The serialized-surface rules are lane rules, so they live in core
// (lib/hard-overlap-surfaces.ts); re-exported for the ordering module.
export { matchesSurface, serializedSurfaceDefs, resolveSerializedSurfaces, type SerializedSurfaceDef } from './hard-overlap-surfaces';

/** Surfaces an intent is recorded for at create_pr: the advisory warning surfaces plus serialized namespaces. */
export function resolveIntentSurfaces(paths: string[], gitConfig: WorkspaceGitConfig | null | undefined): string[] {
  const out = new Set<string>();
  for (const s of gitConfig?.conflictSurfaces ?? []) {
    if (paths.some((p) => matchesSurface(p, s.pattern))) out.add(s.label);
  }
  for (const label of resolveSerializedSurfaces(paths, gitConfig)) out.add(label);
  return [...out];
}
