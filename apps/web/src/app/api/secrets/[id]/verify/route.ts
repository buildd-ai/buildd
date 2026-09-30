import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { secrets } from '@buildd/core/db/schema';
import { eq, or } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds } from '@/lib/team-access';
import { verifyClaudeCredential } from '@/lib/claude-credential';
import { getCodexSecretId, verifyCodexCredential } from '@/lib/codex-credential';
import { isUuid } from '@/lib/uuid';
import { verifyCloudflareCredential } from '@/lib/cloudflare-credential';

type RouteContext = { params: Promise<{ id: string }> };

// POST /api/secrets/[id]/verify
// Smoke-tests a stored credential against its provider API.
// Supports: oauth_token, anthropic_api_key (Claude), codex_credential (Codex)
// and cloudflare_token (the cloud runner's Cloudflare API token).
export async function POST(req: NextRequest, { params }: RouteContext) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: `Invalid secret id: expected a UUID, got "${id}".` }, { status: 404 });
  }

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const teamIds = await getUserTeamIds(user.id);
  if (!teamIds.length) return NextResponse.json({ error: 'No team found' }, { status: 403 });

  const row = await db.query.secrets.findFirst({
    where: eq(secrets.id, id),
    columns: { id: true, teamId: true, purpose: true },
  });

  if (!row) return NextResponse.json({ error: 'Credential not found' }, { status: 404 });
  if (!teamIds.includes(row.teamId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  if (row.purpose === 'oauth_token' || row.purpose === 'anthropic_api_key') {
    const result = await verifyClaudeCredential(id);
    return NextResponse.json(result);
  }

  if (row.purpose === 'codex_credential') {
    const result = await verifyCodexCredential(id);
    return NextResponse.json(result);
  }

  if (row.purpose === 'cloudflare_token') {
    // Result carries status and error only, never the token.
    const result = await verifyCloudflareCredential(id);
    return NextResponse.json(result);
  }

  return NextResponse.json({ error: 'Verification not supported for this credential type' }, { status: 400 });
}
