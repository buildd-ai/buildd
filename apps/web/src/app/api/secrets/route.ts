import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds } from '@/lib/team-access';
import { getSecretsProvider } from '@buildd/core/secrets';

// POST /api/secrets — store an encrypted secret (session auth, team-scoped)
export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const teamIds = await getUserTeamIds(user.id);
  if (teamIds.length === 0) {
    return NextResponse.json({ error: 'No team found' }, { status: 403 });
  }

  const body = await req.json();
  const { value, purpose, label, accountId, workspaceId, teamId } = body;

  if (!value || !purpose) {
    return NextResponse.json({ error: 'value and purpose are required' }, { status: 400 });
  }

  // Verify the requested team belongs to the user
  const targetTeamId = teamId || teamIds[0];
  if (!teamIds.includes(targetTeamId)) {
    return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  }

  try {
    const provider = getSecretsProvider();
    const id = await provider.set(null, value, {
      teamId: targetTeamId,
      accountId,
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
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const teamIds = await getUserTeamIds(user.id);
  if (teamIds.length === 0) {
    return NextResponse.json({ secrets: [] });
  }

  const teamId = req.nextUrl.searchParams.get('teamId') || teamIds[0];
  if (!teamIds.includes(teamId)) {
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
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const id = req.nextUrl.searchParams.get('id');
  if (!id) {
    return NextResponse.json({ error: 'id is required' }, { status: 400 });
  }

  const teamIds = await getUserTeamIds(user.id);
  if (teamIds.length === 0) {
    return NextResponse.json({ error: 'No team found' }, { status: 403 });
  }

  try {
    // Verify the secret belongs to one of the user's teams by listing first
    const provider = getSecretsProvider();
    // We check ownership by listing all secrets for user's teams and verifying the ID is there
    for (const teamId of teamIds) {
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
