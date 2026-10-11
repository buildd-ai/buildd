/**
 * POST /api/admin/model-certifications — platform operator verdict on a model.
 *
 *   Authorization: Bearer <platform admin API key>
 *   Body: { model, state?: 'certified' | 'incompatible', minCliVersion?: string | null,
 *           deprecated?: boolean, retiresAt?: ISO | null, note? }
 *
 * The escape hatch around the probe (packages/core/model-certification.ts):
 * certify a model a broken probe cannot, hold one back, correct a floor, or
 * deprecate a model before the provider's catalog says so. Buildd-wide, so
 * never reachable with a team-scoped credential.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authorizePlatformAdmin } from '@/lib/platform-admin';
import { CLI_VERSION_RE } from '@/lib/model-probe-access';
import { getCachedOpenRouterCatalog } from '@buildd/core/model-catalog-cache';
import { getModelCertifications, markModelCertification } from '@buildd/core/model-certification-store';
import { describeCertification } from '@buildd/core/model-certification-candidates';

const MODEL_RE = /^claude-[a-z0-9-]{1,80}$/;

export async function POST(req: NextRequest) {
  const auth = await authorizePlatformAdmin(req);
  if (auth.response) return auth.response;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const { model, state, minCliVersion, deprecated, retiresAt, note } = body ?? {};
  if (typeof model !== 'string' || !MODEL_RE.test(model)) return NextResponse.json({ error: 'model is required' }, { status: 400 });
  if (state != null && state !== 'certified' && state !== 'incompatible') {
    return NextResponse.json({ error: 'state must be certified or incompatible' }, { status: 400 });
  }
  if (minCliVersion != null && (typeof minCliVersion !== 'string' || !CLI_VERSION_RE.test(minCliVersion))) {
    return NextResponse.json({ error: 'minCliVersion must look like 2.1.290' }, { status: 400 });
  }
  if (deprecated != null && typeof deprecated !== 'boolean') return NextResponse.json({ error: 'deprecated must be a boolean' }, { status: 400 });
  if (retiresAt != null && (typeof retiresAt !== 'string' || !Number.isFinite(Date.parse(retiresAt)))) {
    return NextResponse.json({ error: 'retiresAt must be an ISO date' }, { status: 400 });
  }
  if (state == null && minCliVersion === undefined && deprecated == null) {
    return NextResponse.json({ error: 'Nothing to change: pass state, minCliVersion or deprecated' }, { status: 400 });
  }

  const [catalog, certs] = await Promise.all([getCachedOpenRouterCatalog(), getModelCertifications()]);
  const baseline = describeCertification(model, catalog, certs, Date.now()).state === 'baseline';
  const next = await markModelCertification(
    model,
    {
      by: auth.account.id,
      state: (state as 'certified' | 'incompatible' | undefined) ?? null,
      ...(minCliVersion !== undefined ? { minCliVersion: minCliVersion as string | null } : {}),
      ...(typeof deprecated === 'boolean' ? { deprecated } : {}),
      retiresAt: (retiresAt as string | undefined) ?? null,
      note: typeof note === 'string' ? note.slice(0, 500) : null,
    },
    { baseline },
  );
  if (!next) return NextResponse.json({ error: 'Concurrent update; retry' }, { status: 409 });
  console.log(`[model-certification] ${model} marked by platform admin: state=${next.state} deprecated=${!!next.deprecated}`);
  return NextResponse.json({ ok: true, certification: describeCertification(model, catalog, new Map([[model, next]]), Date.now()) });
}
