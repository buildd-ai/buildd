/**
 * Shared pieces of the account-level MCP transport (/api/mcp on a grant
 * token) and of the deprecated per-workspace endpoint
 * (/api/mcp-oauth/[workspace]). Route files may export only handlers, so
 * what both routes and their tests read lives here.
 */
import type { ToolResult, WorkspaceListing } from '@buildd/core/mcp-tools';
import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { missions, tasks, workers } from '@buildd/core/db/schema';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { getIssuer } from './oauth/config';
import { resolveGrantWorkspaceRef, type GrantWorkspaceChoice, type GrantWorkspaceResolution } from './mcp-grants';
import { isUuid } from './uuid';

/** How many choices a workspace refusal lists before pointing at list_workspaces. */
export const GRANT_CHOICES_SHOWN = 20;

export function toListing(c: GrantWorkspaceChoice): WorkspaceListing {
  return { workspaceId: c.workspaceId, name: c.name, repo: c.repo, teamId: c.teamId, teamName: c.teamName, level: c.level, access: c.access };
}

/**
 * The structured refusal for a call whose workspace cannot be resolved among
 * the grant. Lists granted workspaces only, and never echoes the reference:
 * a workspace the grant does not cover reads exactly like one that does not
 * exist.
 */
export function grantWorkspaceRefusal(r: Exclude<GrantWorkspaceResolution, { kind: 'ok' }>): ToolResult {
  const error = r.kind === 'required' ? 'workspace_required' : r.kind === 'ambiguous' ? 'workspace_ambiguous' : 'workspace_not_granted';
  const message = r.kind === 'required'
    ? 'This connection reaches more than one workspace. Pass workspaceId (UUID, owner/repo or name) in params; nothing is picked for you.'
    : r.kind === 'ambiguous'
      ? 'That name matches more than one workspace this connection reaches. Pass the workspace id instead.'
      : 'That workspace is not one this connection reaches. Choose one of the workspaces granted to it.';
  const choices = r.choices.slice(0, GRANT_CHOICES_SHOWN).map((c) => ({
    workspaceId: c.workspaceId, name: c.name, ...(c.repo ? { repo: c.repo } : {}), team: c.teamName,
  }));
  return {
    isError: true,
    content: [{
      type: 'text',
      text: JSON.stringify({
        error,
        message,
        choices,
        ...(r.choices.length > choices.length ? { more: r.choices.length - choices.length } : {}),
        hint: 'list_workspaces lists every workspace this connection can act in.',
      }),
    }],
  };
}

export type GrantCreateTarget =
  | { kind: 'ok'; workspace: GrantWorkspaceChoice }
  | { kind: 'refused'; result: ToolResult };

function teamRefusal(error: 'team_required' | 'team_not_granted', choices: GrantWorkspaceChoice[]): ToolResult {
  const teams = new Map<string, { teamId: string; name: string; level: 'admin' | 'worker' }>();
  for (const c of choices) {
    const t = teams.get(c.teamId);
    // Creating needs team admin; show the best level the connection has there.
    if (!t || (t.level !== 'admin' && c.level === 'admin')) teams.set(c.teamId, { teamId: c.teamId, name: c.teamName, level: c.level });
  }
  return {
    isError: true,
    content: [{
      type: 'text',
      text: JSON.stringify({
        error,
        message: error === 'team_required'
          ? 'This connection reaches more than one team. Pass teamId (team id or name) in params to say which team the workspace is created in; nothing is picked for you.'
          : 'That team is not one this connection reaches. Choose one of the teams below.',
        teams: [...teams.values()],
        hint: 'Creating a workspace needs team admin (level "admin") in that team.',
      }),
    }],
  };
}

/**
 * Where an account-level connection's `manage_workspaces create` acts. A
 * create has no existing workspace, so it resolves a TEAM among the teams the
 * grant reaches now, then binds the session to one granted workspace in that
 * team: the REST route (api/workspaces POST) creates in the bound workspace's
 * team only, at the user's role there.
 *
 *  - params.teamId (a team id or a team name) or params.team: that team, among
 *    reachable teams only; any other is refused and never echoed;
 *  - else params.workspaceId: that granted workspace's team;
 *  - else the connection's own default workspace (`?workspace=`), if any;
 *  - else the only reachable team; with several, a refusal listing them.
 *
 * Sets params.teamId to the resolved team id, so the route sees an explicit
 * team. Null when the call is not a manage_workspaces create.
 */
export function grantCreateTarget(
  args: Record<string, unknown> | undefined,
  choices: GrantWorkspaceChoice[],
  connectionDefault: GrantWorkspaceChoice | null = null,
): GrantCreateTarget | null {
  if (!args || args.action !== 'manage_workspaces') return null;
  const p = args.params && typeof args.params === 'object' && !Array.isArray(args.params) ? args.params as Record<string, unknown> : null;
  if (!p || p.action !== 'create') return null;

  const rawTeam = [p.teamId, p.team].find((v) => typeof v === 'string' && v.trim()) as string | undefined;
  let teamId: string | null = null;
  if (rawTeam) {
    const want = rawTeam.trim().toLowerCase();
    const byId = choices.find((c) => c.teamId.toLowerCase() === want);
    const byName = [...new Set(choices.filter((c) => c.teamName.toLowerCase() === want).map((c) => c.teamId))];
    if (byId) teamId = byId.teamId;
    else if (byName.length === 1) teamId = byName[0];
    else return { kind: 'refused', result: teamRefusal('team_not_granted', choices) };
  } else if (typeof p.workspaceId === 'string' && p.workspaceId.trim()) {
    const r = resolveGrantWorkspaceRef(choices, p.workspaceId);
    if (r.kind !== 'ok') return { kind: 'refused', result: grantWorkspaceRefusal(r) };
    teamId = r.workspace.teamId;
  } else if (connectionDefault) {
    teamId = connectionDefault.teamId;
  } else {
    const teamIds = [...new Set(choices.map((c) => c.teamId))];
    if (teamIds.length !== 1) return { kind: 'refused', result: teamRefusal('team_required', choices) };
    teamId = teamIds[0];
  }

  const inTeam = choices.filter((c) => c.teamId === teamId);
  const workspace = inTeam.find((c) => c.level === 'admin' && c.access === 'read-write') ?? inTeam[0];
  p.teamId = teamId;
  delete p.team;
  return { kind: 'ok', workspace };
}

export type JsonRpcMessage ={ method?: unknown; params?: { name?: unknown; arguments?: Record<string, unknown> } };

/**
 * The workspace reference a tool call names, if any: params.workspaceId on the
 * buildd / buildd_<group> tools (or a flat workspaceId), workspaceId on
 * recall / learn.
 */
export function callWorkspaceRef(args: Record<string, unknown> | undefined): { ref: string | null; holder: Record<string, unknown> | null } {
  if (!args) return { ref: null, holder: null };
  const p = args.params && typeof args.params === 'object' && !Array.isArray(args.params) ? args.params as Record<string, unknown> : null;
  if (p && typeof p.workspaceId === 'string' && p.workspaceId.trim()) return { ref: p.workspaceId, holder: p };
  if (typeof args.workspaceId === 'string' && args.workspaceId.trim()) return { ref: args.workspaceId, holder: args };
  return { ref: null, holder: null };
}

/**
 * The workspace a call's subject lives in, when the call names no workspace:
 * params.taskId, missionId or workerId (or flat), a UUID. A full id already
 * says which workspace it is in, so asking for workspaceId as well only makes
 * a task unreachable from an account-level connection. The answer counts only
 * if it is one of `choices`; anything else resolves to null, so the caller
 * gets the usual workspace_required refusal and learns nothing about an id
 * outside the grant.
 */
export async function callSubjectWorkspace(
  args: Record<string, unknown> | undefined,
  choices: GrantWorkspaceChoice[],
): Promise<GrantWorkspaceChoice | null> {
  if (!args) return null;
  const p = args.params && typeof args.params === 'object' && !Array.isArray(args.params) ? args.params as Record<string, unknown> : {};
  const pick = (k: string): string | null => {
    const v = p[k] ?? args[k];
    return typeof v === 'string' && isUuid(v.trim()) ? v.trim() : null;
  };
  const lookups: Array<[string | null, (id: string) => Promise<{ workspaceId: string | null } | undefined>]> = [
    [pick('taskId'), (id) => db.query.tasks.findFirst({ where: sqlWhere(eq(tasks.id, id)), columns: { workspaceId: true } })],
    [pick('missionId'), (id) => db.query.missions.findFirst({ where: sqlWhere(eq(missions.id, id)), columns: { workspaceId: true } })],
    [pick('workerId'), (id) => db.query.workers.findFirst({ where: sqlWhere(eq(workers.id, id)), columns: { workspaceId: true } })],
  ];
  for (const [id, find] of lookups) {
    if (!id) continue;
    const row = await find(id);
    if (!row?.workspaceId) continue;
    return choices.find((c) => c.workspaceId === row.workspaceId) ?? null;
  }
  return null;
}

/**
 * This per-workspace endpoint is deprecated in favour of the canonical
 * account-level `<issuer>/api/mcp` (one connection, the workspaces you grant
 * it, across teams). Existing connections keep working; responses say so in
 * the instructions and in Deprecation / Link headers (RFC 9745, RFC 8288).
 */
export const LEGACY_ENDPOINT_NOTICE = 'Deprecated endpoint: this connection is bound to one workspace. Reconnect to the canonical /api/mcp endpoint instead: one connection reaches the workspaces you choose at sign-in, across teams, and its list_workspaces action shows them. This endpoint keeps working until you switch.';

export function deprecationHeaders(): Record<string, string> {
  return {
    Deprecation: 'true',
    Link: `<${getIssuer()}/api/mcp>; rel="successor-version"`,
  };
}

