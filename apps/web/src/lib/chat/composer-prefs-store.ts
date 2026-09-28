/**
 * The stored half of composer prefs (composer-prefs.ts): one jsonb on the
 * person's team membership, and the team's tier policy on `teams`. The write
 * is a single atomic UPDATE that merges the changed keys.
 */

import { and, eq, sql } from 'drizzle-orm';
import type { GetComposerPrefsResponse } from '@buildd/shared';
import { db } from '@buildd/core/db';
import { teamMembers, teams } from '@buildd/core/db/schema';
import { parseComposerPrefs, parseTeamDefaultTier, seedComposer, type ComposerPrefs } from './composer-prefs';

/** The seed for a new conversation. Auto and the page's own workspace on any failure. */
export async function loadComposerSeed(teamId: string, userId: string, workspaceIds: readonly string[]): Promise<GetComposerPrefsResponse> {
  try {
    const [row] = await db.select({
      prefs: teamMembers.chatComposerPrefs,
      teamDefault: teams.chatDefaultTier,
      capEnabled: teams.chatCapNewSessionTier,
    })
      .from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.teamId))
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
      .limit(1);
    if (!row) return { tier: null };
    return seedComposer(
      parseComposerPrefs(row.prefs),
      { teamDefault: parseTeamDefaultTier(row.teamDefault), capEnabled: row.capEnabled },
      workspaceIds,
    );
  } catch {
    return { tier: null };
  }
}

/** Remember the given keys, leaving the others. False when the person isn't in the team. */
export async function saveComposerPrefs(teamId: string, userId: string, patch: ComposerPrefs): Promise<boolean> {
  const rows = await db.update(teamMembers)
    .set({ chatComposerPrefs: sql`coalesce(${teamMembers.chatComposerPrefs}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb` })
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .returning({ teamId: teamMembers.teamId });
  return rows.length > 0;
}
