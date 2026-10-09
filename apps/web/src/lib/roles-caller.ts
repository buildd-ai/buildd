import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';

/**
 * Who is writing a role through /api/roles: a person, from a dashboard
 * session or an OAuth MCP session (a bearer whose account carries
 * sessionUserId). The routes authorize the person exactly as they do a
 * dashboard session — `can(user, ...)` on their own team role — so a bearer
 * adds no reach of its own.
 *
 * `bearerTeamId` is set for an OAuth session: its token is pinned to one
 * workspace's team, and a role it writes lands in that team, never in
 * another team the same person belongs to.
 *
 * A bld_ API key or a per-task token has no person behind it, so it cannot
 * own a personal role or act as one; it is refused with a reason rather than
 * a bare 401.
 */
export interface RolesCaller {
  userId: string;
  bearerTeamId: string | null;
}

export const NO_PERSON_KEY =
  'An API key has no person behind it, so it cannot create or edit a personal role. Use the dashboard, buildd chat, or an MCP session signed in as yourself (OAuth).';
export const NO_PERSON_TASK_TOKEN =
  'A per-task token has no person behind it, so it cannot create or edit a personal role for anyone. Ask the person to create it from the dashboard, buildd chat, or their own MCP session.';

export type RolesCallerResult =
  | { ok: true; caller: RolesCaller }
  | { ok: false; response: NextResponse };

function bearerOf(req: Request): string | null {
  const h = req.headers.get('authorization');
  if (!h || !/^Bearer\s+/i.test(h)) return null;
  const token = h.replace(/^Bearer\s+/i, '').trim();
  return token || null;
}

export async function resolveRolesCaller(req: Request): Promise<RolesCallerResult> {
  const user = await getCurrentUser();
  if (user) return { ok: true, caller: { userId: user.id, bearerTeamId: null } };

  const token = bearerOf(req);
  if (!token) return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };

  // Loaded only for a bearer: the session path (and its tests) never pull in
  // the key and task-token stack.
  const { authenticateTaskScopedCaller } = await import('@/lib/task-token-auth');
  const account = await authenticateTaskScopedCaller(token, req);
  if (!account) return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (account.taskScope) {
    return { ok: false, response: NextResponse.json({ error: NO_PERSON_TASK_TOKEN }, { status: 403 }) };
  }
  const sessionUserId = (account as { sessionUserId?: string | null }).sessionUserId ?? null;
  if (!sessionUserId) {
    return { ok: false, response: NextResponse.json({ error: NO_PERSON_KEY }, { status: 403 }) };
  }
  return { ok: true, caller: { userId: sessionUserId, bearerTeamId: account.teamId ?? null } };
}
