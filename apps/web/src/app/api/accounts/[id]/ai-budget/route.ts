import type { NextRequest } from 'next/server';
import { db } from '@buildd/core/db';
import { accounts } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { canCallerAdminTeam, getUserTeamIds, type TeamScopeCaller } from '@/lib/team-access';
import { handleAccountAiBudgetPatch, type AccountBudgetDeps } from '@/lib/ai/account-budget';

const deps: AccountBudgetDeps = {
  async caller(req) {
    const h = req.headers.get('authorization');
    const bearer = h?.replace(/^Bearer\s+/i, '').trim() || null;
    const account = bearer ? await authenticateApiKey(bearer) : null;
    if (account?.teamId) return { kind: 'account', accountId: account.id, teamId: account.teamId, level: account.level };
    const user = await getCurrentUser();
    return user ? { kind: 'user', userId: user.id } : null;
  },
  async callerTeamIds(caller: TeamScopeCaller) {
    return caller.kind === 'account' ? [caller.teamId] : getUserTeamIds(caller.userId);
  },
  canAdminTeam: canCallerAdminTeam,
  async loadAccount(id) {
    const row = await db.query.accounts.findFirst({ where: eq(accounts.id, id), columns: { id: true, teamId: true } });
    return row ?? null;
  },
  async setBudget(id, usd) {
    await db.update(accounts).set({ aiDailyBudgetUsd: usd === null ? null : usd.toFixed(2) }).where(eq(accounts.id, id));
  },
};

// PATCH /api/accounts/[id]/ai-budget — body { aiDailyBudgetUsd: number | null }.
// The cap POST /api/ai/plan reads for this account (docs/design/shared-ai-kit.md §2).
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleAccountAiBudgetPatch(req, id, deps);
}
