/**
 * The stored half of chat tool permissions (permissions.ts): one text[] on the
 * person's team membership. Both writes are single atomic UPDATEs.
 */

import { and, eq, sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { teamMembers } from '@buildd/core/db/schema';
import { parseAllowedGroups } from './permissions';
import type { ToolGroup } from './registry';

/** The groups this person allowed in this team. Empty on any failure (ask for everything). */
export async function loadAllowedToolGroups(teamId: string, userId: string): Promise<ReadonlySet<ToolGroup>> {
  try {
    const [row] = await db.select({ groups: teamMembers.chatAllowedToolGroups })
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
      .limit(1);
    return parseAllowedGroups(row?.groups ?? []);
  } catch {
    return new Set();
  }
}

/** Set one group to allow or ask. False when the person isn't in the team. */
export async function setToolGroupMode(teamId: string, userId: string, group: ToolGroup, mode: 'ask' | 'allow'): Promise<boolean> {
  const without = sql`array_remove(${teamMembers.chatAllowedToolGroups}, ${group})`;
  const rows = await db.update(teamMembers)
    .set({ chatAllowedToolGroups: mode === 'allow' ? sql`array_append(${without}, ${group})` : without })
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .returning({ groups: teamMembers.chatAllowedToolGroups });
  return rows.length > 0;
}
