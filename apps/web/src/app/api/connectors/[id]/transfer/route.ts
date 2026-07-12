import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { connectors, connectorShares, secrets, teamMembers } from '@buildd/core/db/schema';
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

/**
 * POST /api/connectors/[id]/transfer — reassign connector ownership (spec §1b).
 *
 * The actor must be an admin of the CURRENT owner team AND of the target team.
 * Sequential atomic updates (no interactive transaction — neon-http):
 *   1. connectors.teamId → target, guarded on the current owner (optimistic lock)
 *   2. credential secrets (purpose=mcp_connector_credential, label=id / id:refresh)
 *      re-keyed to the target team — spec §1b: credentials always keyed on owner
 *   3. the target team's share row (now implicit owner) is deleted; all other
 *      shares are preserved
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = await authenticateRequest(req);
  if (!auth || auth.type === 'denied') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (auth.type === 'dev') {
    return NextResponse.json({ connector: null });
  }

  const teamIds = auth.type === 'api' ? [auth.account.teamId] : await getUserTeamIds(auth.user.id);
  const connector = await db.query.connectors.findFirst({
    where: eq(connectors.id, id),
  });
  if (!connector || !teamIds.includes(connector.teamId)) {
    return NextResponse.json({ error: 'Connector not found' }, { status: 404 });
  }

  // Admin of the CURRENT owner team (§1b).
  if (auth.type === 'session' && !(await isTeamAdmin(auth.user.id, connector.teamId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

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
  if (targetTeamId === connector.teamId) {
    return NextResponse.json({ error: 'already_owner' }, { status: 400 });
  }
  // Target must be a team the actor belongs to (also proves it exists).
  if (!teamIds.includes(targetTeamId)) {
    return NextResponse.json({ error: 'Target team not found' }, { status: 404 });
  }
  // ...and one the actor administers (§1b: "another team the actor administers").
  if (auth.type === 'session' && !(await isTeamAdmin(auth.user.id, targetTeamId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    // (teamId, name) uniqueness would be violated in the target team (§1 AC-4).
    const collision = await db.query.connectors.findFirst({
      where: and(eq(connectors.teamId, targetTeamId), eq(connectors.name, connector.name)),
    });
    if (collision) {
      return NextResponse.json({ error: 'connector_name_taken' }, { status: 409 });
    }

    // 1. Reassign ownership, guarded on the current owner so a concurrent
    //    transfer loses cleanly instead of double-applying.
    const [updated] = await db.update(connectors)
      .set({ teamId: targetTeamId, updatedAt: new Date() })
      .where(and(eq(connectors.id, id), eq(connectors.teamId, connector.teamId)))
      .returning();
    if (!updated) {
      return NextResponse.json({ error: 'transfer_conflict' }, { status: 409 });
    }

    // 2. Re-key the connector's credential secrets to the new owner team.
    //    Claim-time resolution keys on connector.teamId (§3), so the secret
    //    rows must follow the owner.
    await db.update(secrets)
      .set({ teamId: targetTeamId, updatedAt: new Date() })
      .where(and(
        eq(secrets.teamId, connector.teamId),
        eq(secrets.purpose, 'mcp_connector_credential'),
        inArray(secrets.label, [id, `${id}:refresh`]),
      ));

    // 2b. stdio connectors reference `mcp_credential` env secrets by label via
    //     envMapping. Those are keyed on the owner team at claim time (§3), so a
    //     transferred stdio connector would otherwise lose its env. COPY (not
    //     move) any missing labels to the new owner — the same label may be
    //     shared by other connectors/users in the old team, which must keep
    //     working. Encryption uses a global key, so encryptedValue is portable.
    if (updated.transport === 'stdio') {
      const labels = [
        ...new Set(Object.values((updated.envMapping as Record<string, string> | null) ?? {})),
      ].filter(Boolean);
      if (labels.length > 0) {
        const [oldRows, newRows] = await Promise.all([
          db.query.secrets.findMany({
            where: and(
              eq(secrets.teamId, connector.teamId),
              eq(secrets.purpose, 'mcp_credential'),
              inArray(secrets.label, labels),
            ),
            columns: { label: true, encryptedValue: true, tokenExpiresAt: true },
          }),
          db.query.secrets.findMany({
            where: and(
              eq(secrets.teamId, targetTeamId),
              eq(secrets.purpose, 'mcp_credential'),
              inArray(secrets.label, labels),
            ),
            columns: { label: true },
          }),
        ]);
        const alreadyOnTarget = new Set(newRows.map(r => r.label));
        const toCopy = oldRows.filter(r => r.label && !alreadyOnTarget.has(r.label));
        if (toCopy.length > 0) {
          await db.insert(secrets).values(
            toCopy.map(r => ({
              teamId: targetTeamId,
              accountId: null,
              workspaceId: null,
              purpose: 'mcp_credential' as const,
              label: r.label!,
              encryptedValue: r.encryptedValue,
              tokenExpiresAt: r.tokenExpiresAt ?? null,
            })),
          );
        }
      }
    }

    // 3. The new owner's share (if any) is now implicit — drop it. Other
    //    grantees keep their shares (§1b: existing shares are preserved).
    await db.delete(connectorShares)
      .where(and(
        eq(connectorShares.connectorId, id),
        eq(connectorShares.sharedWithTeamId, targetTeamId),
      ));

    return NextResponse.json({ connector: updated });
  } catch (error) {
    console.error('Transfer connector error:', error);
    return NextResponse.json({ error: 'Failed to transfer connector' }, { status: 500 });
  }
}
