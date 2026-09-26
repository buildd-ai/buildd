/**
 * Delegation targets for the role editor's "Can Delegate To" picker.
 *
 * `canDelegateTo` stores slugs, so a slug is the identity of a delegate. The
 * same slug can exist in several workspaces (and at team level); rendering one
 * chip per row gave duplicate React keys and made picking one chip light up
 * every chip sharing its slug. One option per slug fixes both.
 */
export interface DelegateRoleRow {
  slug: string;
  name: string;
  workspaceId: string | null;
}

export interface DelegateOption {
  slug: string;
  name: string;
  /** Workspace name when the slug lives in exactly one workspace; undefined for team-level or multi-workspace slugs. */
  workspaceName?: string;
}

export function buildDelegateOptions(
  rows: readonly DelegateRoleRow[],
  excludeSlug: string,
  workspaceNames: ReadonlyMap<string, string>,
): DelegateOption[] {
  const bySlug = new Map<string, { row: DelegateRoleRow; workspaceIds: Set<string> }>();
  for (const row of rows) {
    if (row.slug === excludeSlug) continue;
    const entry = bySlug.get(row.slug);
    if (!entry) {
      bySlug.set(row.slug, { row, workspaceIds: new Set(row.workspaceId ? [row.workspaceId] : []) });
      continue;
    }
    if (row.workspaceId) entry.workspaceIds.add(row.workspaceId);
    // The team-level row is the canonical definition; prefer its name.
    if (row.workspaceId === null && entry.row.workspaceId !== null) entry.row = row;
  }

  return [...bySlug.values()].map(({ row, workspaceIds }) => ({
    slug: row.slug,
    name: row.name,
    workspaceName:
      row.workspaceId === null || workspaceIds.size !== 1
        ? undefined
        : (workspaceNames.get(row.workspaceId) ?? undefined),
  }));
}
