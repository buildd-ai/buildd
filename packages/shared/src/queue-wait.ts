// @ui-copy: strings here render in the app; copy:check and the em-dash test scan them.
/**
 * The one reason a pending task is not running (spec "Overlap scheduling:
 * serial lanes and file locks", section "What a waiting task can say", AC-10;
 * spec "Health › Queue", R-5 and AC-9).
 *
 * A pending task waits for exactly one of:
 *
 *   declared    a dependency someone set
 *   lane        its place in a serial lane (schema, migrations, a hard surface)
 *   limit       pacing, a cap, a plan, a budget, seats, or a pause, with when it lifts
 *   start_time  its start time
 *   slot        nothing: the claim query would return it now, and it waits
 *               only for a free slot (or names why no runner can take it)
 *
 * The server derives it from the claim route's own query and gates
 * (`queueWaitOf` in @buildd/core/waiting-reason over the live reasons), and
 * every surface words it here: explain's headline, the task page, the mission
 * row, the terminal Queue and the web Queue. "Next in line" is only ever said
 * of a `slot` wait with no runner problem.
 *
 * Pure and client-safe: no I/O, the clock is an argument.
 */

export type QueueWaitKind = 'declared' | 'lane' | 'limit' | 'start_time' | 'slot';

/** Which limit holds it. */
export type QueueLimit =
  | 'mission_cap'
  | 'mission_budget'
  | 'budget'
  | 'plan'
  | 'seats'
  | 'task_paused'
  | 'mission_paused'
  | 'local_session'
  | 'pr_closed';

export interface QueueWait {
  kind: QueueWaitKind;
  /** declared: the first dependency still holding it, and how many hold it in all. */
  blockerId?: string | null;
  blockerTitle?: string | null;
  blockerStatus?: string | null;
  count?: number;
  /** lane: which lane, its holder, the one ahead when the lane is free, and how many go first. */
  lane?: string;
  position?: number | null;
  holderTaskId?: string | null;
  aheadTaskId?: string | null;
  /** lane: when the holder's PR went quiet, if the lane is stuck. */
  stuckSince?: string | null;
  /** limit: which limit, when it lifts (null: when something else moves), whether Force start can lift it. */
  limit?: QueueLimit;
  liftsAt?: string | null;
  forceable?: boolean;
  /** start_time: its start time. */
  startAt?: string | null;
  /** slot: why no runner can take it, when one cannot. */
  noRunnerReason?: string | null;
}

export type QueueBadge = 'Declared' | 'Lane' | 'Limit';

const BADGE: Partial<Record<QueueWaitKind, QueueBadge>> = { declared: 'Declared', lane: 'Lane', limit: 'Limit' };

const LIMIT_LABEL: Record<QueueLimit, string> = {
  mission_cap: 'Mission limit',
  mission_budget: 'Mission budget',
  budget: 'Daily budget',
  plan: 'Plan limit',
  seats: 'Seats in use',
  task_paused: 'Paused',
  mission_paused: 'Mission not running',
  local_session: 'Runs from a session',
  pr_closed: 'Its PR is closed',
};

/** `1st`, `2nd`, `3rd`, `4th`, `11th`, `21st`. */
export function ordinal(n: number): string {
  const m100 = n % 100;
  const suffix = m100 >= 11 && m100 <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th';
  return `${n}${suffix}`;
}

/** A lane's name: the migration lane is the schema lane; a surface lane is its label. */
export function laneLabel(lane: string): string {
  const raw = lane.startsWith('surface:') ? lane.slice('surface:'.length) : lane;
  const name = raw === 'migration' || raw === 'schema' ? 'schema' : raw;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 24 * 60 * 60 * 1000;

/** A future moment without a zone: `in 4m`, `in 2h 05m`, or the date past a day. */
export function queueWhen(at: string, now: number): string {
  const t = Date.parse(at);
  if (Number.isNaN(t)) return 'later';
  const ms = t - now;
  if (ms <= 0) return 'now';
  if (ms < DAY_MS) {
    const m = Math.ceil(ms / 60_000);
    if (m < 60) return `in ${m}m`;
    return `in ${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  }
  const d = new Date(t);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** The Queue badge, or null for a task with none (ready, parked). */
export function queueWaitBadge(w: QueueWait | null | undefined): QueueBadge | null {
  return w ? BADGE[w.kind] ?? null : null;
}

/** The limit's label: `Mission pacing`. */
export function queueLimitLabel(limit: QueueLimit): string {
  return LIMIT_LABEL[limit];
}

function blockerName(w: QueueWait): string {
  const name = w.blockerTitle?.trim() || (w.blockerId ? `task ${w.blockerId.slice(0, 8)}` : 'another task');
  const more = (w.count ?? 1) > 1 ? ` and ${(w.count ?? 1) - 1} more` : '';
  return `${name}${more}`;
}

/**
 * The Queue's "Blocked by" cell: the task (declared), `Schema lane · 2nd`
 * (lane), the limit and when it lifts (limit). Null when nothing blocks it.
 */
export function queueWaitBlockedBy(w: QueueWait | null | undefined, now: number = Date.now()): string | null {
  if (!w) return null;
  if (w.kind === 'declared') return blockerName(w);
  if (w.kind === 'lane') {
    const name = `${laneLabel(w.lane ?? 'migration')} lane`;
    return w.position != null && w.position > 0 ? `${name} · ${ordinal(w.position)}` : name;
  }
  if (w.kind === 'limit') {
    const label = LIMIT_LABEL[w.limit ?? 'mission_cap'];
    return w.liftsAt ? `${label} · lifts ${queueWhen(w.liftsAt, now)}` : label;
  }
  return null;
}

/** True only when the claim query would return the task now and a runner can take it. */
export function isNextInLine(w: QueueWait | null | undefined): boolean {
  return !!w && w.kind === 'slot' && !w.noRunnerReason;
}

/**
 * The one line explain, the task page and the mission row lead with:
 * `Waiting on “Add the index”`, `In the schema lane, 2nd in line`,
 * `Waiting: mission pacing, lifts in 4m`, `Starts in 2h 05m`,
 * `Ready: next in line for a runner`.
 */
export function queueWaitHeadline(w: QueueWait, now: number = Date.now()): string {
  switch (w.kind) {
    case 'declared':
      return `Waiting on ${blockerName(w)}`;
    case 'lane': {
      const lane = `${laneLabel(w.lane ?? 'migration')} lane`;
      return w.position != null && w.position > 0 ? `In the ${lane.toLowerCase()}, ${ordinal(w.position)} in line` : `In the ${lane.toLowerCase()}`;
    }
    case 'limit': {
      const label = LIMIT_LABEL[w.limit ?? 'mission_cap'];
      return `Waiting: ${label.charAt(0).toLowerCase()}${label.slice(1)}${w.liftsAt ? `, lifts ${queueWhen(w.liftsAt, now)}` : ''}`;
    }
    case 'start_time':
      return w.startAt ? `Starts ${queueWhen(w.startAt, now)}` : 'Scheduled';
    case 'slot':
      return w.noRunnerReason ? `Ready, but no runner can take it: ${w.noRunnerReason}` : 'Ready: next in line for a runner';
  }
}

/**
 * The terminal Queue's short words for a wait (null for a slot wait, which the
 * terminal words itself from its free slots): `after “Add the index”`,
 * `schema lane, 2nd`, `mission pacing, in 4m`, `in 2h 05m`.
 */
export function queueWaitShort(w: QueueWait, now: number = Date.now()): string | null {
  switch (w.kind) {
    case 'declared':
      return `after ${blockerName(w)}`;
    case 'lane': {
      const lane = `${laneLabel(w.lane ?? 'migration').toLowerCase()} lane`;
      const stuck = w.stuckSince ? ', holder stalled' : '';
      return w.position != null && w.position > 0 ? `${lane}, ${ordinal(w.position)}${stuck}` : `${lane}${stuck}`;
    }
    case 'limit': {
      const label = LIMIT_LABEL[w.limit ?? 'mission_cap'].toLowerCase();
      return w.liftsAt ? `${label}, ${queueWhen(w.liftsAt, now)}` : label;
    }
    case 'start_time':
      return w.startAt ? queueWhen(w.startAt, now) : 'scheduled';
    case 'slot':
      return w.noRunnerReason ? `no runner: ${w.noRunnerReason}` : null;
  }
}
