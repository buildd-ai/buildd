/**
 * Reads the claim loop's durable refusal ledger for one mission.
 *
 * `gate_events` already records every claim-loop deferral, coalesced per
 * (taskId, reason) into a `detail.consecutiveDeferrals` counter with a
 * `detail.firstDeferredAt` floor (see `recordOrCoalesceDeferral`). Nothing on
 * the mission screen read it, so an agent the loop had turned away a dozen
 * times in a row rendered as a spinner and a "1 agent active" line.
 *
 * This module only LOADS. Whether a streak is long enough to say out loud is
 * `claim-deferral-thresholds.ts`, and how it is phrased is the state accessor —
 * the same one-owner rule the rest of this surface follows.
 */
import { db } from '@buildd/core/db';
import { gateEvents } from '@buildd/core/db/schema';
import { and, desc, eq, gt } from 'drizzle-orm';
import { GATE_SLUGS } from './gate-ledger';
import type { MissionStateInput } from './mission-state-view';

/**
 * How recently the loop must have refused a task for the refusal to still be an
 * observation rather than a memory.
 *
 * The counter lives on the task's newest gate row and is never reset when the
 * task finally dispatches — nothing writes a "cleared" row — so age is the only
 * signal that a streak has ended. Fifteen minutes is ~30 runner polls: long
 * enough that a momentarily idle fleet does not blank the warning, short enough
 * that a task which dispatched stops being reported as stuck almost
 * immediately. A fleet that stops polling altogether also ages out, which is
 * correct: "the claim loop is refusing this" is not something you can observe
 * when nothing is asking.
 */
export const DEFERRAL_FRESHNESS_MS = 15 * 60 * 1000;

/** Cap on rows read. A mission with more stuck tasks than this has one problem, not fifty. */
const DEFERRAL_ROW_LIMIT = 50;

export type MissionDeferral = NonNullable<MissionStateInput['deferrals']>[number];

/**
 * The live claim-loop deferrals for a mission, one entry per task (the longest
 * streak wins when a task has been refused for more than one reason).
 *
 * Returns every fresh row; the accessor applies the surfacing threshold. A
 * caller that cannot afford the query passes nothing and gets an honestly
 * degraded view — never a confident "everything is fine".
 */
export async function loadMissionClaimDeferrals(missionId: string): Promise<MissionDeferral[]> {
  const since = new Date(Date.now() - DEFERRAL_FRESHNESS_MS);
  const rows = await db.query.gateEvents.findMany({
    where: and(
      eq(gateEvents.missionId, missionId),
      eq(gateEvents.gate, GATE_SLUGS.CLAIM_LOOP_DEFERRAL),
      eq(gateEvents.outcome, 'deferred'),
      gt(gateEvents.occurredAt, since),
    ),
    orderBy: [desc(gateEvents.occurredAt)],
    limit: DEFERRAL_ROW_LIMIT,
    columns: { taskId: true, reason: true, detail: true },
  });
  return summarizeDeferralRows(rows);
}

/**
 * Collapse raw gate rows to one entry per task. Pure, so the collapsing rule is
 * testable without a database.
 */
export function summarizeDeferralRows(
  rows: Array<{ taskId: string | null; reason: string; detail: unknown }>,
): MissionDeferral[] {
  const byTask = new Map<string, MissionDeferral>();
  for (const row of rows) {
    if (!row.taskId) continue;
    const detail = (row.detail ?? null) as Record<string, unknown> | null;
    const consecutiveDeferrals = typeof detail?.consecutiveDeferrals === 'number' ? detail.consecutiveDeferrals : 1;
    const firstDeferredAt = typeof detail?.firstDeferredAt === 'string' ? detail.firstDeferredAt : null;
    // path_overlap layer 1 records the open PR it deferred behind.
    const blockedByPr = typeof detail?.prNumber === 'number' ? detail.prNumber : null;
    const prior = byTask.get(row.taskId);
    if (prior && prior.consecutiveDeferrals >= consecutiveDeferrals) continue;
    byTask.set(row.taskId, {
      taskId: row.taskId,
      reason: row.reason,
      consecutiveDeferrals,
      firstDeferredAt,
      blockedByPr,
    });
  }
  return [...byTask.values()].sort((a, b) => b.consecutiveDeferrals - a.consecutiveDeferrals);
}
