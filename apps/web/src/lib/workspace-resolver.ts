import { db } from '@buildd/core/db';
import { workspaces, accountWorkspaces } from '@buildd/core/db/schema';
import { eq, and, or, ilike, sql } from 'drizzle-orm';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve a workspace identifier (UUID, repo name, or workspace name) to a workspace ID.
 * Returns the workspace row or null.
 */
export async function resolveWorkspace(raw: string) {
  // UUID → direct lookup
  if (UUID_RE.test(raw)) {
    return db.query.workspaces.findFirst({ where: eq(workspaces.id, raw) });
  }

  // Try exact repo match first (e.g., "buildd-ai/moa")
  const byRepo = await db.query.workspaces.findFirst({
    where: eq(workspaces.repo, raw),
  });
  if (byRepo) return byRepo;

  // Try name match (case-insensitive) or repo suffix match
  const byName = await db.query.workspaces.findFirst({
    where: or(
      ilike(workspaces.name, raw),
      sql`${workspaces.repo} ILIKE ${'%/' + raw}`,
    ),
  });
  return byName || null;
}

/**
 * Auto-resolve workspace for an API account that has no workspaceId specified.
 * Returns workspace ID if account is linked to exactly one workspace with canCreate.
 * Returns an error object otherwise with an actionable message.
 */
export async function autoResolveAccountWorkspace(
  accountId: string,
  accountName: string,
): Promise<{ workspaceId: string } | { error: string; status: number }> {
  const linked = await db.query.accountWorkspaces.findMany({
    where: and(
      eq(accountWorkspaces.accountId, accountId),
      eq(accountWorkspaces.canCreate, true),
    ),
    with: { workspace: { columns: { id: true, name: true } } },
  });

  if (linked.length === 0) {
    return {
      error: `Account "${accountName}" has no workspace links. Link a workspace at app.buildd.dev/settings.`,
      status: 400,
    };
  }

  if (linked.length === 1) {
    return { workspaceId: linked[0].workspaceId };
  }

  const names = linked.map(l => l.workspace?.name || l.workspaceId).join(', ');
  return {
    error: `Account "${accountName}" is linked to ${linked.length} workspaces (${names}). Specify workspaceId.`,
    status: 400,
  };
}
