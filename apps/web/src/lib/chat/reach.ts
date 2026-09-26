/**
 * Loads a conversation's ChatReach (see in-process-api.ts): the conversation
 * team's workspaces that are not sensitive. Evaluated per turn, so a workspace
 * marked sensitive after a conversation started drops out of reach at once.
 *
 * Fails closed: a lookup error yields an empty workspace set, and an owner
 * lookup error reads as "unknown", which is out of reach.
 */

import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { initiatives, missions, tasks, workspaces } from '@buildd/core/db/schema';
import type { ChatReach } from './in-process-api';

/** Sensitive by either marker: the column, or the older gitConfig flag. */
export function isStandardWorkspace(ws: { dataClass?: string | null; gitConfig?: { dataClass?: string } | null }): boolean {
  return ws.dataClass === 'standard' && ws.gitConfig?.dataClass !== 'sensitive';
}

export async function loadChatReach(teamId: string): Promise<ChatReach> {
  let workspaceIds = new Set<string>();
  try {
    const rows = await db.query.workspaces.findMany({
      where: eq(workspaces.teamId, teamId),
      columns: { id: true, dataClass: true, gitConfig: true },
    });
    workspaceIds = new Set(rows.filter(isStandardWorkspace).map(r => r.id));
  } catch (e) {
    console.error('[chat] reach lookup failed; tools see no workspace:', e);
  }

  const ownerOf: ChatReach['ownerOf'] = async (kind, id) => {
    try {
      if (kind === 'task') {
        const t = await db.query.tasks.findFirst({
          where: eq(tasks.id, id),
          columns: { workspaceId: true },
          with: { workspace: { columns: { teamId: true } } },
        });
        return t ? { teamId: (t.workspace as { teamId?: string } | null)?.teamId ?? null, workspaceId: t.workspaceId } : null;
      }
      const table = kind === 'mission' ? missions : initiatives;
      const [row] = await db.select({ teamId: table.teamId, workspaceId: table.workspaceId })
        .from(table).where(eq(table.id, id)).limit(1);
      if (!row) return null;
      if (kind !== 'mission') return row;
      // A team-level mission's tasks can sit in any team workspace, and a
      // mission read returns their titles and results.
      const kids = await db.selectDistinct({ workspaceId: tasks.workspaceId })
        .from(tasks).where(eq(tasks.missionId, id));
      return { ...row, childWorkspaceIds: kids.map(k => k.workspaceId) };
    } catch {
      return null;
    }
  };

  return { teamId, workspaceIds, ownerOf };
}
