/**
 * Who may read a decision for grading and write its agent-audit grade
 * (GET /api/decisions/[id], POST /api/decisions/[id]/label; MCP get_decision
 * and label_decision):
 *
 *  - the platform owner, any team: an admin-level `bld_` key listed in
 *    BUILDD_PLATFORM_ADMIN_ACCOUNT_IDS, or a signed-in platform operator;
 *  - a team admin, for their own team only: whoever holds `run_experiments`
 *    there (owner or admin by default; an admin-level key). Grading decision
 *    quality is the same trust as running an experiment on it.
 *
 * Another team's decision reads as not found, never as forbidden, so a
 * decision id from elsewhere confirms nothing. A worker-level key or a plain
 * member of the decision's own team is forbidden. A per-task token is refused
 * by `hasTokenRouteAdminAccess` at either level.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey } from '@/lib/api-auth';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamRole } from '@/lib/team-access';
import { can } from '@/lib/permissions';
import { isPlatformAdminAccount } from '@/lib/platform-admin';
import { isPlatformOperator } from '@/lib/platform-operator';
import { hasTokenRouteAdminAccess } from '@/lib/token-route-policy';

export const decisionNotFound = () => NextResponse.json({ error: 'Decision not found' }, { status: 404 });

export type DecisionAuditCaller = { kind: 'user'; id: string } | { kind: 'account'; id: string };

/** Authenticate first (401), so the record read below never runs for an anonymous caller. */
export async function authenticateDecisionAuditCaller(req: NextRequest) {
  const user = await getCurrentUser();
  const key = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || null;
  const account = key ? await authenticateApiKey(key, req) : null;
  if (!user && !account) return { response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) } as const;
  return { user, account } as const;
}

type Caller = Exclude<Awaited<ReturnType<typeof authenticateDecisionAuditCaller>>, { response: NextResponse }>;

/** Null when allowed; otherwise the refusal to return. */
export async function refuseDecisionAudit(req: NextRequest, caller: Caller, teamId: string): Promise<NextResponse | null> {
  const { user, account } = caller;
  if (account) {
    const admin = hasTokenRouteAdminAccess(account, req);
    if (admin && isPlatformAdminAccount(account.id)) return null;
    if (account.teamId !== teamId) return decisionNotFound();
    const allowed = admin && await can({ kind: 'account', accountId: account.id, teamId: account.teamId, level: account.level }, 'run_experiments', teamId);
    return allowed ? null : NextResponse.json({ error: 'Grading a decision needs an admin token for its team' }, { status: 403 });
  }
  if (user && isPlatformOperator(user)) return null;
  if (!user || !(await getUserTeamRole(user.id, teamId))) return decisionNotFound();
  return (await can({ kind: 'user', userId: user.id }, 'run_experiments', teamId))
    ? null
    : NextResponse.json({ error: 'Grading a decision needs a team owner or admin' }, { status: 403 });
}

export function auditCallerOf(caller: Caller): DecisionAuditCaller {
  return caller.account ? { kind: 'account', id: caller.account.id } : { kind: 'user', id: caller.user!.id };
}
