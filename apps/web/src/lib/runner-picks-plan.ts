/**
 * Runner login picks (spec "One runner for every team you run", R-1..R-3):
 * the pure rules. No database, no session; lib/runner-picks.ts applies them.
 *
 * A runner key has one home team (`accounts.team_id`, where its usage and
 * limits count). What it claims from is the workspaces the person picked on
 * the runner consent page, across every team they belong to. Each pick is an
 * `account_workspaces` row carrying `granted_by_user_id`, and the key's
 * `workspace_ids` is set to the picks so it reaches nothing else.
 */
import type { ConsentTeam } from './oauth/account-consent';
import { pickerTeams } from './oauth/account-consent';
import { clampKeyLevel, type ApiKeyLevel, type TeamRole } from './key-level-policy';

/** Roles that may pick (and keep reaching) a team's `restricted` workspaces. */
export const RESTRICTED_PICK_ROLES: readonly string[] = ['owner', 'admin'];

export function mayPickRestricted(role: string | null | undefined): boolean {
  return !!role && RESTRICTED_PICK_ROLES.includes(role);
}

/**
 * What the runner consent page offers (R-2): every team the person is on with
 * its workspaces, internal ones left out (as MCP sign-in does), and a team's
 * `restricted` workspaces only where the person is its owner or admin. Teams
 * left with nothing are dropped.
 */
export function runnerPickerTeams(teams: ConsentTeam[]): ConsentTeam[] {
  return pickerTeams(teams, null)
    .map((t) => ({
      ...t,
      workspaces: t.workspaces.filter((w) => (w.accessMode ?? 'open') !== 'restricted' || mayPickRestricted(t.role)),
    }))
    .filter((t) => t.workspaces.length > 0);
}

/** The team of each picked workspace, in the page's team order. */
export function teamsOfPicks(teams: ConsentTeam[], workspaceIds: readonly string[]): ConsentTeam[] {
  const picked = new Set(workspaceIds);
  return teams.filter((t) => t.workspaces.some((w) => picked.has(w.id)));
}

/**
 * The key's home team: the person's default team when it holds a pick, else
 * the first team on the page that does. Null when nothing was picked.
 */
export function chooseHomeTeam(
  teams: ConsentTeam[],
  workspaceIds: readonly string[],
  defaultTeamId: string | null,
): ConsentTeam | null {
  const withPicks = teamsOfPicks(teams, workspaceIds);
  return withPicks.find((t) => t.id === defaultTeamId) ?? withPicks[0] ?? null;
}

function asRole(role: string | null): TeamRole {
  return role === 'owner' || role === 'admin' ? role : 'member';
}

/**
 * The key's level (R-2): what the client asked for, capped by the person's
 * role in every team it picked. A key reaching a team where the person is a
 * member is at most `worker`, wherever its home is.
 */
export function levelForPicks(requested: ApiKeyLevel, pickedTeams: ConsentTeam[]): ApiKeyLevel {
  return pickedTeams.reduce<ApiKeyLevel>((level, t) => clampKeyLevel(asRole(t.role), level), requested);
}

/**
 * A replacement pick list for an existing key (R-4), checked against what the
 * page offers now. Every id must be offered; nothing is dropped silently.
 */
export type PickCheck =
  | { ok: true; workspaceIds: string[] }
  | { ok: false; status: 400 | 403; message: string };

export function checkPicks(teams: ConsentTeam[], workspaceIds: unknown): PickCheck {
  if (!Array.isArray(workspaceIds) || workspaceIds.some((id) => typeof id !== 'string')) {
    return { ok: false, status: 400, message: 'workspaceIds must be a list of workspace ids.' };
  }
  const ids = [...new Set(workspaceIds as string[])];
  if (ids.length === 0) return { ok: false, status: 400, message: 'Choose at least one workspace.' };
  const offered = new Set(teams.flatMap((t) => t.workspaces.map((w) => w.id)));
  if (ids.some((id) => !offered.has(id))) {
    return { ok: false, status: 403, message: 'One of the chosen workspaces is not available to you.' };
  }
  return { ok: true, workspaceIds: ids };
}
