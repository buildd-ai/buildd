/**
 * The heartbeat's stuck check (docs/design/event-driven-mission-replanning.md §3).
 *
 * Events plan every auto mission: a task finishing, a dependency clearing, the
 * owner writing. The hourly heartbeat is a backstop for when that chain broke
 * (a missed event, retries exhausted, a chain that hit its depth cap), so it
 * dispatches the organizer only when this check says the mission is stuck.
 * Otherwise every step would be planned twice.
 *
 * Pure: the cron supplies the prepass result (which carries the open-work
 * counts from the task rows it already loaded) and the last organizer run.
 */
import type { HeartbeatPrepassDecision } from './heartbeat-prepass';

/**
 * How long after any organizer run (event, wake, manual, cron or backstop) the
 * backstop stays out. Two hourly ticks: long enough that an event plan is
 * never doubled, short enough that a missed event costs a couple of hours.
 */
export const BACKSTOP_GRACE_MS = 2 * 60 * 60 * 1000;

export interface MissionStuckInput {
  /** This tick's prepass decision, or null when the prepass failed. */
  prepass: HeartbeatPrepassDecision | null;
  /** `createdAt` of the mission's newest planning task, whatever started it. */
  lastOrganizerRunAt: Date | null;
  now: Date;
}

export type MissionStuckVerdict =
  | { stuck: true; reason: 'state_changed_unplanned' }
  | {
      stuck: false;
      reason: 'prepass_unavailable' | 'prepass_skipped' | 'open_work' | 'planning_active' | 'recent_organizer_run';
    };

/**
 * Stuck means all of:
 * - the prepass reports the state changed (`invoke_llm`);
 * - no open task, the prepass's self-resolving waits excluded (a finishing task
 *   re-plans through the event loop);
 * - no active planning task;
 * - no organizer run within `BACKSTOP_GRACE_MS`.
 *
 * The criteria re-arm is not decided here: it has its own once-per-verdict
 * guard in the cron and dispatches regardless.
 *
 * Fails closed on a missing prepass: events still drive the mission, and the
 * next tick asks again.
 */
export function isMissionStuck(input: MissionStuckInput): MissionStuckVerdict {
  const { prepass, lastOrganizerRunAt, now } = input;
  if (!prepass) return { stuck: false, reason: 'prepass_unavailable' };
  if (prepass.action !== 'invoke_llm') return { stuck: false, reason: 'prepass_skipped' };
  if (prepass.openTaskCount > 0) return { stuck: false, reason: 'open_work' };
  if (prepass.planningActive) return { stuck: false, reason: 'planning_active' };
  if (lastOrganizerRunAt && now.getTime() - lastOrganizerRunAt.getTime() <= BACKSTOP_GRACE_MS) {
    return { stuck: false, reason: 'recent_organizer_run' };
  }
  return { stuck: true, reason: 'state_changed_unplanned' };
}
