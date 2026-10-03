import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { inArray } from 'drizzle-orm';
import { tokenWorkspaceAllowed } from '@buildd/core/token-scopes';
import { getAccountWorkspacePermissions } from '@/lib/account-workspace-cache';
import { accountReachesWorkspace } from '@/lib/workspace-reach';

/**
 * Which other workspaces' docs corpora a workspace may read alongside its own.
 *
 * A workspace opts in with `gitConfig.linkedKnowledgeWorkspaces` (ids). The
 * list is only a request: an id is returned only when every rule below holds
 * for the calling account, so a link can never widen access beyond what the
 * account could already reach on its own.
 *
 *   - same team as the linking workspace (never across teams);
 *   - not `dataClass: 'sensitive'`;
 *   - the account reaches it (`accountReachesWorkspace`: an explicit link, or
 *     open within the account's own team) — a restricted workspace needs the
 *     account linked to it. A person's session (`sessionUser`) reaches every
 *     workspace of a team they belong to, as in workspace-access.ts, and the
 *     same-team rule above already pins the target to the team the session
 *     was authenticated against;
 *   - a workspace-restricted token has it on its allow-list.
 *
 * No account (nobody to authorise) or any lookup failure returns [] — the
 * caller falls back to its own docs only.
 */
const MAX_LINKED = 10;

export interface LinkedDocsAccount {
  id: string;
  teamId: string;
  workspaceIds?: readonly string[] | null;
  /** A person's team session rather than an API account; see above. */
  sessionUser?: boolean;
}

export async function resolveLinkedDocsWorkspaces(input: {
  workspaceId: string | null | undefined;
  account: LinkedDocsAccount | null | undefined;
}): Promise<string[]> {
  const { workspaceId, account } = input;
  if (!workspaceId || !account) return [];
  try {
    const source = await db.query.workspaces.findFirst({
      where: (w, { eq }) => eq(w.id, workspaceId),
      columns: { id: true, teamId: true, gitConfig: true },
    });
    const raw = (source?.gitConfig as { linkedKnowledgeWorkspaces?: unknown } | null | undefined)?.linkedKnowledgeWorkspaces;
    if (!source || !Array.isArray(raw)) return [];

    const wanted = Array.from(new Set(
      raw.filter((id): id is string => typeof id === 'string' && id.length > 0 && id !== workspaceId),
    )).slice(0, MAX_LINKED);
    if (wanted.length === 0) return [];

    const [rows, links] = await Promise.all([
      db.query.workspaces.findMany({
        where: inArray(workspaces.id, wanted),
        columns: { id: true, teamId: true, accessMode: true, dataClass: true },
      }),
      getAccountWorkspacePermissions(account.id),
    ]);
    const linkFor = new Map(links.map(l => [l.workspaceId, l]));

    const allowed = new Set(
      rows
        .filter(r => r.teamId === source.teamId)
        .filter(r => r.dataClass !== 'sensitive')
        .filter(r => tokenWorkspaceAllowed(account.workspaceIds, r.id))
        .filter(r => account.sessionUser || accountReachesWorkspace(account, r, linkFor.get(r.id)))
        .map(r => r.id),
    );
    return wanted.filter(id => allowed.has(id));
  } catch {
    return [];
  }
}
