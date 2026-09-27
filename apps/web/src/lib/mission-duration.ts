/**
 * How long a mission took, as a reader asks it: how much work went into it,
 * and how long it stayed open. The two differ by orders of magnitude on a
 * mission whose PR sat in review for weeks (40 minutes of agent work, open 35
 * days), and a wall-clock `855:01:02` answers neither.
 *
 * Pure and client-safe. Every surface that prints a mission's duration (the
 * Board/Lanes header, the completion record, Home's shipped card, the missions
 * list) reads `describeMissionDuration`, so they cannot disagree.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * `<1m`, `42m`, `3h 5m`, `2d 4h`, `35d`. Two units at most; the smaller one is
 * dropped when zero, and from a week up days alone say enough.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !(ms >= MINUTE)) return '<1m';
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  if (ms < DAY) {
    const h = Math.floor(ms / HOUR);
    const m = Math.floor((ms % HOUR) / MINUTE);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(ms / DAY);
  if (d >= 7) return `${d}d`;
  const h = Math.floor((ms % DAY) / HOUR);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

export interface Span {
  start: number;
  /** Null while open: counted to `now`. */
  end: number | null;
}

/**
 * Wall time covered by at least one span: two agents working the same ten
 * minutes are ten minutes of mission work, not twenty.
 */
export function activeWorkMs(spans: readonly Span[], now: number): number {
  const iv = spans
    .map(s => [s.start, s.end ?? now] as const)
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let curStart = NaN;
  let curEnd = NaN;
  for (const [a, b] of iv) {
    if (!(a <= curEnd)) {
      if (curEnd > curStart) total += curEnd - curStart;
      curStart = a;
      curEnd = b;
    } else if (b > curEnd) {
      curEnd = b;
    }
  }
  if (curEnd > curStart) total += curEnd - curStart;
  return total;
}

export interface MissionDuration {
  /** `40m`, or null when no agent ever ran. */
  work: string | null;
  /** `35d`: filed → completed (or now, while it runs). */
  open: string;
  /** The open span is worth naming beside the work (not just the work plus a margin). */
  showOpen: boolean;
  /** One line: `40m of work · open 35d`, `took 40m`, `open 3d`. */
  label: string;
}

/**
 * The open span reads beside the work only when it says something the work
 * does not: at least twice as long and at least an hour more. A mission that
 * ran 38 minutes in a 41-minute window just "took 38m".
 */
export function describeMissionDuration({ activeMs, openMs }: { activeMs: number | null | undefined; openMs: number | null | undefined }): MissionDuration {
  const open = formatDuration(openMs ?? 0);
  if (activeMs == null || !(activeMs > 0)) {
    return { work: null, open, showOpen: true, label: `open ${open}` };
  }
  const work = formatDuration(activeMs);
  const showOpen = openMs != null && openMs >= activeMs * 2 && openMs - activeMs >= HOUR;
  return { work, open, showOpen, label: showOpen ? `${work} of work · open ${open}` : `took ${work}` };
}
