/**
 * Workspace hard surfaces for path overlap: the files where a same-file (or
 * prefix) overlap with an in-flight task stays a deterministic hold instead of
 * going to the claim-time HOLD/START decision.
 *
 *  - `serialized:<label>`: a serialized conflict surface or sequence namespace
 *    (`resolveSerializedSurfaces`);
 *  - `generated:<pattern>`: a generated file, either built in
 *    (`REGENERABLE_PATHS`) or the workspace's `gitConfig.derivedFiles`;
 *  - `hotspot:<pattern>`: the workspace's explicit `gitConfig.overlapHotspots`.
 *
 * Migration and schema paths are hard on their own (`isMigrationPath`, no
 * config needed). Generated files and hotspots are hard only for a SAME-FILE
 * overlap (`overlapIsHard`): a directory-prefix overlap that merely contains
 * one stays soft, as before, and the live lease still guards the real edit.
 * Pure, no DB. Both predicates fail closed: a config they cannot read makes
 * every overlap hard.
 *
 * The serialized-surface resolver is passed in (`SerializedResolver`, in
 * practice `resolveSerializedSurfaces` below). It and its pattern rules live
 * here, in core, because they define serial lanes; surface-ordering-config
 * (missions module) re-exports them (scripts/module-boundaries.ts).
 */
import type { WorkspaceGitConfig } from '@buildd/core/db/schema';
import { findRegenerable, stripTrailingSep, type ManifestOverlapKind } from '@buildd/core/path-overlap';
import { normalizeDerivedFiles } from '@buildd/shared';

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

/** Labels of the workspace serialized surfaces these paths touch; may throw on a malformed config. */
export type SerializedResolver = (paths: string[], gitConfig: WorkspaceGitConfig | null | undefined) => string[];

/** A hotspot is a path, or `dir/**` for everything under it. */
function matchesHotspot(path: string, pattern: string): boolean {
  const prefix = pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern;
  return path === prefix || path.startsWith(prefix + '/');
}

function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` matches zero or more directories; a trailing `**` matches everything below.
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * gitattributes pattern semantics, as the runner's merge driver sees them: a
 * pattern with no `/` matches the basename at any depth; a leading `/` or any
 * inner `/` anchors it to the repo root.
 */
export function matchesGitattributesPattern(path: string, pattern: string): boolean {
  const p = stripTrailingSep(path).replace(/^\/+/, '');
  const pat = pattern.trim();
  if (!pat) return false;
  if (!pat.includes('/')) {
    const base = p.split('/').pop() ?? '';
    return globToRegExp(pat).test(base);
  }
  return globToRegExp(pat.replace(/^\/+/, '')).test(p);
}

function hotspotPatterns(gitConfig: WorkspaceGitConfig | null | undefined): string[] {
  const raw = (gitConfig as { overlapHotspots?: unknown } | null | undefined)?.overlapHotspots;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('gitConfig.overlapHotspots is not a list');
  return raw.filter((p): p is string => typeof p === 'string' && p.trim().length > 0).map(p => p.trim());
}

/** Labels of every hard surface the paths touch, deduplicated. Throws on a malformed config. */
export function resolveHardOverlapSurfaces(paths: string[], gitConfig: WorkspaceGitConfig | null | undefined, serialized: SerializedResolver): string[] {
  const out = new Set<string>();
  for (const label of serialized(paths, gitConfig)) out.add(`serialized:${label}`);
  const derived = normalizeDerivedFiles(gitConfig?.derivedFiles ?? []);
  const hotspots = hotspotPatterns(gitConfig);
  for (const raw of paths) {
    const path = stripTrailingSep(raw);
    const builtIn = findRegenerable(path);
    if (builtIn) out.add(`generated:${builtIn.path}`);
    for (const rule of derived) if (matchesGitattributesPattern(path, rule.glob)) out.add(`generated:${rule.glob}`);
    for (const h of hotspots) if (matchesHotspot(path, stripTrailingSep(h))) out.add(`hotspot:${h}`);
  }
  return [...out];
}

/** Does any path touch a hard surface? Fails closed (true) on a malformed config. */
export function isHardOverlapSurface(paths: string[], gitConfig: WorkspaceGitConfig | null | undefined, serialized: SerializedResolver): boolean {
  try {
    return resolveHardOverlapSurfaces(paths, gitConfig, serialized).length > 0;
  } catch {
    return true;
  }
}

/**
 * The creation and claim predicate: a serialized surface makes any overlap
 * hard; a generated file or hotspot makes only a same-file overlap hard.
 * Fails closed (true) on a malformed config.
 */
export function overlapIsHard(paths: string[], kind: ManifestOverlapKind, gitConfig: WorkspaceGitConfig | null | undefined, serialized: SerializedResolver): boolean {
  try {
    if (kind === 'exact_file') return resolveHardOverlapSurfaces(paths, gitConfig, serialized).length > 0;
    return serialized(paths, gitConfig).length > 0;
  } catch {
    return true;
  }
}
