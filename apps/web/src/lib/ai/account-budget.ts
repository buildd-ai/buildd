/**
 * `PATCH /api/accounts/[id]/ai-budget` — set an app account's daily AI cap
 * (`accounts.aiDailyBudgetUsd`), which `POST /api/ai/plan` reads for its
 * may-spend decision. NULL clears it (no buildd-side cap; the app's own
 * provider-key limit is the only ceiling).
 *
 * Who may: whoever holds `manage_ai_budget` in the ACCOUNT'S team — by default
 * an owner or admin session (the team's permission overrides apply), or an
 * admin-level key of that team. Team permission,
 * never "the caller's account id equals this id": an app's own key cannot
 * raise its own cap unless it is an admin key. An account in a team the caller
 * does not belong to is a 404, the same as a missing one.
 */

import { NextResponse } from 'next/server';
import { isUuid } from '@/lib/uuid';
import type { TeamScopeCaller } from '@/lib/team-access';

/** Upper bound on a daily cap, to catch cents-vs-dollars mistakes. */
export const MAX_AI_DAILY_BUDGET_USD = 100_000;

export interface AccountBudgetDeps {
  /** Session user or bearer account; null when neither authenticates. */
  caller(req: Request): Promise<TeamScopeCaller | null>;
  /** Teams the caller belongs to at all (for the 404-vs-403 split). */
  callerTeamIds(caller: TeamScopeCaller): Promise<string[]>;
  canAdminTeam(caller: TeamScopeCaller, teamId: string): Promise<boolean>;
  loadAccount(id: string): Promise<{ id: string; teamId: string } | null>;
  setBudget(id: string, usd: number | null): Promise<void>;
}

const json = (body: unknown, status = 200) => NextResponse.json(body, { status });

export async function handleAccountAiBudgetPatch(req: Request, id: string, deps: AccountBudgetDeps): Promise<Response> {
  const caller = await deps.caller(req);
  if (!caller) return json({ error: 'Unauthorized' }, 401);
  if (!isUuid(id)) return json({ error: 'Account not found' }, 404);

  let body: unknown;
  try { body = await req.json(); } catch { return json({ error: 'body must be JSON' }, 400); }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return json({ error: 'body must be a JSON object' }, 400);
  const extra = Object.keys(body).filter((k) => k !== 'aiDailyBudgetUsd');
  if (extra.length || !('aiDailyBudgetUsd' in body)) {
    return json({ error: 'body must be { aiDailyBudgetUsd: number | null }' }, 400);
  }
  const usd = (body as { aiDailyBudgetUsd: unknown }).aiDailyBudgetUsd;
  if (usd !== null && (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0 || usd > MAX_AI_DAILY_BUDGET_USD)) {
    return json({ error: `aiDailyBudgetUsd must be null or a number from 0 to ${MAX_AI_DAILY_BUDGET_USD}` }, 400);
  }

  try {
    const account = await deps.loadAccount(id);
    if (!account) return json({ error: 'Account not found' }, 404);
    const teamIds = await deps.callerTeamIds(caller);
    if (!teamIds.includes(account.teamId)) return json({ error: 'Account not found' }, 404);
    if (!(await deps.canAdminTeam(caller, account.teamId))) {
      return json({ error: 'Only a team owner or admin can change an account\'s AI budget' }, 403);
    }
    const value = usd === null ? null : Math.round(usd * 100) / 100;
    await deps.setBudget(account.id, value);
    return json({ ok: true, id: account.id, aiDailyBudgetUsd: value });
  } catch (err) {
    console.error('PATCH /api/accounts/[id]/ai-budget error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
}
