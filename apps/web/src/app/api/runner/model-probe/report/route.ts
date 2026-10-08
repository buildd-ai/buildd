/**
 * POST /api/runner/model-probe/report — a certification probe's result.
 *
 *   Authorization: Bearer <runner API key>   (a BUILDD_MODEL_PROBE_ACCOUNT_IDS account)
 *   Body: { model, leaseId, cliVersion, ok, error? }
 *   200 { ok: true, state } | 409 { error, reason }
 *
 * Only the holder of the model's current lease (POST /api/runner/model-probe)
 * may report. See packages/core/model-certification.ts for what each outcome does.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey } from '@/lib/api-auth';
import { CLI_VERSION_RE, isModelProbeAccount } from '@/lib/model-probe-access';
import { reportModelProbe } from '@buildd/core/model-certification-store';

const MODEL_RE = /^claude-[a-z0-9-]{1,80}$/;

export async function POST(req: NextRequest) {
  const apiKey = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
  const account = await authenticateApiKey(apiKey, req);
  if (!account) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!isModelProbeAccount(account.id)) {
    return NextResponse.json({ error: 'This account does not certify models' }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const { model, leaseId, cliVersion, ok, error } = body ?? {};
  if (typeof model !== 'string' || !MODEL_RE.test(model)) return NextResponse.json({ error: 'model is required' }, { status: 400 });
  if (typeof leaseId !== 'string' || !leaseId) return NextResponse.json({ error: 'leaseId is required' }, { status: 400 });
  if (typeof cliVersion !== 'string' || !CLI_VERSION_RE.test(cliVersion)) {
    return NextResponse.json({ error: 'cliVersion is required' }, { status: 400 });
  }
  if (typeof ok !== 'boolean') return NextResponse.json({ error: 'ok must be a boolean' }, { status: 400 });

  try {
    const result = await reportModelProbe({
      model,
      leaseId,
      cliVersion,
      ok,
      error: typeof error === 'string' ? error : null,
    });
    if (!result.ok) {
      return NextResponse.json({ error: 'Probe report not accepted', reason: result.reason }, { status: 409 });
    }
    console.log(`[model-probe] ${model} on Claude Code ${cliVersion}: ${result.certification.state}`);
    return NextResponse.json({ ok: true, state: result.certification.state });
  } catch (e) {
    console.error('POST /api/runner/model-probe/report error:', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
