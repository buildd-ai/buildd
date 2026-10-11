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
  /** Granted workspaces the owner can still reach, sorted by team then name. */
  workspaces: ConnectionWorkspace[];
  /** Granted workspaces the owner no longer reaches (left the team, moved). Count only. */
  unreachableCount: number;
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

export interface GrantPatch {
  addWorkspaceIds: string[];
  removeWorkspaceIds: string[];
  access?: ConnectionAccess;
  /** Only ever a downgrade: 'person' is refused before it gets here. */
  actsAs?: 'agent';
}

export type ManageError = { ok: false; status: 400 | 403 | 404; code: string; error: string };

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
  const known = new Set(['addWorkspaceIds', 'removeWorkspaceIds', 'access', 'actsAs']);
  if (Object.keys(b).some((k) => !known.has(k))) return bad('Unknown field. Allowed: addWorkspaceIds, removeWorkspaceIds, access, actsAs.');

  if (b.actsAs !== undefined && b.actsAs !== 'agent') {
    return b.actsAs === 'person' ? PERSON_NEEDS_CONSENT : bad('actsAs can only be "agent".');
  }
  if (b.access !== undefined && b.access !== 'read' && b.access !== 'read-write') return bad('access must be "read" or "read-write".');

  const add = idList(b.addWorkspaceIds, 'addWorkspaceIds');
  if (!Array.isArray(add)) return add;
  const remove = idList(b.removeWorkspaceIds, 'removeWorkspaceIds');
  if (!Array.isArray(remove)) return remove;
  if (add.some((id) => remove.includes(id))) return bad('A workspace cannot be both added and removed.');
  if (add.length === 0 && remove.length === 0 && b.access === undefined && b.actsAs === undefined) return bad('Nothing to change.');

  return {
    ok: true,
    patch: {
      addWorkspaceIds: add,
      removeWorkspaceIds: remove,
      access: b.access as ConnectionAccess | undefined,
      actsAs: b.actsAs === 'agent' ? 'agent' : undefined,
    },
  };
}

