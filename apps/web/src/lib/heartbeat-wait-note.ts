import { db } from '@buildd/core/db';
import { missionNotes } from '@buildd/core/db/schema';
import { and, eq } from 'drizzle-orm';

// One durable note per mission, not one per heartbeat cycle — same "post once,
// update in place" pattern as mission-run.ts's INTEGRATION_BRANCH_NOTE_TITLE.
const HEARTBEAT_WAIT_NOTE_TITLE = 'Heartbeat waiting';

function noteBody(reason: string, waitUntil: Date): string {
  return `waiting: ${reason} until ${waitUntil.toISOString()}`;
}

/**
 * Post (or, if already open, update in place) the one note that tells a human
 * why this mission's heartbeat isn't planning right now. Only writes when the
 * reason text actually changed, so a mission blocked for hours on the same
 * condition gets one note, not one per cycle.
 */
export async function recordHeartbeatWaitNote(
  missionId: string,
  reason: string,
  waitUntil: Date,
): Promise<void> {
  const body = noteBody(reason, waitUntil);
  const existing = await db.query.missionNotes.findFirst({
    where: and(
      eq(missionNotes.missionId, missionId),
      eq(missionNotes.title, HEARTBEAT_WAIT_NOTE_TITLE),
      eq(missionNotes.status, 'open'),
    ),
    columns: { id: true, body: true },
  });

  if (!existing) {
    await db.insert(missionNotes).values({
      missionId,
      authorType: 'system',
      type: 'update',
      title: HEARTBEAT_WAIT_NOTE_TITLE,
      body,
      status: 'open',
    });
    return;
  }

  if (existing.body !== body) {
    await db.update(missionNotes).set({ body }).where(eq(missionNotes.id, existing.id));
  }
}

/** Close out the open wait note once the heartbeat has resumed planning. */
export async function resolveHeartbeatWaitNote(missionId: string): Promise<void> {
  await db
    .update(missionNotes)
    .set({ status: 'superseded' })
    .where(and(
      eq(missionNotes.missionId, missionId),
      eq(missionNotes.title, HEARTBEAT_WAIT_NOTE_TITLE),
      eq(missionNotes.status, 'open'),
    ));
}
