import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { accounts } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { hashApiKey } from '@/lib/api-auth';
import { getUserTeamIds } from '@/lib/team-access';
import { getSecretsProvider } from '@buildd/core/secrets';

/**
 * Dual auth: API key (Bearer token) or session cookie.
 * Returns the list of team IDs the caller belongs to.
 */
async function authenticateAndGetTeamIds(req: NextRequest): Promise<{ teamIds: string[]; accountId?: string } | null> {
  // Try API key auth first
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;

  if (apiKey) {
    const account = await db.query.accounts.findFirst({
      where: eq(accounts.apiKey, hashApiKey(apiKey)),
    });
    if (account) {
      return { teamIds: [account.teamId], accountId: account.id };
    }
  }

  // Fall back to session auth
  if (process.env.NODE_ENV === 'development') {
    return { teamIds: [] };
  }

  const user = await getCurrentUser();
  if (user) {
    const teamIds = await getUserTeamIds(user.id);
    return { teamIds };
  }

  return null;
}

// POST /api/secrets — store an encrypted secret (session or API key auth, team-scoped)
export async function POST(req: NextRequest) {
  const auth = await authenticateAndGetTeamIds(req);
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (auth.teamIds.length === 0) {
    return NextResponse.json({ error: 'No team found' }, { status: 403 });
  }

  const body = await req.json();
  const { value, purpose, label, accountId, workspaceId, teamId } = body;

  if (!value || !purpose) {
    return NextResponse.json({ error: 'value and purpose are required' }, { status: 400 });
  }

  const validPurposes = ['anthropic_api_key', 'oauth_token', 'webhook_token', 'custom', 'mcp_credential'];
  if (!validPurposes.includes(purpose)) {
    return NextResponse.json({ error: `Invalid purpose. Must be one of: ${validPurposes.join(', ')}` }, { status: 400 });
  }

  // MCP credentials require a label (env var name)
  if (purpose === 'mcp_credential' && !label) {
    return NextResponse.json({ error: 'label is required for mcp_credential secrets' }, { status: 400 });
  }

  // Verify the requested team belongs to the caller
  const targetTeamId = teamId || auth.teamIds[0];
  if (!auth.teamIds.includes(targetTeamId)) {
    return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  }

  try {
    const provider = getSecretsProvider();
    const id = await provider.set(null, value, {
      teamId: targetTeamId,
      // MCP credentials are team-wide (shared with all runners), so don't scope to account
      accountId: purpose === 'mcp_credential' ? (accountId ?? null) : (accountId || auth.accountId),
      workspaceId,
      purpose,
      label,
    });

    return NextResponse.json({ id });
  } catch (error) {
    console.error('Create secret error:', error);
    return NextResponse.json({ error: 'Failed to create secret' }, { status: 500 });
  }
}

// GET /api/secrets — list secret metadata (never values)
export async function GET(req: NextRequest) {
  const auth = await authenticateAndGetTeamIds(req);
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (auth.teamIds.length === 0) {
    return NextResponse.json({ secrets: [] });
  }

  const teamId = req.nextUrl.searchParams.get('teamId') || auth.teamIds[0];
  if (!auth.teamIds.includes(teamId)) {
    return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  }

  try {
    const provider = getSecretsProvider();
    const secrets = await provider.list(teamId);
    return NextResponse.json({ secrets });
  } catch (error) {
    console.error('List secrets error:', error);
    return NextResponse.json({ error: 'Failed to list secrets' }, { status: 500 });
  }
}

// DELETE /api/secrets?id=xxx — remove a secret
export async function DELETE(req: NextRequest) {
  const auth = await authenticateAndGetTeamIds(req);
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (auth.teamIds.length === 0) {
    return NextResponse.json({ error: 'No team found' }, { status: 403 });
  }

  const id = req.nextUrl.searchParams.get('id');
  if (!id) {
    return NextResponse.json({ error: 'id is required' }, { status: 400 });
  }

  try {
    // Verify the secret belongs to one of the caller's teams by listing first
    const provider = getSecretsProvider();
    for (const teamId of auth.teamIds) {
      const teamSecrets = await provider.list(teamId);
      if (teamSecrets.some(s => s.id === id)) {
        await provider.delete(id);
        return NextResponse.json({ success: true });
      }
    }

    return NextResponse.json({ error: 'Secret not found' }, { status: 404 });
  } catch (error) {
    console.error('Delete secret error:', error);
    return NextResponse.json({ error: 'Failed to delete secret' }, { status: 500 });
  }
}
