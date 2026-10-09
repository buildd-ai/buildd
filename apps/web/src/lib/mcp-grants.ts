/**
 * Account-level MCP OAuth grants (docs/specs/auth-oauth-boundaries.md,
 * "Account-level MCP grants").
 *
 * A grant is one user's consent for one OAuth client to reach a chosen set of
 * workspaces, acting either as the user ('person') or as the user's agent
 * ('agent'). An access or refresh token names the grant by id and never lists
 * workspaces, so what a token reaches is decided here, server-side, on every
 * request and at every refresh:
 *
 *   reachable = the grant's workspaces ∩ workspaces whose team the user is a
 *               member of right now
 *
 * A revoked or expired grant, a removed membership, a deleted workspace or a
 * workspace moved to a team the user is not in all drop out immediately; no
 * token claim can widen the set. New workspaces are never added to a grant
 * implicitly.
 *
 * A legacy token (a `workspace_id` claim, from the per-workspace connection)
 * is treated as an implicit single-workspace 'person' grant, so existing
 * installs keep working unchanged.
 */
import { and, asc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import {
  githubRepos,
  mcpOauthGrants,
  mcpOauthGrantWorkspaces,
  oauthRefreshTokens,
  teamMembers,
  teams,
  workspaces,
  type McpGrantActsAs,
  type McpGrantScope,
} from '@buildd/core/db/schema';
import { isGrantClaims, type AnyAccessTokenClaims } from './oauth/tokens';
import { levelForTeamRole } from './oauth/session-level';
import { normalizedRepoSql } from './repo-scope';

export type { McpGrantActsAs, McpGrantScope };

export const GRANT_ACTS_AS: readonly McpGrantActsAs[] = ['person', 'agent'];
export const GRANT_SCOPES: readonly McpGrantScope[] = ['read', 'write'];

export interface GrantedWorkspace {
  workspaceId: string;
  teamId: string;
  /** The user's current role on the workspace's team. */
  role: string | null;
}

export interface ResolvedGrant {
  /** null for a legacy workspace-claim token (implicit grant). */
  grantId: string | null;
  userId: string;
  clientId: string;
  actsAs: McpGrantActsAs;
  scopes: McpGrantScope[];
  /** Granted ∩ current membership, ordered by workspace id. */
  workspaces: GrantedWorkspace[];
}

/** Who a request on a grant acts as. */
export interface GrantPrincipal {
  actsAs: McpGrantActsAs;
  /** The user the request is attributed to, either kind. */
  oauthUserId: string;
  /**
   * The person principal (lib/request-person.ts). Set only on a 'person'
   * grant: an 'agent' grant never carries one, so every person-only action
   * refuses it.
   */
  sessionUserId?: string;
  /** Workflow-kernel actor string. */
  actor: `human:${string}` | `agent:oauth:${string}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

function isActsAs(v: unknown): v is McpGrantActsAs {
  return typeof v === 'string' && (GRANT_ACTS_AS as readonly string[]).includes(v);
}

function normaliseScopes(v: unknown): McpGrantScope[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  if (!v.every((s) => typeof s === 'string' && (GRANT_SCOPES as readonly string[]).includes(s))) return null;
  return GRANT_SCOPES.filter((s) => v.includes(s));
}

/** Workspaces among `workspaceIds` whose team the user is a member of now. */
async function memberWorkspaces(userId: string, workspaceIds: string[]): Promise<GrantedWorkspace[]> {
  if (workspaceIds.length === 0) return [];
  const rows = await db
    .select({ workspaceId: workspaces.id, teamId: workspaces.teamId, role: teamMembers.role })
    .from(workspaces)
    .innerJoin(teamMembers, and(eq(teamMembers.teamId, workspaces.teamId), eq(teamMembers.userId, userId)))
    .where(inArray(workspaces.id, workspaceIds))
    .orderBy(asc(workspaces.id));
  return rows.map((r) => ({ workspaceId: r.workspaceId, teamId: r.teamId, role: r.role ?? null }));
}

export type CreateGrantResult =
  | { ok: true; grantId: string }
  | { ok: false; error: 'invalid_request' | 'workspace_not_accessible' };

/**
 * Record a grant. Every workspace must be one the user can reach right now;
 * if any is not, nothing is written and the error names none of them (a
 * caller cannot use it to probe which workspace ids exist).
 */
export async function createGrant(args: {
  userId: string;
  clientId: string;
  actsAs: McpGrantActsAs;
  scopes: McpGrantScope[];
  workspaceIds: string[];
  expiresAt?: Date | null;
}): Promise<CreateGrantResult> {
  if (!isUuid(args.userId) || !args.clientId || !isActsAs(args.actsAs)) return { ok: false, error: 'invalid_request' };
  const scopes = normaliseScopes(args.scopes);
  if (!scopes) return { ok: false, error: 'invalid_request' };
  const ids = [...new Set(args.workspaceIds)];
  if (ids.length === 0) return { ok: false, error: 'invalid_request' };
  if (!ids.every(isUuid)) return { ok: false, error: 'workspace_not_accessible' };

  const reachable = await memberWorkspaces(args.userId, ids);
  if (reachable.length !== ids.length) return { ok: false, error: 'workspace_not_accessible' };

  const [grant] = await db.insert(mcpOauthGrants).values({
    userId: args.userId,
    clientId: args.clientId,
    actsAs: args.actsAs,
    scopes,
    expiresAt: args.expiresAt ?? null,
  }).returning({ id: mcpOauthGrants.id });
  if (!grant) return { ok: false, error: 'invalid_request' };

  try {
    await db.insert(mcpOauthGrantWorkspaces).values(ids.map((workspaceId) => ({ grantId: grant.id, workspaceId })));
  } catch (err) {
    // No interactive transactions on neon-http. A grant without its workspace
    // rows reaches nothing, but do not leave one behind.
    await db.delete(mcpOauthGrants).where(eq(mcpOauthGrants.id, grant.id)).catch(() => {});
    throw err;
  }
  return { ok: true, grantId: grant.id };
}

/** The grant row, if it is the user's and still active (not revoked, not expired). */
export async function getActiveGrant(grantId: string, userId: string) {
  if (!isUuid(grantId) || !isUuid(userId)) return null;
  const now = new Date();
  const rows = await db
    .select({
      id: mcpOauthGrants.id,
      userId: mcpOauthGrants.userId,
      clientId: mcpOauthGrants.clientId,
      actsAs: mcpOauthGrants.actsAs,
      scopes: mcpOauthGrants.scopes,
    })
    .from(mcpOauthGrants)
    .where(and(
      eq(mcpOauthGrants.id, grantId),
      eq(mcpOauthGrants.userId, userId),
      isNull(mcpOauthGrants.revokedAt),
      or(isNull(mcpOauthGrants.expiresAt), gt(mcpOauthGrants.expiresAt, now)),
    ))
    .limit(1);
  const row = rows[0];
  if (!row || !isActsAs(row.actsAs)) return null;
  const scopes = normaliseScopes(row.scopes);
  if (!scopes) return null;
  return { ...row, actsAs: row.actsAs, scopes };
}

/**
 * The workspaces a grant reaches right now: its workspaces ∩ the user's
 * current team memberships. Empty for a grant that is not the user's, is
 * revoked or has expired. One query; every predicate is in SQL.
 */
export async function resolveGrantedWorkspaces(grantId: string, userId: string): Promise<GrantedWorkspace[]> {
  if (!isUuid(grantId) || !isUuid(userId)) return [];
  const now = new Date();
  const rows = await db
    .select({ workspaceId: workspaces.id, teamId: workspaces.teamId, role: teamMembers.role })
    .from(mcpOauthGrants)
    .innerJoin(mcpOauthGrantWorkspaces, eq(mcpOauthGrantWorkspaces.grantId, mcpOauthGrants.id))
    .innerJoin(workspaces, eq(workspaces.id, mcpOauthGrantWorkspaces.workspaceId))
    .innerJoin(teamMembers, and(eq(teamMembers.teamId, workspaces.teamId), eq(teamMembers.userId, mcpOauthGrants.userId)))
    .where(and(
      eq(mcpOauthGrants.id, grantId),
      eq(mcpOauthGrants.userId, userId),
      isNull(mcpOauthGrants.revokedAt),
      or(isNull(mcpOauthGrants.expiresAt), gt(mcpOauthGrants.expiresAt, now)),
    ))
    .orderBy(asc(workspaces.id));
  return rows.map((r) => ({ workspaceId: r.workspaceId, teamId: r.teamId, role: r.role ?? null }));
}

/**
 * A grant with what it reaches now, or null when the grant is not usable by
 * this user and client (absent, someone else's, revoked, expired, or issued to
 * a different client). A usable grant can still reach no workspace; callers
 * treat an empty list as no access.
 */
export async function resolveGrant(grantId: string, userId: string, clientId: string): Promise<ResolvedGrant | null> {
  const grant = await getActiveGrant(grantId, userId);
  if (!grant || grant.clientId !== clientId) return null;
  const reachable = await resolveGrantedWorkspaces(grantId, userId);
  return {
    grantId: grant.id,
    userId,
    clientId: grant.clientId,
    actsAs: grant.actsAs,
    scopes: grant.scopes,
    workspaces: reachable,
  };
}

/**
 * A legacy workspace-claim token as an implicit grant: that one workspace,
 * acting as the person, while the user is still a member of its team.
 */
export async function resolveLegacyGrant(userId: string, workspaceId: string, clientId: string): Promise<ResolvedGrant> {
  const implicit = { grantId: null, userId, clientId, actsAs: 'person' as const, scopes: [...GRANT_SCOPES] };
  // The same two lookups the per-workspace connection always made.
  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    columns: { teamId: true },
  });
  if (!workspace) return { ...implicit, workspaces: [] };
  const membership = await db.query.teamMembers.findFirst({
    where: and(eq(teamMembers.teamId, workspace.teamId), eq(teamMembers.userId, userId)),
    columns: { role: true },
  });
  if (!membership) return { ...implicit, workspaces: [] };
  return { ...implicit, workspaces: [{ workspaceId, teamId: workspace.teamId, role: membership.role ?? null }] };
}

/** Resolve whichever kind of verified access token this is. */
export async function resolveTokenGrant(claims: AnyAccessTokenClaims): Promise<ResolvedGrant | null> {
  if (isGrantClaims(claims)) return resolveGrant(claims.grant_id, claims.sub, claims.client_id);
  return resolveLegacyGrant(claims.sub, claims.workspace_id, claims.client_id);
}

/** The granted workspace entry for one workspace, or null (never a reason). */
export function grantedWorkspace(grant: ResolvedGrant, workspaceId: string): GrantedWorkspace | null {
  return grant.workspaces.find((w) => w.workspaceId === workspaceId) ?? null;
}

/** Who requests on this grant act as. The kind comes only from the grant row. */
export function grantPrincipal(grant: Pick<ResolvedGrant, 'actsAs' | 'userId'>): GrantPrincipal {
  if (grant.actsAs === 'person') {
    return { actsAs: 'person', oauthUserId: grant.userId, sessionUserId: grant.userId, actor: `human:${grant.userId}` };
  }
  return { actsAs: 'agent', oauthUserId: grant.userId, actor: `agent:oauth:${grant.userId}` };
}

/**
 * Revoke a grant and every refresh token issued under it. Access tokens on it
 * stop resolving on their next request. True when this call revoked it.
 */
export async function revokeGrant(grantId: string, userId: string): Promise<boolean> {
  if (!isUuid(grantId) || !isUuid(userId)) return false;
  const now = new Date();
  const rows = await db
    .update(mcpOauthGrants)
    .set({ revokedAt: now, updatedAt: now })
    .where(and(eq(mcpOauthGrants.id, grantId), eq(mcpOauthGrants.userId, userId), isNull(mcpOauthGrants.revokedAt)))
    .returning({ id: mcpOauthGrants.id });
  await revokeRefreshTokensForGrant(grantId);
  return rows.length > 0;
}

/** Revoke every outstanding refresh token issued under a grant. */
export async function revokeRefreshTokensForGrant(grantId: string): Promise<void> {
  if (!isUuid(grantId)) return;
  await db
    .update(oauthRefreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(oauthRefreshTokens.grantId, grantId), isNull(oauthRefreshTokens.revokedAt)));
}

// ── Per-request workspace resolution (the canonical /api/mcp transport) ─────

/**
 * The token scopes a grant's read/write scopes map to on the generic auth
 * path. A read-only grant becomes a scoped session that can only read
 * (lib/token-route-policy.ts and the MCP scope gate both enforce it); a grant
 * with write keeps the user's role-level permissions (null = legacy level
 * gates). A grant can only narrow what the user's role allows, never widen it.
 */
export const READ_GRANT_TOKEN_SCOPES: readonly string[] = ['tasks:read', 'analytics:read'];
export function grantTokenScopes(scopes: readonly McpGrantScope[]): string[] | null {
  return scopes.includes('write') ? null : [...READ_GRANT_TOKEN_SCOPES];
}

/** One workspace a grant reaches, with what a client needs to pick it. */
export interface GrantWorkspaceChoice {
  workspaceId: string;
  name: string;
  /** Bare lowercase owner/name, when the workspace has a repo. */
  repo: string | null;
  teamId: string;
  teamName: string;
  /** The level the session acts at in this workspace (the user's team role). */
  level: 'admin' | 'worker';
  /** What the grant allows here. */
  access: 'read' | 'read-write';
}

/**
 * Names, repos and teams of exactly the workspaces `grant` reaches now. Only
 * ids already in the grant ∩ membership set are queried, so nothing outside
 * it can appear.
 */
export async function describeGrantWorkspaces(grant: ResolvedGrant): Promise<GrantWorkspaceChoice[]> {
  const ids = grant.workspaces.map((w) => w.workspaceId);
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      workspaceId: workspaces.id,
      name: workspaces.name,
      repo: normalizedRepoSql(workspaces.repo),
      githubFullName: githubRepos.fullName,
      teamName: teams.name,
    })
    .from(workspaces)
    .innerJoin(teams, eq(teams.id, workspaces.teamId))
    .leftJoin(githubRepos, eq(githubRepos.id, workspaces.githubRepoId))
    .where(inArray(workspaces.id, ids));
  const byId = new Map(rows.map((r) => [r.workspaceId, r]));
  const access = grant.scopes.includes('write') ? 'read-write' as const : 'read' as const;
  const out: GrantWorkspaceChoice[] = [];
  for (const w of grant.workspaces) {
    const r = byId.get(w.workspaceId);
    if (!r) continue;
    const repo = (r.githubFullName?.toLowerCase() || (r.repo as unknown as string) || '') || null;
    out.push({ workspaceId: w.workspaceId, name: r.name, repo, teamId: w.teamId, teamName: r.teamName, level: levelForTeamRole(w.role), access });
  }
  return out.sort((a, b) => a.teamName.localeCompare(b.teamName) || a.name.localeCompare(b.name) || a.workspaceId.localeCompare(b.workspaceId));
}

export type GrantWorkspaceResolution =
  | { kind: 'ok'; workspace: GrantWorkspaceChoice }
  /** No reference and more than one workspace: the caller must name one. */
  | { kind: 'required'; choices: GrantWorkspaceChoice[] }
  /** The reference matches more than one granted workspace. */
  | { kind: 'ambiguous'; ref: string; choices: GrantWorkspaceChoice[] }
  /** The reference matches no granted workspace (whether or not it exists). */
  | { kind: 'not_granted'; ref: string; choices: GrantWorkspaceChoice[] };

/**
 * Resolve a caller's workspace reference (UUID, owner/repo, repo name or
 * workspace name) among the granted workspaces only. Never a lookup outside
 * that set, so a similarly named workspace the grant does not cover can
 * neither match nor be named; a reference to one reads exactly like a
 * reference to nothing. With no reference, exactly one granted workspace is
 * the answer and more than one is `required`: nothing picks a default.
 */
export function resolveGrantWorkspaceRef(choices: GrantWorkspaceChoice[], ref: string | null | undefined): GrantWorkspaceResolution {
  const raw = typeof ref === 'string' ? ref.trim() : '';
  if (!raw) {
    return choices.length === 1 ? { kind: 'ok', workspace: choices[0] } : { kind: 'required', choices };
  }
  if (UUID_RE.test(raw)) {
    const hit = choices.find((c) => c.workspaceId.toLowerCase() === raw.toLowerCase());
    return hit ? { kind: 'ok', workspace: hit } : { kind: 'not_granted', ref: raw, choices };
  }
  const want = raw.toLowerCase()
    .replace(/^(https?:\/\/(www\.)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)/, '')
    .replace(/(\.git)?\/*$/, '');
  const matches = want.includes('/')
    ? choices.filter((c) => c.repo === want)
    : choices.filter((c) => c.name.toLowerCase() === want || (c.repo != null && c.repo.split('/')[1] === want));
  if (matches.length === 1) return { kind: 'ok', workspace: matches[0] };
  if (matches.length > 1) return { kind: 'ambiguous', ref: raw, choices: matches };
  return { kind: 'not_granted', ref: raw, choices };
}
