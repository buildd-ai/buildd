/**
 * The task page's "Start" choices and the PATCH body each one sends. A start
 * time moves a waiting task later (or back to ASAP) without cancelling it;
 * the server refuses it once a worker has the task (PATCH /api/tasks/[id]).
 */
export type StartChoice =
  | { kind: 'asap' }
  | { kind: 'in'; duration: '1h' | '4h' }
  | { kind: 'tomorrow' }
  | { kind: 'pick'; at: Date };

export type StartTimeBody = { startAt: string | null } | { startIn: string };

/** 9:00 local on the day after `now`. */
export function tomorrowMorning(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0, 0, 0);
}

/** The PATCH body for a choice, or null when a picked time is empty or not in the future. */
export function startTimeBody(choice: StartChoice, now: Date = new Date()): StartTimeBody | null {
  switch (choice.kind) {
    case 'asap':
      return { startAt: null };
    case 'in':
      return { startIn: choice.duration };
    case 'tomorrow':
      return { startAt: tomorrowMorning(now).toISOString() };
    case 'pick':
      if (Number.isNaN(choice.at.getTime()) || choice.at <= now) return null;
      return { startAt: choice.at.toISOString() };
  }
}

/** One line for the current start: "As soon as possible" or "Starts <when>". */
export function startTimeLabel(startAt: string | null, now: Date = new Date()): string {
  if (!startAt) return 'As soon as possible';
  const at = new Date(startAt);
  if (Number.isNaN(at.getTime()) || at <= now) return 'As soon as possible';
  const sameDay = at.toDateString() === now.toDateString();
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return sameDay
    ? `Starts ${time}`
    : `Starts ${at.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}, ${time}`;
}

/** Same rule as the server: only a task still waiting for a worker has a start time to move. */
export function canReschedule(status: string, claimedBy: string | null | undefined): boolean {
  return status === 'pending' && !claimedBy;
}
