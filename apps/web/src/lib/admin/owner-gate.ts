import { NextRequest, NextResponse } from 'next/server';
import { authorizePlatformAdmin } from '@/lib/platform-admin';

/**
 * Gate for the platform-owner data routes under `/api/admin/*` (the private
 * admin app's API). The principal is the same as `authorizePlatformAdmin`: an
 * admin-level `bld_` key whose account is in BUILDD_PLATFORM_ADMIN_ACCOUNT_IDS.
 *
 * The difference is the refusal: every other caller — no credential, a team
 * key, an unconfigured allowlist — gets the same 404 an unknown path would, so
 * these routes do not advertise that they exist.
 */
export const notFound = () => NextResponse.json({ error: 'Not found' }, { status: 404 });

type Authorized = { account: NonNullable<Awaited<ReturnType<typeof authorizePlatformAdmin>>['account']>; response?: undefined };
type Refused = { account?: undefined; response: NextResponse };

export async function requirePlatformOwner(req: NextRequest): Promise<Authorized | Refused> {
  const result = await authorizePlatformAdmin(req);
  if (result.account) return { account: result.account };
  return { response: notFound() };
}
