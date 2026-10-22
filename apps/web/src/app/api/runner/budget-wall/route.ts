/**
 * POST /api/runner/budget-wall — a runner reports the result of probing its own
 * provider wall (see lib/budget-wall-probe.ts).
 *
 *   Authorization: Bearer <runner API key>
 *   Body: { backend?, outcome: 'capacity' | 'limited' | 'error', trigger?, resetsAt?, runner?, claudeLoginId? }
 *   200 { outcome, cleared, resetsAt }
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey } from '@/lib/api-auth';
import {
  applyBudgetWallProbe,
  BUDGET_PROBE_OUTCOMES,
  BUDGET_PROBE_TRIGGERS,
  type BudgetProbeOutcome,
  type BudgetProbeTrigger,
} from '@/lib/budget-wall-probe';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function POST(req: NextRequest) {
  const apiKey = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
  const account = await authenticateApiKey(apiKey, req);
  if (!account) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
  if (account.level === 'trigger') {
    return NextResponse.json({ error: 'Trigger tokens cannot report probes' }, { status: 403, headers: NO_STORE });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: NO_STORE });
  }
  if (!BUDGET_PROBE_OUTCOMES.includes(body.outcome as BudgetProbeOutcome)) {
    return NextResponse.json({ error: `outcome must be one of ${BUDGET_PROBE_OUTCOMES.join(', ')}` }, { status: 400, headers: NO_STORE });
  }
  const trigger = BUDGET_PROBE_TRIGGERS.includes(body.trigger as BudgetProbeTrigger) ? (body.trigger as BudgetProbeTrigger) : 'auto';
  const backend = body.backend === 'codex' ? 'codex' : 'claude';
  const resetsAt = typeof body.resetsAt === 'string' && !Number.isNaN(Date.parse(body.resetsAt)) ? new Date(body.resetsAt) : null;

  try {
    const result = await applyBudgetWallProbe({
      account: { id: account.id, teamId: (account as { teamId: string }).teamId },
      backend,
      outcome: body.outcome as BudgetProbeOutcome,
      trigger,
      resetsAt,
      runner: typeof body.runner === 'string' ? body.runner : null,
      claudeLoginId: typeof body.claudeLoginId === 'string' ? body.claudeLoginId : null,
    });
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    console.error('POST /api/runner/budget-wall error:', error);
    return NextResponse.json({ error: 'Failed to apply probe result' }, { status: 500, headers: NO_STORE });
  }
}
