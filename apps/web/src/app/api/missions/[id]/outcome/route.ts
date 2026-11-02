import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { missions } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { resolveAccountTeamIds } from '@/lib/team-access';
import { isUuid } from '@/lib/uuid';
import { loadOutcomePool, storePersonPrimaryOutcome } from '@/lib/mission-shipped-report';
import { sqlWhere } from '@buildd/core/db/relational-sql';

/**
 * POST /api/missions/[id]/outcome  { artifactId: string | null }
 *
 * A person's choice of a completed mission's primary outcome (Mission checks
 * 072de598 I-28 rule 1): `Make this the outcome` on a Records row, or `Clear`.
 * Stored on the existing What shipped record, where it survives later
 * completions. A person's act: a session only, never an API key or agent.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: `Invalid mission id: expected a UUID, got "${id}". Pass the full UUID.` }, { status: 404 });
  }

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Choosing a mission outcome is a person’s act: sign in to buildd.dev.' }, { status: 401 });

  const body = await req.json().catch(() => null) as { artifactId?: unknown } | null;
  const artifactId = body?.artifactId;
  if (!body || (artifactId !== null && (typeof artifactId !== 'string' || !isUuid(artifactId)))) {
    return NextResponse.json({ error: 'artifactId must be an artifact UUID, or null to clear the choice' }, { status: 400 });
  }

  const teamIds = await resolveAccountTeamIds(user, null);
  const mission = await db.query.missions.findFirst({
    where: sqlWhere(eq(missions.id, id)),
    columns: { id: true, teamId: true, status: true },
  });
  if (!mission || !teamIds.includes(mission.teamId)) return NextResponse.json({ error: 'Mission not found' }, { status: 404 });
  if (mission.status !== 'completed') {
    return NextResponse.json({ error: 'Only a completed mission has an outcome to choose.' }, { status: 409 });
  }

  if (artifactId) {
    const pool = await loadOutcomePool(id);
    if (!pool.some(a => a.id === artifactId)) {
      return NextResponse.json({ error: 'That artifact is not one of this mission’s reports, specs or designs.' }, { status: 400 });
    }
  }

  const stored = await storePersonPrimaryOutcome(id, artifactId ? { artifactId, chosenBy: `user:${user.id}` } : null);
  if (stored === 'no_record') {
    return NextResponse.json({ error: 'This mission has no completion record to store the choice on.' }, { status: 409 });
  }
  return NextResponse.json(stored);
}
