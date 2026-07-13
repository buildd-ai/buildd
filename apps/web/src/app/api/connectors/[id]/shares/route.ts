import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { connectors, connectorShares, teams, teamMembers } from '@buildd/core/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { getUserTeamIds } from '@/lib/team-access';

async function authenticateRequest(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;

  if (apiKey) {
    const account = await authenticateApiKey(apiKey);
    if (account) {
      if (account.level !== 'admin') return { type: 'denied' as const };
      return { type: 'api' as const, account };
    }
  }

  if (process.env.NODE_ENV !== 'development') {
    const user = await getCurrentUser();
    if (user) return { type: 'session' as const, user };
  } else {
    return { type: 'dev' as const };
  }

  return null;
}

/**
 * Same team-admin gate as connector create (spec §6): a plain `member` is
 * rejected; absence of a team_members row means a personal team => allowed.
 */
async function isTeamAdmin(userId: string, teamId: string): Promise<boolean> {
  const membership = await db.query.teamMembers.findFirst({
    where: and(eq(teamMembers.userId, userId), eq(teamMembers.teamId, teamId)),
    columns: { role: true },
  });
  return membership?.role !== 'member';
}

type OwnerAdminContext = {
  auth: Exclude<NonNullable<Awaited<ReturnType<typeof authenticateRequest>>>, { type: 'denied' } | { type: 'dev' }>;
  connector: typeof connectors.$inferSelect;
  teamIds: string[];
};

/**
 * Shares are managed only by an ADMIN of the connector's OWNER team (spec §1b
 * AC-4). A connector outside the actor's teams is invisible → 404 (not 403),
 * mirroring the [id] route's non-leaking resolution.
 */
async function requireOwnerAdmin(
  req: NextRequest,
  id: string,
): Promise<{ error: NextResponse } | { dev: true } | OwnerAdminContext> {
  const auth = await authenticateRequest(req);
  if (!auth || auth.type === 'denied') {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  if (auth.type === 'dev') return { dev: true };

  const teamIds = auth.type === 'api' ? [auth.account.teamId] : await getUserTeamIds(auth.user.id);
  const connector = await db.query.connectors.findFirst({
    where: eq(connectors.id, id),
  });
  if (!connector || !teamIds.includes(connector.teamId)) {
    return { error: NextResponse.json({ error: 'Connector not found' }, { status: 404 }) };
  }

  // §1b AC-4: grantees / plain members can never manage shares.
  if (auth.type === 'session' && !(await isTeamAdmin(auth.user.id, connector.teamId))) {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }

  return { auth, connector, teamIds };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ctx = await requireOwnerAdmin(req, id);
  if ('error' in ctx) return ctx.error;
  if ('dev' in ctx) return NextResponse.json({ shares: [], ownerTeamId: null });

  try {
    const shares = await db.query.connectorShares.findMany({
      where: eq(connectorShares.connectorId, id),
    });

    const nameMap = new Map<string, string>();
    if (shares.length > 0) {
      const teamRows = await db.query.teams.findMany({
        where: inArray(teams.id, shares.map(s => s.sharedWithTeamId)),
        columns: { id: true, name: true },
      });
      for (const t of teamRows) nameMap.set(t.id, t.name);
    }

    return NextResponse.json({
      shares: shares.map(s => ({
        sharedWithTeamId: s.sharedWithTeamId,
        teamName: nameMap.get(s.sharedWithTeamId),
        grantedByAccountId: s.grantedByAccountId,
        createdAt: s.createdAt,
      })),
      // Owner-team id (non-sensitive) — the UI excludes it from the
      // share/transfer pickers.
      ownerTeamId: ctx.connector.teamId,
    });
  } catch (error) {
    console.error('List connector shares error:', error);
    return NextResponse.json({ error: 'Failed to list shares' }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ctx = await requireOwnerAdmin(req, id);
  if ('error' in ctx) return ctx.error;
  if ('dev' in ctx) return NextResponse.json({ share: null });

  let body: { teamId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const targetTeamId = body.teamId;
  if (!targetTeamId) {
    return NextResponse.json({ error: 'teamId is required' }, { status: 400 });
  }

  // The owner team is implicit — never a self-share row (§1b invariant).
  if (targetTeamId === ctx.connector.teamId) {
    return NextResponse.json({ error: 'self_share_not_allowed' }, { status: 400 });
  }

  // Grants stay within teams the actor belongs to — the safest cross-team
  // grant path; also proves the target team exists.
  if (!ctx.teamIds.includes(targetTeamId)) {
    return NextResponse.json({ error: 'Target team not found' }, { status: 404 });
  }

  try {
    // Idempotent: re-granting an existing share returns it unchanged.
    const existing = await db.query.connectorShares.findFirst({
      where: and(
        eq(connectorShares.connectorId, id),
        eq(connectorShares.sharedWithTeamId, targetTeamId),
      ),
    });
    if (existing) {
      return NextResponse.json({ share: existing });
    }

    const [share] = await db.insert(connectorShares).values({
      connectorId: id,
      sharedWithTeamId: targetTeamId,
      // Session users have no account row in this context; the column is nullable.
      grantedByAccountId: ctx.auth.type === 'api' ? ctx.auth.account.id : null,
    }).returning();

    return NextResponse.json({ share }, { status: 201 });
  } catch (error) {
    console.error('Create connector share error:', error);
    return NextResponse.json({ error: 'Failed to create share' }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ctx = await requireOwnerAdmin(req, id);
  if ('error' in ctx) return ctx.error;
  if ('dev' in ctx) return NextResponse.json({ success: true });

  // teamId comes from ?teamId= or the JSON body.
  let targetTeamId = req.nextUrl.searchParams.get('teamId');
  if (!targetTeamId) {
    try {
      const body = await req.json() as { teamId?: string };
      targetTeamId = body.teamId ?? null;
    } catch {
      // no body — fall through to the 400 below
    }
  }
  if (!targetTeamId) {
    return NextResponse.json({ error: 'teamId is required' }, { status: 400 });
  }

  try {
    // Revocation removes claim-time mounting automatically (§1b AC-5):
    // visibility is computed per claim, so no worker-side cleanup is needed.
    const deleted = await db.delete(connectorShares)
      .where(and(
        eq(connectorShares.connectorId, id),
        eq(connectorShares.sharedWithTeamId, targetTeamId),
      ))
      .returning();

    if (deleted.length === 0) {
      return NextResponse.json({ error: 'share_not_found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Revoke connector share error:', error);
    return NextResponse.json({ error: 'Failed to revoke share' }, { status: 500 });
  }
}
