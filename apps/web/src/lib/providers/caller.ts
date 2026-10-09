import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds, resolveActiveTeamId } from '@/lib/team-access';
import { can, type Permission, type TeamScopeCaller } from '@/lib/permissions';
import type { ProviderPrincipal } from '@buildd/shared';
import type { TaskScope, TaskScopedAccount } from '@/lib/task-token-auth';

/**
 * Who is calling `/api/providers`, and in which team.
 *
 * - **person**: a dashboard session (team = `?teamId`, else the active team),
 *   or an OAuth MCP session (a bearer whose account carries `sessionUserId`;
 *   team pinned to the token's team). The only principal that can hold a
 *   personal (`mine`) credential. Team and workspace writes are authorized as
 *   the person, `can(user, …)`, exactly as the dashboard is.
 * - **key**: a `bld_` API key. Team and workspace writes when the key's
 *   level holds the permission; never `mine` (there is no person).
 * - **task_token**: a per-task token. Read-only (list, explain), confined to
 *   its own task's workspace; never a write.
 */
export interface ProvidersCaller {
  principal: ProviderPrincipal;
  /** The person (session or OAuth bearer); null for a key or task token. */
  userId: string | null;
  teamId: string;
  /** Task token: its scope (`taskScopeAllowsWorkspace`); undefined otherwise. */
  taskScope?: TaskScope;
  may: (permission: Permission) => Promise<boolean>;
}

export const NO_PERSON_KEY =
  'Personal credentials belong to a signed-in person, and an API key has no person behind it. Use the dashboard, buildd chat, or an MCP session signed in as yourself (OAuth).';
export const NO_PERSON_TASK_TOKEN =
  'Personal credentials belong to a signed-in person, and a per-task token has no person behind it, so it cannot read or set one for anyone.';
export const TASK_TOKEN_READ_ONLY =
  'A per-task token can list providers and explain what would run in its own workspace; it cannot change a credential or the policy.';

function bearerOf(req: Request): string | null {
  const h = req.headers.get('authorization');
  if (!h || !/^Bearer\s+/i.test(h)) return null;
  return h.replace(/^Bearer\s+/i, '').trim() || null;
}

/**
 * `authenticate` is the route's own `authenticateTaskScopedCaller` call, so the
 * route file is where a task token is accepted (task-token-routes.test.ts),
 * and the route confines it with `taskScopeAllowsWorkspace`.
 */
export async function resolveProvidersCaller(
  req: Request,
  requestedTeamId: string | null | undefined,
  authenticate: (token: string) => Promise<TaskScopedAccount | null>,
): Promise<{ ok: true; caller: ProvidersCaller } | { ok: false; response: Response }> {
  const token = bearerOf(req);
  if (token) {
    // Loaded only for a bearer: the session path never pulls in the key stack.
    const { hasTokenRouteAdminAccess } = await import('@/lib/token-route-policy');
    const account = await authenticate(token);
    if (!account) return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
    const teamId = account.teamId;
    if (requestedTeamId && requestedTeamId !== teamId) {
      return { ok: false, response: NextResponse.json({ error: 'Team not found' }, { status: 404 }) };
    }
    if (account.taskScope) {
      return {
        ok: true,
        caller: { principal: 'task_token', userId: null, teamId, taskScope: account.taskScope, may: async () => false },
      };
    }
    const sessionUserId = (account as { sessionUserId?: string | null }).sessionUserId ?? null;
    if (sessionUserId) {
      return {
        ok: true,
        caller: {
          principal: 'person', userId: sessionUserId, teamId,
          may: p => can({ kind: 'user', userId: sessionUserId }, p, teamId),
        },
      };
    }
    const keyCaller: TeamScopeCaller = {
      kind: 'account', accountId: account.id, teamId,
      level: hasTokenRouteAdminAccess(account, req) ? 'admin' : account.level,
    };
    return {
      ok: true,
      caller: { principal: 'key', userId: null, teamId, may: p => can(keyCaller, p, teamId) },
    };
  }

  const user = await getCurrentUser();
  if (!user) return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  const teamIds = await getUserTeamIds(user.id);
  if (teamIds.length === 0) return { ok: false, response: NextResponse.json({ error: 'No team found' }, { status: 403 }) };
  const cookie = (req as { cookies?: { get(n: string): { value: string } | undefined } }).cookies?.get('buildd-team')?.value ?? null;
  const teamId = requestedTeamId || await resolveActiveTeamId(user.id, cookie);
  if (!teamId || !teamIds.includes(teamId)) return { ok: false, response: NextResponse.json({ error: 'Team not found' }, { status: 404 }) };
  return {
    ok: true,
    caller: { principal: 'person', userId: user.id, teamId, may: p => can({ kind: 'user', userId: user.id }, p, teamId) },
  };
}
