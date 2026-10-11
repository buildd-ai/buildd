/**
 * Wake a mission's organizer on an event that, before event-driven replanning,
 * only moved the schedule (docs/design/event-driven-mission-replanning.md §2).
 *
 * The event loop (`resolveCompletedTask` → `maybeRetriggerMission`) only fires
 * when one of the mission's own tasks reaches a terminal state. A dependency
 * clearing, a resume, a budget raise, a PR merged outside buildd, or the owner
 * writing to the mission are not task completions, so without this the next
 * step waited for the hourly heartbeat — or forever, on a mission without one.
 *
 * `wakeMission` is deliberately narrow: it decides only whether the mission can
 * be woken at all, then hands off to `maybeRetriggerMission` with a fresh
 * trigger chain, which keeps every guard the event loop already has (depth,
 * open-PR gate, completion) and stamps `triggerSource: 'wake:<reason>'` on the
 * organizer task. A concurrent cron cycle or event re-plan is deduped by the
 * `tasks_active_planning_per_mission` unique index inside `runMission`.
 */
import { after } from 'next/server';
import { db } from '@buildd/core/db';
import { missions } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { isMissionBlocked } from '@/lib/mission-dependency';
import type { LoopAction } from '@/lib/mission-loop';

export type MissionWakeReason =
  | 'dependency_met'
  | 'resumed'
  | 'budget_raised'
  | 'pr_merged'
  | 'owner_note'
  | 'owner_answer'
  /** A closed PR was resolved (superseded or abandoned): the mission may now be completable. */
  | 'pr_resolved';

export type MissionWakeOutcome =
  | { woken: false; reason: 'not_found' | 'not_active' | 'manual' | 'held' | 'dependency_blocked' | 'error' }
  | { woken: true; action: LoopAction };

export interface MissionWakeDeps {
  retrigger?: (
    missionId: string,
    reason: MissionWakeReason,
  ) => Promise<{ action: LoopAction }>;
  isMissionBlocked?: typeof isMissionBlocked;
  complete?: (missionId: string, opts: { path: 'criteria_eval'; predicate: string }) => Promise<unknown>;
}

/**
 * Events that can be the last thing a mission was waiting on: a PR landing, or
 * a closed PR being settled. For a manual mission nothing else re-checks its
 * criteria once its tasks have completed, so these still attempt completion.
 */
const COMPLETION_REASONS: ReadonlySet<MissionWakeReason> = new Set(['pr_merged', 'pr_resolved']);

async function defaultComplete(missionId: string, opts: { path: 'criteria_eval'; predicate: string }) {
  const { completeMissionIfVerified } = await import('@/lib/mission-completion');
  return completeMissionIfVerified(missionId, opts);
}

async function defaultRetrigger(missionId: string, reason: MissionWakeReason) {
  const { maybeRetriggerMission } = await import('@/lib/mission-loop');
  return maybeRetriggerMission(missionId, null, undefined, undefined, { wakeReason: reason });
}

/**
 * Re-plan an auto mission now. A no-op unless the mission is active, in `auto`
 * orchestration, not held, and not dependency-blocked — except that a manual
 * mission still gets a completion attempt on a merge or a settled PR. Never throws.
 */
export async function wakeMission(
  missionId: string,
  reason: MissionWakeReason,
  deps?: MissionWakeDeps,
): Promise<MissionWakeOutcome> {
  try {
    const mission = await db.query.missions.findFirst({
      where: eq(missions.id, missionId),
      columns: {
        id: true,
        status: true,
        orchestrationMode: true,
        isHeld: true,
        dependsOnMissionId: true,
        gateCondition: true,
        dependencyMetAt: true,
      },
    });
    if (!mission) return { woken: false, reason: 'not_found' };
    if (mission.status !== 'active') return { woken: false, reason: 'not_active' };
    // Manual means the owner starts things: nothing wakes it on their behalf.
    // Completing is not starting work, though: an auto mission reaches
    // completion through the retrigger below, a manual one only through here.
    if (mission.orchestrationMode === 'manual') {
      if (COMPLETION_REASONS.has(reason)) {
        await (deps?.complete ?? defaultComplete)(missionId, { path: 'criteria_eval', predicate: `wake:${reason}` });
      }
      return { woken: false, reason: 'manual' };
    }
    // Held is a pure pause and wins over everything else.
    if (mission.isHeld) return { woken: false, reason: 'held' };

    const blocked = await (deps?.isMissionBlocked ?? isMissionBlocked)({
      id: mission.id,
      dependsOnMissionId: mission.dependsOnMissionId ?? null,
      gateCondition: mission.gateCondition,
      dependencyMetAt: mission.dependencyMetAt ?? null,
    });
    if (blocked.blocked) return { woken: false, reason: 'dependency_blocked' };

    const result = await (deps?.retrigger ?? defaultRetrigger)(missionId, reason);
    return { woken: true, action: result.action };
  } catch (err) {
    console.error(`[mission-wake] wake (${reason}) failed for mission ${missionId}:`, err);
    return { woken: false, reason: 'error' };
  }
}

/**
 * Route-handler form: run the wake after the response is sent, so a PATCH or a
 * note post does not wait on the organizer's context build. Falls back to a
 * detached call outside a request scope (tests, scripts). Never throws.
 */
export function wakeMissionAfterResponse(missionId: string, reason: MissionWakeReason): void {
  const run = () => wakeMission(missionId, reason).then(() => undefined);
  try {
    after(run);
  } catch {
    void run();
  }
}
