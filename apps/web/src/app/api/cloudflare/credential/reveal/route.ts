import { hasTokenRouteAdminAccess } from '@/lib/token-route-policy';
import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey } from '@/lib/api-auth';
import { decodeCloudflareValue, findCloudflareSecret } from '@/lib/cloudflare-credential';
import { credentialRefOf, recordDeploymentAudit } from '@/lib/deployments/store';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * POST /api/cloudflare/credential/reveal
 *
 * Returns the team's decrypted Cloudflare token. This is the `secrets:reveal`
 * escape hatch, for the one step that still needs the token on a person's
 * machine: `wrangler deploy` of the cloud runner's container image
 * (apps/cloud-runner/scripts/deploy.ts). Everything else a deploy does runs
 * server-side through POST /api/deployments or, for an agent, the Operator's
 * POST /api/workers/[id]/deployments, neither of which returns the token.
 * The only route that hands a stored credential back, so it is narrow on
 * purpose:
 *
 * - `bld_` API keys only. No session cookie (a browser never needs the token
 *   back, and a cookie-authenticated read would be one XSS away from leaking
 *   it) and no OAuth bearer (short-lived MCP sessions have no business with it).
 * - `admin` level only. Worker and trigger keys, which runners and CI hold,
 *   get 403.
 * - The key's own team only; there is no teamId parameter.
 * - POST and `no-store`, so the value is never cached or put in a URL.
 * - Not gated on `accounts.hostRunner`: this serves a deploy key, not a runner,
 *   and flagging a deploy key would also grant it lease/refresh (INV-7a in
 *   docs/specs/credential-refresh-lifecycle.md). A per-task token is refused
 *   by the `bld_` check.
 * - Audited as an elevated `secrets:reveal` (deployment_audit_events) BEFORE
 *   the value is decrypted; a reveal whose audit row cannot be written is refused.
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
  try {
    await recordDeploymentAudit({
      teamId: account.teamId, workspaceId: null, taskId: null, workerId: null, accountId: account.id,
      principal: 'admin', roleSlug: null, operation: 'reveal', capabilities: ['secrets:reveal'], elevated: true,
      provider: 'cloudflare', project: null, environment: null, credentialRef: credentialRefOf(row.label, 'cloudflare'),
      outcome: 'succeeded', reason: null, result: null,
    });
  } catch (err) {
    console.error('[cloudflare-credential] reveal audit write failed; refusing:', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'The audit trail is unavailable, so the token was not revealed. Try again.' }, { status: 503, headers: NO_STORE });
  }

  const cred = decodeCloudflareValue(row.encryptedValue);
  if (!cred) return NextResponse.json({ error: 'Stored Cloudflare token could not be read' }, { status: 500, headers: NO_STORE });

  console.log(`[cloudflare-credential] revealed to account ${account.id} (team ${account.teamId})`);
  return NextResponse.json(
    { apiToken: cred.apiToken, accountId: cred.accountId, aiGatewayId: cred.aiGatewayId ?? null, healthStatus: row.healthStatus },
    { headers: NO_STORE },
  );
}
