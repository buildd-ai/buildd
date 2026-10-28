/**
 * Managing your own MCP connections from Settings
 * (docs/specs/auth-oauth-boundaries.md, "Managing connections").
 *
 * A connection is an account-level grant (lib/mcp-grants.ts). Its owner can
 * list it, set each team to all current and future workspaces or to specific
 * workspaces, add or remove specific workspaces, switch it between read and
 * read-write, downgrade it from acting as them to acting as their agent, and
 * revoke it. Every change is recorded in the connection's history
 * (mcp_oauth_grant_events).
 *
 * Rules every function here keeps:
 *  - Only the owner's grants. Every statement carries `user_id = <owner>`, so
 *    another user's grant id reads exactly like an id that does not exist.
 *  - Adding a workspace or a team re-checks, here and now, that the owner is
 *    on that team. One unreachable id refuses the whole change and the
 *    refusal names no id.
 *  - An edit names the revision it was made against; a grant that moved on
 *    refuses it with the current state (409), never overwrites.
 *  - Never person from agent. Acting as the person needs a fresh consent with
 *    the person scope; the only kind this module ever writes is 'agent'.
 *  - A grant session's cache entry rests on the grant (lib/api-auth.ts), and
 *    every edit clears it, so an edit or a revoke applies on the next request.
 *    Revoke also revokes every refresh token under the grant, in every family.
 */
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, max, or } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { displayTeamName, displayWorkspaceName, isSystemWorkspace } from '@buildd/shared';
import {
  mcpOauthGrants,
  mcpOauthGrantTeams,
  mcpOauthGrantWorkspaces,
  oauthClients,
  oauthRefreshTokens,
  teamMembers,
  teams,
  workspaces,
  type McpGrantActsAs,
  type McpGrantScope,
} from '@buildd/core/db/schema';
import { getActiveGrant, memberTeamIds, memberWorkspaces, recordGrantEvent, type GrantReachSnapshot } from './mcp-grants';
import { clearCallerCache, callerDep } from './caller-cache';
import { grantedScopeString, type ConsentTeam } from './oauth/account-consent';
import { ensureTeamSessionAccount } from './oauth/ensure-session-account';
import {
  GRANT_NOT_FOUND,
  INHERITED_FROM_TEAM,
  TEAM_NOT_ACCESSIBLE,
  WORKSPACE_NOT_ACCESSIBLE,
  invalidGrantPatch,
  staleConnection,
  type ConnectionAccess,
  type ConnectionSummary,
  type ConnectionTeam,
  type ConnectionWorkspace,
  type GrantPatch,
  type LegacyConnectionSummary,
  type ManageError,
  type UserConnections,
} from './mcp-grant-patch';
import { isUuid } from '@/lib/uuid';

export * from './mcp-grant-patch';


const UNNAMED_CLIENT = 'Unnamed app';

function accessOf(scopes: unknown): ConnectionAccess {
  return Array.isArray(scopes) && scopes.includes('write') ? 'read-write' : 'read';
}

/**
 * The user's teams, each with every workspace it holds: what the consent page
 * offers and what Settings may add to a connection. Read fresh every time, so
 * a choice is always checked against current membership.
 */
export async function consentTeamsForUser(userId: string): Promise<ConsentTeam[]> {
  if (!isUuid(userId)) return [];
  const memberships = await db
    .select({ teamId: teams.id, name: teams.name, role: teamMembers.role })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(eq(teamMembers.userId, userId))
    .orderBy(asc(teams.name), asc(teams.id));
  if (memberships.length === 0) return [];
  const rows = await db
    .select({ id: workspaces.id, name: workspaces.name, repo: workspaces.repo, teamId: workspaces.teamId, accessMode: workspaces.accessMode })
    .from(workspaces)
    .where(inArray(workspaces.teamId, memberships.map((m) => m.teamId)))
    .orderBy(asc(workspaces.name), asc(workspaces.id));
  return memberships
    .map((m) => ({
      id: m.teamId,
      name: displayTeamName(m.name, m.teamId),
      role: (m.role as string | null) ?? null,
      workspaces: rows
        .filter((w) => w.teamId === m.teamId)
        .map((w) => ({ id: w.id, name: w.name, repo: w.repo ?? null, system: isSystemWorkspace(w.name), accessMode: w.accessMode ?? null })),
    }))
    .filter((t) => t.workspaces.length > 0);
}

async function summarise(userId: string, grantIds: string[] | null): Promise<ConnectionSummary[]> {
  const now = new Date();
  const grantRows = await db
    .select({
      id: mcpOauthGrants.id,
      clientName: oauthClients.clientName,
      actsAs: mcpOauthGrants.actsAs,
      scopes: mcpOauthGrants.scopes,
      createdAt: mcpOauthGrants.createdAt,
      expiresAt: mcpOauthGrants.expiresAt,
      revision: mcpOauthGrants.revision,
    })
    .from(mcpOauthGrants)
    .leftJoin(oauthClients, eq(oauthClients.clientId, mcpOauthGrants.clientId))
    .where(and(
      eq(mcpOauthGrants.userId, userId),
      isNull(mcpOauthGrants.revokedAt),
      or(isNull(mcpOauthGrants.expiresAt), gt(mcpOauthGrants.expiresAt, now)),
      grantIds ? inArray(mcpOauthGrants.id, grantIds) : undefined,
    ))
    .orderBy(desc(mcpOauthGrants.createdAt), asc(mcpOauthGrants.id));
  if (grantRows.length === 0) return [];
  const ids = grantRows.map((g) => g.id);

  const [wsRows, teamRows, activity] = await Promise.all([
    db
      .select({
        grantId: mcpOauthGrantWorkspaces.grantId,
        id: workspaces.id,
        name: workspaces.name,
        teamId: workspaces.teamId,
        teamName: teams.name,
        memberUserId: teamMembers.userId,
      })
      .from(mcpOauthGrantWorkspaces)
      .innerJoin(workspaces, eq(workspaces.id, mcpOauthGrantWorkspaces.workspaceId))
      .innerJoin(teams, eq(teams.id, workspaces.teamId))
      .leftJoin(teamMembers, and(eq(teamMembers.teamId, workspaces.teamId), eq(teamMembers.userId, userId)))
      .where(inArray(mcpOauthGrantWorkspaces.grantId, ids)),
    db
      .select({
        grantId: mcpOauthGrantTeams.grantId,
        teamId: teams.id,
        teamName: teams.name,
        memberUserId: teamMembers.userId,
      })
      .from(mcpOauthGrantTeams)
      .innerJoin(teams, eq(teams.id, mcpOauthGrantTeams.teamId))
      .leftJoin(teamMembers, and(eq(teamMembers.teamId, mcpOauthGrantTeams.teamId), eq(teamMembers.userId, userId)))
      .where(inArray(mcpOauthGrantTeams.grantId, ids)),
    db
      .select({ grantId: oauthRefreshTokens.grantId, last: max(oauthRefreshTokens.createdAt) })
      .from(oauthRefreshTokens)
      .where(and(inArray(oauthRefreshTokens.grantId, ids), eq(oauthRefreshTokens.userId, userId)))
      .groupBy(oauthRefreshTokens.grantId),
  ]);
  const wholeTeamIds = [...new Set(teamRows.filter((r) => r.memberUserId != null).map((r) => r.teamId))];
  const teamWorkspaceRows = wholeTeamIds.length === 0 ? [] : await db
    .select({ id: workspaces.id, name: workspaces.name, teamId: workspaces.teamId })
    .from(workspaces)
    .where(inArray(workspaces.teamId, wholeTeamIds));
  const lastByGrant = new Map(activity.map((a) => [a.grantId, a.last]));

  return grantRows.map((g) => {
    const mine = wsRows.filter((r) => r.grantId === g.id);
    const reached = new Map<string, ConnectionWorkspace>();
    for (const r of mine) {
      if (r.memberUserId != null) reached.set(r.id, { id: r.id, name: displayWorkspaceName(r.name), teamId: r.teamId, teamName: displayTeamName(r.teamName, r.teamId) });
    }
    const whole = teamRows.filter((r) => r.grantId === g.id);
    const wholeHere = new Map(whole.filter((r) => r.memberUserId != null).map((r) => [r.teamId, displayTeamName(r.teamName, r.teamId)]));
    for (const w of teamWorkspaceRows) {
      const teamName = wholeHere.get(w.teamId);
      if (teamName === undefined || isSystemWorkspace(w.name)) continue;
      reached.set(w.id, { id: w.id, name: w.name, teamId: w.teamId, teamName });
    }
    const flat = [...reached.values()].sort(byTeamThenName);
    const teamsOut = new Map<string, ConnectionTeam>();
    for (const [teamId, teamName] of wholeHere) teamsOut.set(teamId, { teamId, teamName, mode: 'all', workspaces: [] });
    for (const w of flat) {
      let t = teamsOut.get(w.teamId);
      if (!t) teamsOut.set(w.teamId, t = { teamId: w.teamId, teamName: w.teamName, mode: 'specific', workspaces: [] });
      t.workspaces.push(w);
    }
    const last = lastByGrant.get(g.id);
    return {
      id: g.id,
      clientName: g.clientName?.trim() || UNNAMED_CLIENT,
      actsAs: g.actsAs === 'person' ? 'person' : 'agent',
      access: accessOf(g.scopes),
      createdAt: g.createdAt.toISOString(),
      lastActiveAt: last ? new Date(last).toISOString() : null,
      expiresAt: g.expiresAt ? g.expiresAt.toISOString() : null,
      workspaces: flat,
      teams: [...teamsOut.values()].sort((a, b) => a.teamName.localeCompare(b.teamName) || a.teamId.localeCompare(b.teamId)),
      unreachableCount: mine.filter((r) => r.memberUserId == null).length,
      unreachableTeamCount: whole.length - wholeHere.size,
      revision: g.revision ?? 0,
    };
  });
}

function byTeamThenName(a: ConnectionWorkspace, b: ConnectionWorkspace): number {
  return a.teamName.localeCompare(b.teamName) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

/**
 * Per-workspace connections from before grants: a live refresh token bound
 * to a workspace the user still reaches, one row per app and workspace.
 */
async function legacyConnections(userId: string): Promise<LegacyConnectionSummary[]> {
  const rows = await db
    .select({
      clientId: oauthRefreshTokens.clientId,
      clientName: oauthClients.clientName,
      workspaceId: workspaces.id,
      workspaceName: workspaces.name,
      last: max(oauthRefreshTokens.createdAt),
    })
    .from(oauthRefreshTokens)
    .innerJoin(workspaces, eq(workspaces.id, oauthRefreshTokens.workspaceId))
    .innerJoin(teamMembers, and(eq(teamMembers.teamId, workspaces.teamId), eq(teamMembers.userId, userId)))
    .leftJoin(oauthClients, eq(oauthClients.clientId, oauthRefreshTokens.clientId))
    .where(and(
      eq(oauthRefreshTokens.userId, userId),
      isNotNull(oauthRefreshTokens.workspaceId),
      isNull(oauthRefreshTokens.revokedAt),
      gt(oauthRefreshTokens.expiresAt, new Date()),
    ))
    .groupBy(oauthRefreshTokens.clientId, oauthClients.clientName, workspaces.id, workspaces.name);
  return rows
    .map((r) => ({
      clientName: r.clientName?.trim() || UNNAMED_CLIENT,
      workspaceName: r.workspaceName,
      lastActiveAt: new Date(r.last as unknown as string).toISOString(),
    }))
    .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt) || a.workspaceName.localeCompare(b.workspaceName));
}

/** Every active connection the user owns, plus their legacy per-workspace ones. */
export async function listUserConnections(userId: string): Promise<UserConnections> {
  if (!isUuid(userId)) return { connections: [], legacy: [] };
  const [connections, legacy] = await Promise.all([summarise(userId, null), legacyConnections(userId)]);
  return { connections, legacy };
}

/** The grant's rows as they are now: specific workspaces (with their team) and whole teams. */
async function grantRowsNow(grantId: string): Promise<{ specific: Array<{ workspaceId: string; teamId: string }>; whole: string[] }> {
  const [specific, whole] = await Promise.all([
    db
      .select({ workspaceId: mcpOauthGrantWorkspaces.workspaceId, teamId: workspaces.teamId })
      .from(mcpOauthGrantWorkspaces)
      .innerJoin(workspaces, eq(workspaces.id, mcpOauthGrantWorkspaces.workspaceId))
      .where(eq(mcpOauthGrantWorkspaces.grantId, grantId)),
    db
      .select({ teamId: mcpOauthGrantTeams.teamId })
      .from(mcpOauthGrantTeams)
      .where(eq(mcpOauthGrantTeams.grantId, grantId)),
  ]);
  return { specific, whole: whole.map((r) => r.teamId) };
}

/** How many workspaces a connection with these rows would reach for the user now. */
async function reachableCount(userId: string, specificIds: string[], wholeTeamIds: string[]): Promise<number> {
  const [specific, teamsNow] = await Promise.all([memberWorkspaces(userId, specificIds), memberTeamIds(userId, wholeTeamIds)]);
  const ids = new Set(specific.map((w) => w.workspaceId));
  if (teamsNow.length > 0) {
    const rows = await db
      .select({ id: workspaces.id, name: workspaces.name })
      .from(workspaces)
      .where(inArray(workspaces.teamId, teamsNow));
    for (const r of rows) if (!isSystemWorkspace(r.name)) ids.add(r.id);
  }
  return ids.size;
}

function snapshot(scopes: McpGrantScope[], actsAs: McpGrantActsAs, whole: Iterable<string>, specific: Iterable<string>): GrantReachSnapshot {
  return {
    access: scopes.includes('write') ? 'read-write' : 'read',
    actsAs,
    wholeTeamIds: [...new Set(whole)].sort(),
    specificWorkspaceIds: [...new Set(specific)].sort(),
  };
}

/**
 * Apply a change to one of the user's own connections. Every check happens
 * before the first write; there are no interactive transactions on
 * neon-http, so the writes go narrowing first (the grant row, then a team
 * frozen to specific workspaces, then removals) and widening last (added
 * workspaces, then teams on all workspaces). Each write keeps the owner in its
 * WHERE, and the grant row update is conditional on the revision read here, so
 * two edits made against the same revision cannot both apply.
 */
export async function updateUserGrant(userId: string, grantId: string, patch: GrantPatch): Promise<{ ok: true; connection: ConnectionSummary } | ManageError> {
  if (!isUuid(userId) || !isUuid(grantId)) return GRANT_NOT_FOUND;
  const grant = await getActiveGrant(grantId, userId);
  if (!grant) return GRANT_NOT_FOUND;
  const revision = grant.revision ?? 0;
  const current = async () => (await summarise(userId, [grantId]))[0];
  if (patch.ifRevision !== undefined && patch.ifRevision !== revision) return staleConnection(await current());

  // Every id the change names is checked against the user's teams now.
  const add = patch.addWorkspaceIds;
  // 'none' is a freeze to nothing: the team's rows go, whole and specific.
  const frozen = patch.teams
    .filter((t) => t.mode !== 'all')
    .map((t) => ({ teamId: t.teamId, workspaceIds: t.mode === 'specific' ? t.workspaceIds : [] as string[] }));
  const toAll = patch.teams.filter((t) => t.mode === 'all').map((t) => t.teamId);
  const namedTeams = patch.teams.map((t) => t.teamId);
  if (!namedTeams.every(isUuid)) return TEAM_NOT_ACCESSIBLE;
  if ((await memberTeamIds(userId, namedTeams)).length !== namedTeams.length) return TEAM_NOT_ACCESSIBLE;

  const named = [...new Set([...add, ...frozen.flatMap((t) => t.workspaceIds)])];
  if (!named.every(isUuid)) return WORKSPACE_NOT_ACCESSIBLE;
  const reachable = await memberWorkspaces(userId, named);
  if (reachable.length !== named.length) return WORKSPACE_NOT_ACCESSIBLE;
  const teamOf = new Map(reachable.map((w) => [w.workspaceId, w.teamId]));
  // A team frozen to specific workspaces takes only workspaces of that team.
  if (frozen.some((t) => t.workspaceIds.some((id) => teamOf.get(id) !== t.teamId))) return WORKSPACE_NOT_ACCESSIBLE;
  const addedTeamIds = [...new Set(add.map((id) => teamOf.get(id)!))];
  const remove = patch.removeWorkspaceIds.filter(isUuid);

  // The state after the change, computed before anything is written.
  const before = await grantRowsNow(grantId);
  const wholeAfter = new Set(before.whole);
  for (const t of frozen) wholeAfter.delete(t.teamId);
  for (const t of toAll) wholeAfter.add(t);
  const specificAfter = new Map(before.specific.map((r) => [r.workspaceId, r.teamId]));
  for (const t of frozen) {
    for (const [id, team] of specificAfter) if (team === t.teamId) specificAfter.delete(id);
    for (const id of t.workspaceIds) specificAfter.set(id, t.teamId);
  }
  for (const id of add) specificAfter.set(id, teamOf.get(id)!);

  // Removing one workspace cannot take it from a team the connection has as
  // a whole: it would still be reached. Say so instead of appearing to work.
  if (remove.length > 0) {
    const rows = await db.select({ id: workspaces.id, teamId: workspaces.teamId }).from(workspaces).where(inArray(workspaces.id, remove));
    if (rows.some((r) => wholeAfter.has(r.teamId))) return INHERITED_FROM_TEAM;
  }
  for (const id of remove) specificAfter.delete(id);

  // The connection must still reach a workspace afterwards; to drop the last
  // one, revoke it instead.
  if ((await reachableCount(userId, [...specificAfter.keys()], [...wholeAfter])) === 0) {
    return invalidGrantPatch('A connection needs at least one workspace you can reach. Revoke it instead.');
  }

  const scopes: McpGrantScope[] = patch.access === undefined ? grant.scopes : patch.access === 'read-write' ? ['read', 'write'] : ['read'];
  const actsAs: McpGrantActsAs = patch.actsAs === 'agent' ? 'agent' : grant.actsAs;
  const now = new Date();
  const updated = await db
    .update(mcpOauthGrants)
    .set({ scopes, ...(patch.actsAs === 'agent' ? { actsAs: 'agent' as const } : {}), updatedAt: now, revision: revision + 1 })
    .where(and(eq(mcpOauthGrants.id, grantId), eq(mcpOauthGrants.userId, userId), isNull(mcpOauthGrants.revokedAt), eq(mcpOauthGrants.revision, revision)))
    .returning({ id: mcpOauthGrants.id });
  if (updated.length === 0) {
    // Revoked meanwhile, or another edit landed first: never write over it.
    const still = await getActiveGrant(grantId, userId);
    return still ? staleConnection(await current()) : GRANT_NOT_FOUND;
  }
  // Narrowing first, as the writes: a token on this grant stops using the old
  // scopes now, and is cleared again once the workspaces have changed.
  await clearCallerCache(callerDep.grant(grantId));

  for (const t of frozen) {
    // Freeze exactly the reviewed selection: keep those first, so a workspace
    // that stays is reachable throughout, then drop the team and the rest.
    if (t.workspaceIds.length > 0) {
      await db
        .insert(mcpOauthGrantWorkspaces)
        .values(t.workspaceIds.map((workspaceId) => ({ grantId, workspaceId })))
        .onConflictDoNothing();
    }
    await db.delete(mcpOauthGrantTeams).where(and(eq(mcpOauthGrantTeams.grantId, grantId), eq(mcpOauthGrantTeams.teamId, t.teamId)));
    const drop = before.specific.filter((r) => r.teamId === t.teamId && !t.workspaceIds.includes(r.workspaceId)).map((r) => r.workspaceId);
    if (drop.length > 0) {
      await db.delete(mcpOauthGrantWorkspaces).where(and(eq(mcpOauthGrantWorkspaces.grantId, grantId), inArray(mcpOauthGrantWorkspaces.workspaceId, drop)));
    }
  }
  if (remove.length > 0) {
    await db
      .delete(mcpOauthGrantWorkspaces)
      .where(and(eq(mcpOauthGrantWorkspaces.grantId, grantId), inArray(mcpOauthGrantWorkspaces.workspaceId, remove)));
  }
  // A team joined after connecting has no session account until a token is
  // issued for it. Provision it now, so an added workspace or team works on
  // the next request on the app's current access token, not after a refresh.
  for (const teamId of new Set([...addedTeamIds, ...toAll])) await ensureTeamSessionAccount(userId, teamId);
  if (add.length > 0) {
    await db
      .insert(mcpOauthGrantWorkspaces)
      .values(add.map((workspaceId) => ({ grantId, workspaceId })))
      .onConflictDoNothing();
  }
  if (toAll.length > 0) {
    await db
      .insert(mcpOauthGrantTeams)
      .values(toAll.map((teamId) => ({ grantId, teamId })))
      .onConflictDoNothing();
  }

  // The grant row is the authority; the scope string on outstanding refresh
  // tokens is only what the next token response reports. Keep it honest.
  await db
    .update(oauthRefreshTokens)
    .set({ scope: grantedScopeString(scopes, actsAs) })
    .where(and(eq(oauthRefreshTokens.grantId, grantId), eq(oauthRefreshTokens.userId, userId), isNull(oauthRefreshTokens.revokedAt)));
  // Tokens on this grant re-read what it reaches on their next call.
  await clearCallerCache(callerDep.grant(grantId));

  await recordGrantEvent(
    grantId,
    userId,
    'connection.updated',
    snapshot(grant.scopes, grant.actsAs, before.whole, before.specific.map((r) => r.workspaceId)),
    snapshot(scopes, actsAs, wholeAfter, specificAfter.keys()),
  );

  const connection = await current();
  if (!connection) return GRANT_NOT_FOUND;
  return { ok: true, connection };
}
