import { hasTokenRouteAdminAccess } from '@/lib/token-route-policy';
import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey } from '@/lib/api-auth';
import { decodeCloudflareValue, findCloudflareSecret } from '@/lib/cloudflare-credential';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * POST /api/cloudflare/credential/reveal
 *
 * Returns the team's decrypted Cloudflare token to `apps/cloud-runner/scripts/deploy.ts`,
 * so an operator who pasted the token into Settings does not also need it in
 * their shell. The only route that hands a stored credential back, so it is
 * narrow on purpose:
 *
 * - `bld_` API keys only. No session cookie (a browser never needs the token
 *   back, and a cookie-authenticated read would be one XSS away from leaking
 *   it) and no OAuth bearer (short-lived MCP sessions have no business with it).
 * - `admin` level only. Worker and trigger keys, which runners and CI hold,
 *   get 403.
 * - The key's own team only; there is no teamId parameter.
 * - POST and `no-store`, so the value is never cached or put in a URL.
 */
export async function POST(req: NextRequest) {
  const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  if (!apiKey || !apiKey.startsWith('bld_')) {
    return NextResponse.json({ error: 'An admin API key (bld_…) is required' }, { status: 401, headers: NO_STORE });
  }
  const account = await authenticateApiKey(apiKey, req);
  if (!account) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
  if (!hasTokenRouteAdminAccess(account, req)) {
    return NextResponse.json({ error: 'Requires an admin-level API key' }, { status: 403, headers: NO_STORE });
  }

  const row = await findCloudflareSecret(account.teamId);
  if (!row) {
    return NextResponse.json({ error: 'No Cloudflare token stored for this team (Settings → Runners)' }, { status: 404, headers: NO_STORE });
  }
  const cred = decodeCloudflareValue(row.encryptedValue);
  if (!cred) return NextResponse.json({ error: 'Stored Cloudflare token could not be read' }, { status: 500, headers: NO_STORE });

  console.log(`[cloudflare-credential] revealed to account ${account.id} (team ${account.teamId})`);
  return NextResponse.json(
    { apiToken: cred.apiToken, accountId: cred.accountId, aiGatewayId: cred.aiGatewayId ?? null, healthStatus: row.healthStatus },
    { headers: NO_STORE },
  );
}
