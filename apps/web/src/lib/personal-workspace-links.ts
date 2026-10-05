/**
 * Link a user's own runner account to the workspaces of their personal team.
 *
 * The workspace a new user gets at first sign-in ("My Workspace") is created
 * with the schema default `accessMode: 'restricted'`, and restricted admits an
 * API account only through an explicit `accountWorkspaces` link — even one in
 * the owning team (see ./workspace-reach). The account that `buildd login`
 * mints carried no link, so the user's first task waited for a runner forever
 * while their runner reported idle.
 *
 * The fix is a link, not a looser default: `accessMode` stays as it is for
 * every workspace, and only the account a user mints for themselves in their
 * OWN personal team gets linked. Nothing here touches a shared team's
 * workspaces or another person's accounts.
 */
import { db } from '@buildd/core/db';
import { accounts, accountWorkspaces, teamMembers, teams, workspaces } from '@buildd/core/db/schema';
import { and, eq } from 'drizzle-orm';
import { invalidateAccountWorkspaceCache } from './account-workspace-cache';
import { personalTeamSlug, planPersonalWorkspaceLinks } from './personal-workspace-links-plan';

export { personalTeamSlug, planPersonalWorkspaceLinks } from './personal-workspace-links-plan';
export type { PersonalLinkInput, PlannedLink } from './personal-workspace-links-plan';


/**
 * Apply {@link planPersonalWorkspaceLinks} for an account that was just
 * created. Never throws: a failure here must not fail the login that minted
 * the key; the task page offers the same link as a one-click fix.
 *
 * Returns the number of links written.
 */
export async function linkAccountToPersonalWorkspaces(args: {
  accountId: string;
  userId: string;
}): Promise<number> {
  try {
    const account = await db.query.accounts.findFirst({
      where: eq(accounts.id, args.accountId),
      columns: { id: true, type: true, teamId: true, workspaceIds: true },
    });
    if (!account) return 0;
    const team = await db.query.teams.findFirst({
      where: eq(teams.id, account.teamId),
      columns: { id: true, slug: true },
    });
    if (!team || team.slug !== personalTeamSlug(args.userId)) return 0;
    const membership = await db.query.teamMembers.findFirst({
      where: and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, args.userId)),
      columns: { role: true },
    });
    const [teamWorkspaces, links] = await Promise.all([
      db.query.workspaces.findMany({
        where: eq(workspaces.teamId, team.id),
        columns: { id: true, teamId: true, accessMode: true },
      }),
      db.query.accountWorkspaces.findMany({
        where: eq(accountWorkspaces.accountId, account.id),
        columns: { workspaceId: true },
      }),
    ]);
    const planned = planPersonalWorkspaceLinks({
      userId: args.userId,
      role: membership?.role ?? null,
      team,
      account,
      teamWorkspaces,
      existingLinks: links.map((l) => l.workspaceId),
    });
    if (planned.length === 0) return 0;
    await db.insert(accountWorkspaces).values(planned).onConflictDoNothing();
    invalidateAccountWorkspaceCache(account.id);
    return planned.length;
  } catch (err) {
    console.error('[personal-workspace-links] failed to link account to personal workspaces:', err);
    return 0;
  }
}
