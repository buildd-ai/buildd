/**
 * User-facing words for a mission's check-ins and organizer runs
 * (docs/design/event-driven-mission-replanning.md §5).
 *
 * Events plan the next step as soon as work finishes. The hourly check-in
 * (internally the mission "heartbeat" schedule) only dispatches the organizer
 * when the mission is stuck. The internal names stay; only these strings, the
 * ones users read, say "check-in" and "organizer run". Pure: no db.
 */

export const CHECK_INS_EXPLAINER =
  'buildd plans the next step as soon as work finishes, and checks every hour whether the mission is stuck.';

export const ORGANIZER_CHECKLIST_EXPLAINER =
  'What the organizer follows each time it plans the next step.';

// ── Last check ───────────────────────────────────────────────────────────────

export type LastCheckTone = 'success' | 'warning' | 'error' | 'muted';

export interface LastCheck {
  label: string;
  tone: LastCheckTone;
  /** When the check happened (ISO), for a relative time next to the label. */
  at: string | null;
}

export interface LastCheckInput {
  /** `taskSchedules.lastDeferralReason`. The cron clears it when it claims a tick. */
  lastDeferralReason: string | null | undefined;
  lastDeferredAt: Date | string | null | undefined;
  /** `taskSchedules.lastRunAt`: when the last check-in tick was claimed. */
  lastRunAt: Date | string | null | undefined;
  isOverdue: boolean;
  /** The newest organizer (planning) task of the mission, if any. */
  latestOrganizerRun: { triggerSource: unknown; createdAt: Date | string } | null;
}

/** A tick that ran and found nothing to do. */
const ON_TRACK_REASONS = new Set([
  'heartbeat_not_stuck',
  'heartbeat_no_change',
  'trigger_unchanged',
  // Legacy: the concluded triage experiment's "wait" verdict.
  'heartbeat_triage_wait',
]);

/** A tick that deferred on a known wait. Tone is warning unless noted. */
const WAIT_LABELS: Record<string, { label: string; tone: LastCheckTone }> = {
  heartbeat_waiting: { label: 'waiting on a pause or retry', tone: 'muted' },
  heartbeat_blocked: { label: 'waiting on the mission it depends on', tone: 'muted' },
  heartbeat_criteria_blocked: { label: 'waiting on the goal criteria', tone: 'warning' },
  criteria_escalated: { label: 'decision needed', tone: 'warning' },
  budget_exhausted: { label: 'waiting on budget', tone: 'warning' },
  active_hours: { label: 'waiting for quiet hours to end', tone: 'muted' },
  concurrent_cap: { label: 'waiting on a free slot', tone: 'muted' },
  orchestration_manual: { label: 'manual mission', tone: 'muted' },
  heartbeat_planning_backoff: { label: 'waiting to retry planning', tone: 'warning' },
  heartbeat_circuit_breaker: { label: 'paused after repeated failures', tone: 'error' },
};

function iso(d: Date | string | null | undefined): string | null {
  if (d == null) return null;
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

/** What the most recent check-in found, in the owner's words. */
export function describeLastCheck(input: LastCheckInput): LastCheck {
  const runAt = iso(input.lastRunAt);
  if (input.isOverdue) return { label: 'check-in missed', tone: 'error', at: runAt };

  const reason = input.lastDeferralReason ?? null;
  const at = iso(input.lastDeferredAt) ?? runAt;
  if (reason && ON_TRACK_REASONS.has(reason)) return { label: 'on track', tone: 'success', at };
  if (reason && WAIT_LABELS[reason]) return { ...WAIT_LABELS[reason], at };

  if (!runAt) return { label: 'not checked yet', tone: 'muted', at: null };

  // No deferral on the last tick: it dispatched. A backstop organizer run
  // created at or after that tick is the one it started.
  const run = input.latestOrganizerRun;
  if (run && run.triggerSource === 'backstop') {
    const runCreated = iso(run.createdAt);
    if (runCreated && runCreated >= runAt) {
      return { label: 'stuck, organizer started', tone: 'warning', at: runCreated };
    }
  }
  return { label: 'checked', tone: 'muted', at: runAt };
}

// ── Organizer runs ───────────────────────────────────────────────────────────

const TRIGGER_LABELS: Record<string, string> = {
  'wake:dependency_met': 'dependency met',
  'wake:resumed': 'resumed',
  'wake:budget_raised': 'budget raised',
  'wake:pr_merged': 'PR merged',
  'wake:owner_note': 'your note',
  'wake:owner_answer': 'your answer',
  backstop: 'stuck check',
  manual: 'you ran it',
  cron: 'check-in',
  auto_retry: 'retry',
};

/**
 * Label an organizer run by what started it (`tasks.context.triggerSource`,
 * `OrganizerTriggerSource` in lib/mission-run.ts). `event` names the finished
 * task when the caller has its title.
 */
export function organizerRunLabel(triggerSource: unknown, triggerTaskTitle?: string | null): string {
  if (triggerSource === 'event') {
    return triggerTaskTitle ? `after ${triggerTaskTitle} finished` : 'after work finished';
  }
  if (typeof triggerSource === 'string' && TRIGGER_LABELS[triggerSource]) return TRIGGER_LABELS[triggerSource];
  return 'organizer run';
}

export interface OrganizerRunSourceTask {
  id: string;
  mode?: string | null;
  title: string;
  createdAt: Date | string;
  status: string;
  /** The task's context, or its page digest (needs `triggerSource`, `triggerTaskId`). */
  context: unknown;
}

export interface OrganizerRun {
  id: string;
  createdAt: Date | string;
  status: string;
  triggerSource: string | null;
  triggerLabel: string;
}

function ctxString(context: unknown, key: string): string | null {
  if (!context || typeof context !== 'object') return null;
  const v = (context as Record<string, unknown>)[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Every organizer run of the mission (planning-mode tasks, from any trigger),
 * newest first, each labelled by its trigger.
 */
export function selectOrganizerRuns(tasks: ReadonlyArray<OrganizerRunSourceTask>, limit = 20): OrganizerRun[] {
  const byId = new Map(tasks.map(t => [t.id, t]));
  return tasks
    .filter(t => t.mode === 'planning')
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit)
    .map(t => {
      const triggerSource = ctxString(t.context, 'triggerSource');
      const trigger = byId.get(ctxString(t.context, 'triggerTaskId') ?? '');
      // An organizer run that follows another organizer run: its title is
      // just "Mission: …", so say what it was.
      const triggerTitle = trigger
        ? (trigger.mode === 'planning' ? 'the last organizer run' : trigger.title)
        : null;
      return {
        id: t.id,
        createdAt: t.createdAt,
        status: t.status,
        triggerSource,
        triggerLabel: organizerRunLabel(triggerSource, triggerTitle),
      };
    });
}
