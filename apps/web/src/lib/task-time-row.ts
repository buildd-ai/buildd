/**
 * The task page's Time row: how long the agent has worked, next to the frozen
 * estimate. Pure and client-safe so the wording is tested once.
 *
 *   running:   "48m so far · est. 40m-1h 15m"   (warning only past the upper estimate)
 *   finished:  "Took 48m · est. 40m-1h 15m"
 *   cold start: "est. 30m-1h · rough"            (mostly the new-repo prior)
 *
 * The estimate is rounded to a step that matches how sure it can be (5 min,
 * then 15, then 30), so it never reads more precise than it is.
 *
 * Agent time is the sum over sessions, an open session counted to `now`, the
 * same measure the estimate is scored on.
 */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** `<1m`, `48m`, `1h 10m`: task-sized spans only, so no day units. */
function formatDuration(ms: number): string {
  if (!(ms >= MINUTE)) return '<1m';
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  const h = Math.floor(ms / HOUR);
  const m = Math.floor((ms % HOUR) / MINUTE);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/** Round an estimate to a step that fits its size: whole minutes under 10, then 5, 15 and 30 minute steps. */
export function roundEstimateMinutes(min: number): number {
  if (!(min > 0)) return 0;
  const step = min < 10 ? 1 : min < 60 ? 5 : min < 180 ? 15 : 30;
  return Math.max(step, Math.round(min / step) * step);
}

/** Over half the estimate came from the cross-repo prior: little of this team's own history behind it. */
export const ROUGH_PRIOR_WEIGHT = 0.5;

export interface TimeRowSession { startedAt: Date | null; completedAt: Date | null }

export interface TimeRowInput {
  sessions: readonly TimeRowSession[];
  finished: boolean;
  now: number;
  p50Minutes: number | null;
  p80Minutes: number | null;
  summary: string | null;
  /** The estimate's prior weight (0..1); at or over ROUGH_PRIOR_WEIGHT it is labelled rough. */
  priorWeight?: number | null;
}

export interface TimeRowView {
  text: string;
  /** Running and past the upper estimate: the only state the row turns warning. */
  overUpper: boolean;
  /** Mostly the new-repo prior: shown as "rough" and explained. */
  rough: boolean;
  explanation: string | null;
}

export function agentMs(sessions: readonly TimeRowSession[], now: number): number {
  let total = 0;
  for (const s of sessions) {
    if (!s.startedAt) continue;
    const end = s.completedAt ? s.completedAt.getTime() : now;
    if (end > s.startedAt.getTime()) total += end - s.startedAt.getTime();
  }
  return total;
}

export function buildTimeRow(i: TimeRowInput): TimeRowView | null {
  const hasEstimate = i.p50Minutes != null && i.p80Minutes != null;
  const elapsed = agentMs(i.sessions, i.now);
  if (!hasEstimate && elapsed === 0) return null;

  const parts: string[] = [];
  if (elapsed > 0) parts.push(i.finished ? `Took ${formatDuration(elapsed)}` : `${formatDuration(elapsed)} so far`);
  const rough = hasEstimate && i.priorWeight != null && i.priorWeight >= ROUGH_PRIOR_WEIGHT;
  if (hasEstimate) {
    const p50 = roundEstimateMinutes(i.p50Minutes!);
    const lo = formatDuration(p50 * MINUTE);
    const hi = formatDuration(Math.max(p50, roundEstimateMinutes(i.p80Minutes!)) * MINUTE);
    parts.push(lo === hi ? `est. ${lo}` : `est. ${lo}-${hi}`);
    if (rough) parts.push('rough');
  }
  const summary = i.summary?.trim() || null;
  const caveat = rough ? 'Little history in this repo yet, so this is a rough guess.' : null;
  return {
    text: parts.join(' · '),
    overUpper: hasEstimate && !i.finished && elapsed > i.p80Minutes! * MINUTE,
    rough,
    explanation: [summary, caveat].filter(Boolean).join(' ') || null,
  };
}
