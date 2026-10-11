/**
 * Idle-while-queued: the stretches where every runner slot sat idle while work
 * was waiting for one. Pure and client-safe; `home-fleet.ts` loads the rows.
 *
 * Home's Agents panel shades these on the 24h water level, and Health ›
 * Runners shades them on the lanes chart, so both read this one function. A
 * task counts as waiting from its creation until its first run starts (or
 * until now, if it has not started); only tasks nothing else holds back are
 * passed in (no `dependsOn`).
 */

export interface RunInterval {
  start: number;
  /** null: still running. */
  end: number | null;
}

export interface QueuedInterval {
  /** Created at. */
  from: number;
  /** First run started at; null while it still waits. */
  to: number | null;
}

export interface IdleStretch {
  from: number;
  to: number;
  /** Most tasks waiting at once during the stretch. */
  waited: number;
}

/** A stretch shorter than this is a poll gap, not an idle fleet. */
export const IDLE_STRETCH_MIN_MS = 15 * 60_000;

/**
 * Stretches inside [from, to] with zero runs live and at least one task
 * waiting, at least `minMs` long. Adjacent stretches merge.
 */
export function idleWhileQueued(input: {
  runs: readonly RunInterval[];
  queued: readonly QueuedInterval[];
  from: number;
  to: number;
  minMs?: number;
}): IdleStretch[] {
  const { from, to, minMs = IDLE_STRETCH_MIN_MS } = input;
  const events: Array<[number, 'run' | 'queue', number]> = [];
  const clamp = (t: number) => Math.min(Math.max(t, from), to);
  for (const r of input.runs) {
    const s = clamp(r.start);
    const e = clamp(r.end ?? to);
    if (e > s) events.push([s, 'run', 1], [e, 'run', -1]);
  }
  for (const q of input.queued) {
    const s = clamp(q.from);
    const e = clamp(q.to ?? to);
    if (e > s) events.push([s, 'queue', 1], [e, 'queue', -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[2] - b[2]);

  const out: IdleStretch[] = [];
  let runs = 0;
  let queue = 0;
  let cursor = from;
  let open: IdleStretch | null = null;
  const close = (at: number) => {
    if (open && at - open.from >= minMs) out.push({ ...open, to: at });
    open = null;
  };
  const apply = (at: number) => {
    const idle = runs === 0 && queue > 0;
    if (idle && !open) open = { from: at, to: at, waited: queue };
    else if (idle && open) open.waited = Math.max(open.waited, queue);
    else if (!idle) close(at);
  };
  for (let i = 0; i < events.length;) {
    const at = events[i][0];
    cursor = at;
    while (i < events.length && events[i][0] === at) {
      const [, kind, d] = events[i++];
      if (kind === 'run') runs += d; else queue += d;
    }
    apply(at);
  }
  close(Math.max(cursor, to));
  return out;
}

function span(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? `${h}h` : `${h}h ${String(rest).padStart(2, '0')}m`;
}

const tasks = (n: number) => `${n} ${n === 1 ? 'task' : 'tasks'}`;

/** Home's one-liner: `idle 2h while 3 tasks waited`. */
export function idleStretchLabel(s: IdleStretch): string {
  return `idle ${span(s.to - s.from)} while ${tasks(s.waited)} waited`;
}

/** Health's sentence: `every slot sat idle 1h 05m while 3 tasks waited`. */
export function idleStretchSentence(s: IdleStretch): string {
  return `every slot sat idle ${span(s.to - s.from)} while ${tasks(s.waited)} waited`;
}
