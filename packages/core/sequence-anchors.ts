/**
 * Sequence-namespace anchors: the extra file a manifest must name so tasks that
 * write into the same numbered directory (Drizzle migrations, for example)
 * serialize on one file instead of on distinct file names. Pure; reads only
 * the workspace gitConfig. Re-exported by apps/web/src/lib/change-intent.ts.
 */
import type { WorkspaceGitConfig } from './db/schema';

/**
 * Given a task's pathManifest and the workspace gitConfig, returns additional
 * anchor files that should be auto-appended to the manifest.
 *
 * Drizzle migrations example: any path under "packages/core/drizzle" triggers
 * auto-append of "packages/core/drizzle/meta/_journal.json" so the claim-route
 * serialisation (findBlockingPr) fires on the anchor file rather than individual
 * migration filenames (which have distinct names despite sharing the integer index).
 */
export function resolveAnchorInjections(
  pathManifest: string[],
  gitConfig: WorkspaceGitConfig | null | undefined,
): string[] {
  const namespaces = gitConfig?.sequenceNamespaces;
  if (!namespaces?.length || !pathManifest.length) return [];

  const toAdd: string[] = [];
  const under = (path: string, dir: string) => path === dir || path.startsWith(dir + '/');
  for (const ns of namespaces) {
    const dir = ns.dir.replace(/\/+$/, '');
    // A schema trigger (e.g. schema.ts) generates INTO the namespace without
    // touching it: a manifest naming the trigger, or a directory containing
    // it, serializes on the anchor too. The directory-only rule misses it.
    const triggers = (ns.triggers ?? []).map((t) => t.replace(/\/+$/, ''));
    const overlaps = pathManifest.some(
      (p) => under(p, dir) || triggers.some((t) => under(t, p.replace(/\/+$/, ''))),
    );
    if (overlaps && !pathManifest.includes(ns.anchorFile)) {
      toAdd.push(ns.anchorFile);
    }
  }
  return toAdd;
}
