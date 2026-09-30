import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { getUserTeamIds } from '@/lib/team-access';
import { decodeCloudflareValue, findCloudflareSecret, maskCloudflareCredential } from '@/lib/cloudflare-credential';

/**
 * GET /api/cloudflare/credential?teamId=
 *
 * The team's Cloudflare token as masked metadata (account ID first/last 4,
 * token last 4, gateway ID, health). Never the token. Any team member, or any
 * API key of the team. Store with POST /api/secrets (purpose cloudflare_token),
 * verify with POST /api/secrets/[id]/verify, delete with DELETE /api/secrets.
 */
export async function GET(req: NextRequest) {
  const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  const account = apiKey ? await authenticateApiKey(apiKey) : null;

  let teamIds: string[];
  if (account) {
    teamIds = [account.teamId];
  } else {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    teamIds = await getUserTeamIds(user.id);
  }
  if (teamIds.length === 0) return NextResponse.json({ credential: null });

  const teamId = req.nextUrl.searchParams.get('teamId') || teamIds[0];
  if (!teamIds.includes(teamId)) return NextResponse.json({ error: 'Team not found' }, { status: 404 });

  const row = await findCloudflareSecret(teamId);
  if (!row) return NextResponse.json({ credential: null });

  const cred = decodeCloudflareValue(row.encryptedValue);
  return NextResponse.json({
    credential: {
      id: row.id,
      teamId: row.teamId,
      ...(cred ? maskCloudflareCredential(cred) : { accountId: null, aiGatewayId: null, tokenHint: null }),
      readable: cred !== null,
      healthStatus: row.healthStatus,
      lastVerifiedAt: row.lastVerifiedAt,
      lastVerificationError: row.lastVerificationError,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
  });
}
