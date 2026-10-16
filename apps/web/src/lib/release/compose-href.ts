/**
 * The owner's release flow (Compose → Cut → Review → Release). Linked from the
 * Releases page's Next release card and from the Plan view's release cut line.
 */
export function composeHref(workspaceId?: string | null): string {
  return workspaceId ? `/app/releases/compose?workspace=${encodeURIComponent(workspaceId)}` : '/app/releases/compose';
}
