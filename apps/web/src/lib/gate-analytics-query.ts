/**
 * The only thing that reads `gate_events` from Postgres.
 *
 * Aggregation itself is pure and lives in `@buildd/core/gate-analytics`, which
 * is what the unit tests exercise. This file exists so the route, the MCP tool
 * and the health page all read the SAME row set through the same query — the
 * mistake `failure-analytics.ts` had to be refactored to undo when its family
 * rollup grew a second, subtly different fetch.
 *
 * Read-only. Never throws: a broken ledger read must degrade to "no gate data",
 * never to a 500 on the health page.
 */
import { db } from '@buildd/core/db';
import { gateEvents } from '@buildd/core/db/schema';
import { and, desc, gte, inArray } from 'drizzle-orm';
import {
  buildGateReasonFamily,
  computeGateAnalytics,
  gateWindowStartFor,
  type GateEventRow,
} from '@buildd/core/gate-analytics';
import type { GateAnalytics, GateReasonFamily, GateWindow } from '@buildd/shared';

/** Same guard as the failure fetch — a 30d window on a busy team stays bounded. */
const MAX_GATE_ROWS = 5000;

export async function fetchGateEventRows(
  scopedWsIds: string[],
  window: GateWindow,
  now: Date,
): Promise<GateEventRow[]> {
  const windowStart = gateWindowStartFor(window, now);

  const rows = await db
    .select({
      id: gateEvents.id,
      gate: gateEvents.gate,
      surface: gateEvents.surface,
      outcome: gateEvents.outcome,
      reason: gateEvents.reason,
      workspaceId: gateEvents.workspaceId,
      missionId: gateEvents.missionId,
      taskId: gateEvents.taskId,
      callerOrigin: gateEvents.callerOrigin,
      occurredAt: gateEvents.occurredAt,
    })
    .from(gateEvents)
    .where(and(
      inArray(gateEvents.workspaceId, scopedWsIds),
      gte(gateEvents.occurredAt, windowStart),
    ))
    // Newest first, so a truncated window keeps the most recent slice.
    .orderBy(desc(gateEvents.occurredAt))
    .limit(MAX_GATE_ROWS);

  return (rows as Array<Record<string, unknown>>).map((r): GateEventRow => ({
    id: r.id as string,
    gate: r.gate as string,
    surface: r.surface as string,
    outcome: r.outcome as string,
    reason: r.reason as string,
    workspaceId: (r.workspaceId as string | null) ?? null,
    missionId: (r.missionId as string | null) ?? null,
    taskId: (r.taskId as string | null) ?? null,
    callerOrigin: (r.callerOrigin as string | null) ?? null,
    occurredAt: r.occurredAt instanceof Date ? r.occurredAt : new Date(r.occurredAt as string),
  }));
}

/** Ranked gate report for the given workspaces. Never throws. */
export async function getGateAnalytics(
  scopedWsIds: string[],
  window: GateWindow = '7d',
  now: Date = new Date(),
): Promise<GateAnalytics> {
  const empty = () => computeGateAnalytics({ window, now, events: [] });
  if (scopedWsIds.length === 0) return empty();
  try {
    const events = await fetchGateEventRows(scopedWsIds, window, now);
    return computeGateAnalytics({ window, now, events });
  } catch (err) {
    console.error('[gate-analytics] query failed:', err);
    return empty();
  }
}

/** Prefix rollup across gate reasons. Never throws. */
export async function getGateReasonFamily(
  scopedWsIds: string[],
  window: GateWindow,
  prefix: string,
  now: Date = new Date(),
): Promise<GateReasonFamily> {
  if (scopedWsIds.length === 0) return buildGateReasonFamily([], prefix);
  try {
    const events = await fetchGateEventRows(scopedWsIds, window, now);
    return buildGateReasonFamily(events, prefix);
  } catch (err) {
    console.error('[gate-analytics] family query failed:', err);
    return buildGateReasonFamily([], prefix);
  }
}
