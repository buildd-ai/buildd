import { db } from '@buildd/core/db';
import { missionNotes } from '@buildd/core/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import type { FlightStripSteeringEvent } from '@buildd/core/mission-helpers';

/**
 * One batched query across every active mission on the list (mirrors
 * `loadMissionFollowupTasks`'s batching, apps/web/src/lib/mission-followups.ts)
 * instead of one query per mission. Scoped to `authorType='user'` — a human
 * touching the mission is the flight strip's steering-rail signal
 * (docs/design/mission-flight-strip.md); agent/system/mcp notes are not.
 *
 * Deliberately human marks only: the design doc concedes the full rail (human
 * + clustered orchestrator cycles) may be too costly to read per card and
 * says cards may render rail-less. This is the cheap half of that read —
 * one indexed query, no per-mission fan-out — so cards get a real (if
 * partial) rail instead of none.
 */
export async function loadHumanSteeringMarksByMission(
  missionIds: string[],
): Promise<Map<string, FlightStripSteeringEvent[]>> {
  const result = new Map<string, FlightStripSteeringEvent[]>();
  if (missionIds.length === 0) return result;

  const rows = await db
    .select({ id: missionNotes.id, missionId: missionNotes.missionId, createdAt: missionNotes.createdAt })
    .from(missionNotes)
    .where(and(inArray(missionNotes.missionId, missionIds), eq(missionNotes.authorType, 'user')));

  for (const row of rows) {
    if (!row.missionId) continue;
    const list = result.get(row.missionId) ?? [];
    list.push({ id: row.id, kind: 'human', at: row.createdAt });
    result.set(row.missionId, list);
  }
  return result;
}
