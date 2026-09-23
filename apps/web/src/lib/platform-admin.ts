import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey } from '@/lib/api-auth';

/**
 * Platform-operator gate for `/api/admin/*`.
 *
 * These routes act across every tenant (global model aliases, cross-namespace
 * backfills), so a team-scoped credential — however high its level within its
 * own team — is never enough. The caller must present an admin-level `bld_`
 * API key whose account id is listed in `BUILDD_PLATFORM_ADMIN_ACCOUNT_IDS`
 * (comma-separated). When the variable is unset or empty every admin route
 * refuses: the gate fails closed.
 */

export const PLATFORM_ADMIN_ENV = 'BUILDD_PLATFORM_ADMIN_ACCOUNT_IDS';

export function platformAdminAccountIds(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const raw = env[PLATFORM_ADMIN_ENV] ?? '';
  return new Set(raw.split(',').map(s => s.trim()).filter(Boolean));
}

export function isPlatformAdminAccount(
  accountId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!accountId) return false;
  return platformAdminAccountIds(env).has(accountId);
}

type Authorized = { account: NonNullable<Awaited<ReturnType<typeof authenticateApiKey>>>; response?: undefined };
type Refused = { account?: undefined; response: NextResponse };

export async function authorizePlatformAdmin(req: NextRequest): Promise<Authorized | Refused> {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;

  // Only long-lived platform keys qualify; OAuth bearer tokens are team-scoped.
  if (!apiKey || !apiKey.startsWith('bld_')) {
    return { response: NextResponse.json({ error: 'Requires a platform admin API key' }, { status: 401 }) };
  }

  const account = await authenticateApiKey(apiKey);
  if (!account) {
    return { response: NextResponse.json({ error: 'Requires a platform admin API key' }, { status: 401 }) };
  }

  if (platformAdminAccountIds().size === 0) {
    return {
      response: NextResponse.json(
        { error: `Platform administration is not configured (${PLATFORM_ADMIN_ENV} is unset)` },
        { status: 403 },
      ),
    };
  }

  if (!isPlatformAdminAccount(account.id) || account.level !== 'admin') {
    return { response: NextResponse.json({ error: 'Requires a platform admin API key' }, { status: 403 }) };
  }

  return { account };
}
