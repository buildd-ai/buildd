import { NextResponse } from 'next/server';
import { getDeployIdentity } from '@/lib/deploy-identity';

/**
 * GET /api/deploy-identity
 *
 * Public endpoint (no auth) — answers what code is actually RUNNING right
 * now, read from the platform's own build-time environment. No database
 * access on this path: it must keep answering while the database is
 * unreachable, since "is the right code deployed" is precisely the question
 * asked when something else is broken.
 *
 * `/api/version`'s `deployed` block now reports the same values (via the
 * shared `getDeployIdentity` helper) so the two endpoints can never disagree;
 * this route stays as the minimal, dependency-free form for callers that only
 * need deploy identity, such as release-health verification.
 */
export async function GET() {
  return NextResponse.json(getDeployIdentity());
}
