import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { actionQueueSnoozes } from '@buildd/core/db/schema';
import { and, eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds } from '@/lib/team-access';

// Must match SwipeableRow's SwipeAction durations (snooze-24h/3d/7d).
const SNOOZE_HOURS = new Set([24, 72, 168]);

// POST /api/action-queue/snooze — snooze a Home/Activity gate card (MERGE/REVIEW)
// for the current user until `hours` from now. Keyed on the action queue's own
// subjectKey so buildActionQueue can drop it without re-deriving PR/task state.
export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const subjectKey = body?.subjectKey;
  const hours = body?.hours;

  if (!subjectKey || typeof subjectKey !== 'string') {
    return NextResponse.json({ error: 'subjectKey is required' }, { status: 400 });
  }
  if (typeof hours !== 'number' || !SNOOZE_HOURS.has(hours)) {
    return NextResponse.json(
      { error: `hours must be one of: ${[...SNOOZE_HOURS].join(', ')}` },
      { status: 400 },
    );
  }

  const teamIds = await getUserTeamIds(user.id);
  if (teamIds.length === 0) {
    return NextResponse.json({ error: 'No team found' }, { status: 403 });
  }

  const snoozedUntil = new Date(Date.now() + hours * 3_600_000);

  const [entry] = await db.insert(actionQueueSnoozes)
    .values({ userId: user.id, teamId: teamIds[0], subjectKey, snoozedUntil })
    .onConflictDoUpdate({
      target: [actionQueueSnoozes.userId, actionQueueSnoozes.subjectKey],
      set: { snoozedUntil, updatedAt: new Date() },
    })
    .returning();

  return NextResponse.json(entry, { status: 201 });
}

// DELETE /api/action-queue/snooze — cancel a snooze (used by the swipe undo toast).
export async function DELETE(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const subjectKey = body?.subjectKey;

  if (!subjectKey || typeof subjectKey !== 'string') {
    return NextResponse.json({ error: 'subjectKey is required' }, { status: 400 });
  }

  await db.delete(actionQueueSnoozes).where(
    and(eq(actionQueueSnoozes.userId, user.id), eq(actionQueueSnoozes.subjectKey, subjectKey)),
  );

  return NextResponse.json({ removed: true, subjectKey });
}
