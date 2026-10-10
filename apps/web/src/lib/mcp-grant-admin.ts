/**
 * Managing your own MCP connections from Settings
 * (docs/specs/auth-oauth-boundaries.md, "Managing connections").
 *
 * A connection is an account-level grant (lib/mcp-grants.ts). Its owner can
 * list it, add or remove workspaces, switch it between read and read-write,
 * downgrade it from acting as them to acting as their agent, and revoke it.
 *
 * Rules every function here keeps:
 *  - Only the owner's grants. Every statement carries `user_id = <owner>`, so
 *    another user's grant id reads exactly like an id that does not exist.
 *  - Adding a workspace re-checks, here and now, that the owner is on its
 *    team. One unreachable id refuses the whole change and the refusal names
 *    no id.
 *  - Never person from agent. Acting as the person needs a fresh consent with
 *    the person scope; the only kind this module ever writes is 'agent'.
 *  - Grant sessions are resolved on every request and never cached
 *    (lib/api-auth.ts), so an edit or a revoke applies on the next request.
 *    Revoke also revokes every refresh token under the grant, in every family.
 */
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, max, or } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import {
  mcpOauthGrants,
  mcpOauthGrantWorkspaces,
  oauthClients,
  oauthRefreshTokens,
  teamMembers,
  teams,
  workspaces,
  type McpGrantActsAs,
  type McpGrantScope,
} from '@buildd/core/db/schema';
import { getActiveGrant, memberWorkspaces } from './mcp-grants';
import { grantedScopeString, type ConsentTeam } from './oauth/account-consent';
import { ensureTeamSessionAccount } from './oauth/ensure-session-account';
import {
  GRANT_NOT_FOUND,
  WORKSPACE_NOT_ACCESSIBLE,
  invalidGrantPatch,
  type ConnectionAccess,
  type ConnectionSummary,
  type GrantPatch,
  type LegacyConnectionSummary,
  type ManageError,
  type UserConnections,
} from './mcp-grant-patch';

export * from './mcp-grant-patch';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

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
    .select({ id: workspaces.id, name: workspaces.name, teamId: workspaces.teamId })
    .from(workspaces)
    .where(inArray(workspaces.teamId, memberships.map((m) => m.teamId)))
    .orderBy(asc(workspaces.name), asc(workspaces.id));
  return memberships
    .map((m) => ({
      id: m.teamId,
      name: m.name,
      role: (m.role as string | null) ?? null,
      workspaces: rows.filter((w) => w.teamId === m.teamId).map((w) => ({ id: w.id, name: w.name })),
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

  const [wsRows, activity] = await Promise.all([
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
      .select({ grantId: oauthRefreshTokens.grantId, last: max(oauthRefreshTokens.createdAt) })
      .from(oauthRefreshTokens)
      .where(and(inArray(oauthRefreshTokens.grantId, ids), eq(oauthRefreshTokens.userId, userId)))
      .groupBy(oauthRefreshTokens.grantId),
  ]);
  const lastByGrant = new Map(activity.map((a) => [a.grantId, a.last]));

  return grantRows.map((g) => {
    const mine = wsRows.filter((r) => r.grantId === g.id);
    const reachable = mine
      .filter((r) => r.memberUserId != null)
      .map((r) => ({ id: r.id, name: r.name, teamId: r.teamId, teamName: r.teamName }))
      .sort((a, b) => a.teamName.localeCompare(b.teamName) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const last = lastByGrant.get(g.id);
    return {
      id: g.id,
      clientName: g.clientName?.trim() || UNNAMED_CLIENT,
      actsAs: g.actsAs === 'person' ? 'person' : 'agent',
      access: accessOf(g.scopes),
      createdAt: g.createdAt.toISOString(),
      lastActiveAt: last ? new Date(last).toISOString() : null,
      expiresAt: g.expiresAt ? g.expiresAt.toISOString() : null,
      workspaces: reachable,
      unreachableCount: mine.length - reachable.length,
    };
  });
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

/**
 * Apply a change to one of the user's own connections. Every check happens
 * before the first write; there are no interactive transactions on
 * neon-http, so the writes go narrowing first (the grant row, then removals)
 * and widening last (additions). Each write keeps the owner in its WHERE.
 */
export async function updateUserGrant(userId: string, grantId: string, patch: GrantPatch): Promise<{ ok: true; connection: ConnectionSummary } | ManageError> {
  if (!isUuid(userId) || !isUuid(grantId)) return GRANT_NOT_FOUND;
  const grant = await getActiveGrant(grantId, userId);
  if (!grant) return GRANT_NOT_FOUND;

  const add = patch.addWorkspaceIds;
  let addedTeamIds: string[] = [];
  if (add.length > 0) {
    if (!add.every(isUuid)) return WORKSPACE_NOT_ACCESSIBLE;
    const reachable = await memberWorkspaces(userId, add);
    if (reachable.length !== add.length) return WORKSPACE_NOT_ACCESSIBLE;
    addedTeamIds = [...new Set(reachable.map((w) => w.teamId))];
  }
  const remove = patch.removeWorkspaceIds.filter(isUuid);

  // The connection must still reach a workspace afterwards; to drop the last
  // one, revoke it instead.
  const current = await db
    .select({ workspaceId: mcpOauthGrantWorkspaces.workspaceId })
    .from(mcpOauthGrantWorkspaces)
    .where(eq(mcpOauthGrantWorkspaces.grantId, grantId));
  const after = new Set([...current.map((r) => r.workspaceId), ...add]);
  for (const id of remove) after.delete(id);
  const stillReached = after.size > 0 ? await memberWorkspaces(userId, [...after]) : [];
  if (stillReached.length === 0) {
    return invalidGrantPatch('A connection needs at least one workspace you can reach. Revoke it instead.');
  }

  const scopes: McpGrantScope[] = patch.access === undefined ? grant.scopes : patch.access === 'read-write' ? ['read', 'write'] : ['read'];
  const actsAs: McpGrantActsAs = patch.actsAs === 'agent' ? 'agent' : grant.actsAs;
  const now = new Date();
  const updated = await db
    .update(mcpOauthGrants)
    .set({ scopes, ...(patch.actsAs === 'agent' ? { actsAs: 'agent' as const } : {}), updatedAt: now })
    .where(and(eq(mcpOauthGrants.id, grantId), eq(mcpOauthGrants.userId, userId), isNull(mcpOauthGrants.revokedAt)))
    .returning({ id: mcpOauthGrants.id });
  if (updated.length === 0) return GRANT_NOT_FOUND;

  if (remove.length > 0) {
    await db
      .delete(mcpOauthGrantWorkspaces)
      .where(and(eq(mcpOauthGrantWorkspaces.grantId, grantId), inArray(mcpOauthGrantWorkspaces.workspaceId, remove)));
  }
  if (add.length > 0) {
    // A team joined after connecting has no session account until a token is
    // issued for it. Provision it now, so the added workspace works on the
    // next request on the app's current access token, not after a refresh.
    for (const teamId of addedTeamIds) await ensureTeamSessionAccount(userId, teamId);
    await db
      .insert(mcpOauthGrantWorkspaces)
      .values(add.map((workspaceId) => ({ grantId, workspaceId })))
      .onConflictDoNothing();
  }

  // The grant row is the authority; the scope string on outstanding refresh
  // tokens is only what the next token response reports. Keep it honest.
  await db
    .update(oauthRefreshTokens)
    .set({ scope: grantedScopeString(scopes, actsAs) })
    .where(and(eq(oauthRefreshTokens.grantId, grantId), eq(oauthRefreshTokens.userId, userId), isNull(oauthRefreshTokens.revokedAt)));

  const [connection] = await summarise(userId, [grantId]);
  if (!connection) return GRANT_NOT_FOUND;
  return { ok: true, connection };
}
