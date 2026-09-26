/**
 * "Also running" is other work, not this task's own. A task's lineage — the
 * `parentTaskId` chain in both directions (the CI-fix / review attempts it
 * spawned, and the task it is itself fixing) — is the same unit of work and
 * must not be listed as a peer. Siblings (other children of the same parent,
 * e.g. sub-tasks of one plan) are genuine peers and stay.
 */

/** True when `a` is `b`, an ancestor of `b`, or a descendant of `b`. */
export function isInTaskLineage(
  a: string,
  b: string,
  parentOf: ReadonlyMap<string, string | null>,
): boolean {
  if (a === b) return true;
  return isAncestor(a, b, parentOf) || isAncestor(b, a, parentOf);
}

/** True when `ancestor` appears on `id`'s parent chain. Cycle-safe. */
function isAncestor(ancestor: string, id: string, parentOf: ReadonlyMap<string, string | null>): boolean {
  const seen = new Set<string>([id]);
  let cur = parentOf.get(id) ?? null;
  while (cur && !seen.has(cur)) {
    if (cur === ancestor) return true;
    seen.add(cur);
    cur = parentOf.get(cur) ?? null;
  }
  return false;
}

/** Parent ids referenced in `parentOf` whose own parent is not loaded yet. */
export function unresolvedParentIds(parentOf: ReadonlyMap<string, string | null>): string[] {
  const out = new Set<string>();
  for (const parent of parentOf.values()) {
    if (parent && !parentOf.has(parent)) out.add(parent);
  }
  return [...out];
}
