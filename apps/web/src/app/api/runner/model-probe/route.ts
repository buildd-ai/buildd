/**
 * POST /api/runner/model-probe — lease one model to certify.
 *
 *   Authorization: Bearer <runner API key>   (a BUILDD_MODEL_PROBE_ACCOUNT_IDS account)
 *   Body: { claudeCliVersion }
 *   200 { model, leaseId } | { model: null }
 *
 * The runner launches `model` once with a one-turn prompt and reports through
 * POST /api/runner/model-probe/report. Only in-band catalog releases the static
 * floor table does not already vouch for are offered, newest first; most calls
 * answer `{ model: null }`. See packages/core/model-certification.ts.
 *
 * An account that may not probe gets `{ model: null }`, not an error: every
 * runner can ask, and a runner that is not a prober just never probes.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey } from '@/lib/api-auth';
import { CLI_VERSION_RE, isModelProbeAccount } from '@/lib/model-probe-access';
import { getCachedOpenRouterCatalog } from '@buildd/core/model-catalog-cache';
import { leaseModelProbe } from '@buildd/core/model-certification-store';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function POST(req: NextRequest) {
  const apiKey = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
  const account = await authenticateApiKey(apiKey, req);
  if (!account) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
  if (account.level === 'trigger') {
    return NextResponse.json({ error: 'Trigger tokens cannot probe models' }, { status: 403, headers: NO_STORE });
  }

  let body: { claudeCliVersion?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: NO_STORE });
  }
  const cliVersion = body?.claudeCliVersion;
  if (typeof cliVersion !== 'string' || !CLI_VERSION_RE.test(cliVersion)) {
    return NextResponse.json({ error: 'claudeCliVersion is required' }, { status: 400, headers: NO_STORE });
  }

  if (!isModelProbeAccount(account.id)) return NextResponse.json({ model: null }, { headers: NO_STORE });

  try {
    const catalog = await getCachedOpenRouterCatalog();
    if (catalog.length === 0) return NextResponse.json({ model: null }, { headers: NO_STORE });
    const lease = await leaseModelProbe(catalog, cliVersion);
    return NextResponse.json(lease ?? { model: null }, { headers: NO_STORE });
  } catch (error) {
    console.error('POST /api/runner/model-probe error:', error);
    // A broken probe path must never become a runner error loop.
    return NextResponse.json({ model: null }, { headers: NO_STORE });
  }
}
