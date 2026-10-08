/**
 * GET /api/model-tiers/certifications?model=<id>
 *
 * A model's central certification (packages/core/model-certification.ts):
 * state (baseline | discovered | probing | certified | incompatible | failed),
 * CLI floor, release and certification times, deprecation. Without `model`,
 * every model the certification probe has a record for. Buildd-wide data, but
 * read through the same gate as the rest of /api/model-tiers.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticate } from '@/lib/model-tier-access';
import { getCachedOpenRouterCatalog } from '@buildd/core/model-catalog-cache';
import { getModelCertifications } from '@buildd/core/model-certification-store';
import { describeCertification } from '@buildd/core/model-certification-candidates';

export async function GET(req: NextRequest) {
  const auth = await authenticate(req);
  if ('error' in auth) return auth.error;
  const model = new URL(req.url).searchParams.get('model')?.trim() || null;
  try {
    const [catalog, certs] = await Promise.all([getCachedOpenRouterCatalog(), getModelCertifications()]);
    const now = Date.now();
    if (model) return NextResponse.json({ certification: describeCertification(model, catalog, certs, now) });
    const models = [...certs.keys()].sort();
    return NextResponse.json({ certifications: models.map((m) => describeCertification(m, catalog, certs, now)) });
  } catch (error) {
    console.error('GET /api/model-tiers/certifications error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
