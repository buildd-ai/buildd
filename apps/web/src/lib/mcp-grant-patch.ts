/**
 * The pure half of managing MCP connections (lib/mcp-grant-admin.ts): the
 * shapes the Settings page reads and the strict PATCH parser. No database,
 * so the route can validate before it touches anything and the client can
 * import the types.
 */
import type { McpGrantActsAs } from '@buildd/core/db/schema';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isGrantUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** Upper bound on ids in one change, so a request cannot ask for an unbounded IN list. */
export const MAX_WORKSPACES_PER_CHANGE = 500;

export type ConnectionAccess = 'read' | 'read-write';
/** What a connection reaches in one team: all current and future workspaces, or specific ones. */
export type ConnectionTeamMode = 'all' | 'specific';

/** Upper bound on team changes in one request. */
export const MAX_TEAMS_PER_CHANGE = 100;

export interface ConnectionWorkspace {
  id: string;
  name: string;
  teamId: string;
  teamName: string;
}

export interface ConnectionSummary {
  id: string;
  clientName: string;
  actsAs: McpGrantActsAs;
  access: ConnectionAccess;
  createdAt: string;
  /**
   * When the app last signed in or refreshed its token (ISO). Access tokens
   * last an hour, so an app in use refreshes at least hourly; null when it
   * has not refreshed since it was connected.
   */
  lastActiveAt: string | null;
  expiresAt: string | null;
  /** Workspaces it reaches now, sorted by team then name. */
  workspaces: ConnectionWorkspace[];
  /**
   * Per team it reaches, how: 'all' (every current and future workspace of
   * the team) or 'specific'. `workspaces` is what it reaches there now; for an
   * 'all' team that list grows and shrinks with the team.
   */
  teams: ConnectionTeam[];
  /** Workspaces granted one by one that the owner no longer reaches (left the team, moved). Count only. */
  unreachableCount: number;
  /** Teams on all workspaces that the owner has since left. Count only. */
  unreachableTeamCount: number;
  /** Bumped by every change; an edit sends the revision it was made against. */
  revision: number;
}

export interface ConnectionTeam {
  teamId: string;
  teamName: string;
  mode: ConnectionTeamMode;
  workspaces: ConnectionWorkspace[];
}

/** A per-workspace connection from before account-level grants. */
export interface LegacyConnectionSummary {
  clientName: string;
  workspaceName: string;
  lastActiveAt: string;
}

export interface UserConnections {
  connections: ConnectionSummary[];
  legacy: LegacyConnectionSummary[];
}

// ── Editing ──────────────────────────────────────────────────────────────────

/**
 * Set one team's mode. 'all' covers every current and future workspace of the
 * team. 'specific' freezes exactly `workspaceIds` (each in that team) as what
 * the connection reaches there; switching from 'all' sends the workspaces it
 * reached there, after the person reviewed them. 'none' takes the team out of
 * the connection altogether.
 */
export type TeamModeChange =
  | { teamId: string; mode: 'all' }
  | { teamId: string; mode: 'specific'; workspaceIds: string[] }
  | { teamId: string; mode: 'none' };

export interface GrantPatch {
  addWorkspaceIds: string[];
  removeWorkspaceIds: string[];
  teams: TeamModeChange[];
  access?: ConnectionAccess;
  /** Only ever a downgrade: 'person' is refused before it gets here. */
  actsAs?: 'agent';
  /** The revision the edit was made against; a newer grant refuses it (409). */
  ifRevision?: number;
}

export type ManageError = { ok: false; status: 400 | 403 | 404 | 409; code: string; error: string; connection?: ConnectionSummary };

export const PERSON_NEEDS_CONSENT: ManageError = {
  ok: false,
  status: 403,
  code: 'person_needs_consent',
  error: 'To let this app act as you, connect it again and agree to that when it asks.',
};
export const GRANT_NOT_FOUND: ManageError = { ok: false, status: 404, code: 'not_found', error: 'Connection not found.' };
export const WORKSPACE_NOT_ACCESSIBLE: ManageError = {
  ok: false,
  status: 403,
  code: 'workspace_not_accessible',
  error: 'One of the chosen workspaces is not available to you. Nothing was changed.',
};
export const TEAM_NOT_ACCESSIBLE: ManageError = {
  ok: false,
  status: 403,
  code: 'team_not_accessible',
  error: 'One of the chosen teams is not available to you. Nothing was changed.',
};
export const INHERITED_FROM_TEAM: ManageError = {
  ok: false,
  status: 409,
  code: 'inherited_from_team',
  error: 'That workspace is included because this app has every workspace in its team. Switch the team to specific workspaces to remove it.',
};
export const staleConnection = (connection?: ConnectionSummary): ManageError => ({
  ok: false,
  status: 409,
  code: 'stale_connection',
  error: 'This connection changed since you opened it. Review what it has now and make your change again.',
  ...(connection ? { connection } : {}),
});
export const invalidGrantPatch = (error: string): ManageError => ({ ok: false, status: 400, code: 'invalid_request', error });
const bad = invalidGrantPatch;

function idList(v: unknown, field: string): string[] | ManageError {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) return bad(`${field} must be a list of workspace ids.`);
  const ids = [...new Set(v.map((x) => x.trim().toLowerCase()))];
  if (ids.length > MAX_WORKSPACES_PER_CHANGE) return bad(`Change at most ${MAX_WORKSPACES_PER_CHANGE} workspaces at a time.`);
  return ids;
}

/**
 * Read a PATCH body strictly. Unknown fields are refused, never ignored, and
 * a request to make the connection act as the person is refused outright.
 * No message here repeats a value from the body.
 */
export function parseGrantPatch(body: unknown): { ok: true; patch: GrantPatch } | ManageError {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('Send a JSON object.');
  const b = body as Record<string, unknown>;
  const known = new Set(['addWorkspaceIds', 'removeWorkspaceIds', 'teams', 'access', 'actsAs', 'ifRevision']);
  if (Object.keys(b).some((k) => !known.has(k))) return bad('Unknown field. Allowed: addWorkspaceIds, removeWorkspaceIds, teams, access, actsAs, ifRevision.');

  if (b.actsAs !== undefined && b.actsAs !== 'agent') {
    return b.actsAs === 'person' ? PERSON_NEEDS_CONSENT : bad('actsAs can only be "agent".');
  }
  if (b.access !== undefined && b.access !== 'read' && b.access !== 'read-write') return bad('access must be "read" or "read-write".');

  const add = idList(b.addWorkspaceIds, 'addWorkspaceIds');
  if (!Array.isArray(add)) return add;
  const remove = idList(b.removeWorkspaceIds, 'removeWorkspaceIds');
  if (!Array.isArray(remove)) return remove;
  if (add.some((id) => remove.includes(id))) return bad('A workspace cannot be both added and removed.');

  const teams = teamChanges(b.teams);
  if (!Array.isArray(teams)) return teams;
  const frozen = teams.flatMap((t) => (t.mode === 'specific' ? t.workspaceIds : []));
  if (remove.some((id) => frozen.includes(id))) return bad('A workspace cannot be both removed and chosen.');

  if (b.ifRevision !== undefined && !(typeof b.ifRevision === 'number' && Number.isInteger(b.ifRevision) && b.ifRevision >= 0)) {
    return bad('ifRevision must be a whole number.');
  }
  if (add.length === 0 && remove.length === 0 && teams.length === 0 && b.access === undefined && b.actsAs === undefined) return bad('Nothing to change.');

  return {
    ok: true,
    patch: {
      addWorkspaceIds: add,
      removeWorkspaceIds: remove,
      teams,
      access: b.access as ConnectionAccess | undefined,
      actsAs: b.actsAs === 'agent' ? 'agent' : undefined,
      ...(typeof b.ifRevision === 'number' ? { ifRevision: b.ifRevision } : {}),
    },
  };
}

function teamChanges(v: unknown): TeamModeChange[] | ManageError {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return bad('teams must be a list.');
  if (v.length > MAX_TEAMS_PER_CHANGE) return bad(`Change at most ${MAX_TEAMS_PER_CHANGE} teams at a time.`);
  const out: TeamModeChange[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('Each team change must be an object.');
    const t = raw as Record<string, unknown>;
    if (Object.keys(t).some((k) => k !== 'teamId' && k !== 'mode' && k !== 'workspaceIds')) return bad('Unknown field in a team change. Allowed: teamId, mode, workspaceIds.');
    if (typeof t.teamId !== 'string' || !isGrantUuid(t.teamId.trim())) return bad('Each team change needs a team id.');
    const teamId = t.teamId.trim().toLowerCase();
    if (seen.has(teamId)) return bad('Name each team once.');
    seen.add(teamId);
    if (t.mode === 'all' || t.mode === 'none') {
      if (t.workspaceIds !== undefined) return bad('Only a team on specific workspaces takes a workspace list.');
      out.push({ teamId, mode: t.mode });
    } else if (t.mode === 'specific') {
      const ids = idList(t.workspaceIds, 'workspaceIds');
      if (!Array.isArray(ids)) return ids;
      if (ids.length === 0) return bad('Choose at least one workspace for a team on specific workspaces.');
      out.push({ teamId, mode: 'specific', workspaceIds: ids });
    } else {
      return bad('mode must be "all", "specific" or "none".');
    }
  }
  return out;
}

