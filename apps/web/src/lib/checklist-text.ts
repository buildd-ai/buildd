/** The old item is an exact-match repair key, never live guidance. */
export const LEGACY_MANIFEST_ITEM = "- [ ] When creating a batch of build tasks: include a CONCRETE pathManifest (actual file/directory paths each task will create or modify) so the platform can serialize tasks that touch the same files. Example: pathManifest=[\"apps/web/src/lib/foo.ts\",\"packages/core/db/schema.ts\"]. The API auto-adds dependsOn edges between tasks whose concrete manifests overlap — you declare the paths, not the edges. A task filed WITHOUT a pathManifest defaults to the repo-wide sentinel [\"**\"], which means \"scope not declared\": it is advisory only and buys no serialization at all — no dependsOn edges in, none out, and no claim-time blocking. So an undeclared scope does not make a task safe; it makes it race. Declaring the paths is the only way to get serialization.";

export const MANIFEST_ITEM = "- [ ] When creating build tasks, declare the files you will edit in pathManifest. Schema, migration and configured hard-surface paths put the task in that serial lane: one at a time, first come; everything else runs in parallel. The edit-time file lock stops two agents editing the same file at once. Add dependsOn only for a real ordering need.";

/** Preserve custom wording and line endings. A repaired item cannot match again. */
export function repairChecklist(text: string | null): { kind: 'updated' | 'current' | 'custom'; text: string | null } {
  if (text === null) return { kind: 'custom', text };
  const parts = text.split(/(\r?\n)/);
  if (parts.some((part, index) => index % 2 === 0 && part === MANIFEST_ITEM)) return { kind: 'current', text };
  const index = parts.findIndex((part, index) => index % 2 === 0 && part === LEGACY_MANIFEST_ITEM);
  if (index < 0) return { kind: 'custom', text };
  parts[index] = MANIFEST_ITEM;
  return { kind: 'updated', text: parts.join('') };
}
