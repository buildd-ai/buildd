/**
 * Who may read a decision for grading and write its agent-audit grade
 * (GET /api/decisions/[id], POST /api/decisions/[id]/label; MCP get_decision
 * and label_decision): a buildd platform operator, any team
 * (admin/platform-operator-caller.ts) — a signed-in operator, an operator's own
 * OAuth session, or an admin-level `bld_` key listed in
 * BUILDD_PLATFORM_ADMIN_ACCOUNT_IDS. Grading decision quality is platform
 * machinery, so no team role holds it: a team owner or admin key is refused.
 *
 * Another team's decision reads as not found, never as forbidden, so a
 * decision id from elsewhere confirms nothing. A member (of any role) of the
 * decision's own team is forbidden. A per-task token is refused by
 * `hasTokenRouteAdminAccess` at either level.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey } from '@/lib/api-auth';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamRole } from '@/lib/team-access';
import { isPlatformOperator } from '@/lib/platform-operator';
import { isPlatformOperatorAccount } from '@/lib/admin/platform-operator-caller';
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
    if (hasTokenRouteAdminAccess(account, req) && await isPlatformOperatorAccount(account)) return null;
    if (account.teamId !== teamId) return decisionNotFound();
    return NextResponse.json({ error: OPERATOR_ONLY }, { status: 403 });
  }
  if (user && isPlatformOperator(user)) return null;
  if (!user || !(await getUserTeamRole(user.id, teamId))) return decisionNotFound();
  return NextResponse.json({ error: OPERATOR_ONLY }, { status: 403 });
}

const OPERATOR_ONLY = 'Grading a decision is for buildd platform operators';

export function auditCallerOf(caller: Caller): DecisionAuditCaller {
  return caller.account ? { kind: 'account', id: caller.account.id } : { kind: 'user', id: caller.user!.id };
}
