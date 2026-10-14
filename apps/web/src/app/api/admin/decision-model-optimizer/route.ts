/**
 * POST /api/admin/decision-model-optimizer: run the decision model optimizer
 * now (lib/decision-model-optimizer/optimizer.ts), outside its weekly cadence.
 *
 *   body (all optional): { teamId, callCap }
 *     teamId   one opted-in team (409 when it has not opted in); absent: every
 *              opted-in team, in turn, while the request's time allows.
 *     callCap  calls per team run, every model together (default 1500).
 *
 * Returns per team which kinds switched or were kept and why, with scores:
 * operator data, never shown to the team. Auto-revert is checked first.
 *
 * Auth: platform admin API key (lib/platform-admin.ts), as the prompt-evals
 * route. No team UI.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authorizePlatformAdmin } from '@/lib/platform-admin';
import { isUuid } from '@/lib/uuid';
import { runOptimizerSweep } from '@/lib/decision-model-optimizer/optimizer';
import { optedInTeams, optimizerDeps } from '@/lib/decision-model-optimizer/store';
import { COMPARISON_LIMITS } from '@/lib/prompt-evals/comparison-models';

export const maxDuration = 300;

const BUDGET_MS = 230_000;

export async function POST(req: NextRequest) {
  const gate = await authorizePlatformAdmin(req);
  if (gate.response) return gate.response;
  const body = ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const teamId = body.teamId;
  if (teamId !== undefined && (typeof teamId !== 'string' || !isUuid(teamId))) {
    return NextResponse.json({ error: 'teamId must be a team id' }, { status: 400 });
  }
  const callCap = body.callCap;
  if (callCap !== undefined && (typeof callCap !== 'number' || !Number.isInteger(callCap) || callCap < 1 || callCap > COMPARISON_LIMITS.callCap)) {
    return NextResponse.json({ error: `callCap must be a whole number from 1 to ${COMPARISON_LIMITS.callCap}` }, { status: 400 });
  }

  const deps = optimizerDeps();
  if (typeof teamId === 'string' && !(await deps.optedIn(teamId))) {
    return NextResponse.json({ error: 'that team has not opted in to decision model optimization, so none of its decisions are replayed' }, { status: 409 });
  }
  const teamIds = typeof teamId === 'string' ? [teamId] : await optedInTeams();
  const out = await runOptimizerSweep({ teamIds, budgetMs: BUDGET_MS, trigger: 'manual', ...(typeof callCap === 'number' ? { callCap } : {}) }, deps);
  return NextResponse.json(out);
}
