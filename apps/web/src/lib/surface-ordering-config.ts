/**
 * Surface merge-ordering configuration — pure, dependency-free, so every merge
 * door can ask "is this workspace opted in?" without loading the ordering module
 * (and its DB bindings) on the default path. See lib/surface-ordering.ts.
 */
import type { WorkspaceGitConfig } from '@buildd/core/db/schema';

export type SurfaceOrderingMode = 'off' | 'shadow' | 'enforce';

/** Default off: absent, null, 'off' or any unrecognised value. */
export function resolveSurfaceOrderingMode(gitConfig: WorkspaceGitConfig | null | undefined): SurfaceOrderingMode {
  const mode = (gitConfig as { surfaceOrdering?: unknown } | null | undefined)?.surfaceOrdering;
  return mode === 'shadow' || mode === 'enforce' ? mode : 'off';
}

/**
 * Returns true if `path` is matched by a conflictSurface pattern.
 * Rules (evaluated in order):
 *  1. Exact match.
 *  2. Prefix directory match: pattern "a/b" matches path "a/b/c.ts".
 *  3. Trailing-glob match: pattern "a/b/**" matches any path under "a/b/".
 */
export function matchesSurface(path: string, pattern: string): boolean {
  const globSuffix = '/**';
  const prefix = pattern.endsWith(globSuffix) ? pattern.slice(0, -globSuffix.length) : null;
  if (prefix !== null) return path === prefix || path.startsWith(prefix + '/');
  return path === pattern || path.startsWith(pattern + '/');
}

export interface SerializedSurfaceDef {
  label: string;
  patterns: string[];
}

const trimDir = (p: string) => p.replace(/\/+$/, '');

/** Every surface opted into ordering. A namespace covers its dir, its anchor and its schema triggers. */
export function serializedSurfaceDefs(gitConfig: WorkspaceGitConfig | null | undefined): SerializedSurfaceDef[] {
  const defs = new Map<string, string[]>();
  const add = (label: string, patterns: string[]) => defs.set(label, [...(defs.get(label) ?? []), ...patterns]);
  for (const s of gitConfig?.conflictSurfaces ?? []) {
    if (s?.serialize === true && s.pattern && s.label) add(s.label, [s.pattern]);
  }
  for (const ns of gitConfig?.sequenceNamespaces ?? []) {
    if (ns?.serialize === true && ns.dir && ns.label) {
      add(ns.label, [trimDir(ns.dir), ns.anchorFile, ...(ns.triggers ?? [])].filter(Boolean));
    }
  }
  return [...defs].map(([label, patterns]) => ({ label, patterns }));
}

/**
 * Serialized surfaces a set of RAW paths touches. Deliberately no regenerable
 * exemption: the drizzle journal and snapshots are exempt from edit leases, but
 * they are exactly what two same-index migrations collide on.
 */
export function resolveSerializedSurfaces(paths: string[], gitConfig: WorkspaceGitConfig | null | undefined): string[] {
  const out: string[] = [];
  for (const def of serializedSurfaceDefs(gitConfig)) {
    if (paths.some((p) => def.patterns.some((pat) => matchesSurface(p, pat)))) out.push(def.label);
  }
  return out;
}

/** Surfaces an intent is recorded for at create_pr: the advisory warning surfaces plus serialized namespaces. */
export function resolveIntentSurfaces(paths: string[], gitConfig: WorkspaceGitConfig | null | undefined): string[] {
  const out = new Set<string>();
  for (const s of gitConfig?.conflictSurfaces ?? []) {
    if (paths.some((p) => matchesSurface(p, s.pattern))) out.add(s.label);
  }
  for (const label of resolveSerializedSurfaces(paths, gitConfig)) out.add(label);
  return [...out];
}
