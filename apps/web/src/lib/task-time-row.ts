/**
 * The task page's Time row: how long the agent has worked, next to the frozen
 * estimate. Pure and client-safe so the wording is tested once.
 *
 *   running:   "48m so far · est. 40m-1h 10m"   (warning only past the upper estimate)
 *   finished:  "Took 48m · est. 40m-1h 10m"
 *
 * Agent time is the sum over sessions, an open session counted to `now`, the
 * same measure the estimate is scored on.
 */
import { formatDuration } from './mission-duration';

const MINUTE = 60_000;

export interface TimeRowSession { startedAt: Date | null; completedAt: Date | null }

export interface TimeRowInput {
  sessions: readonly TimeRowSession[];
  finished: boolean;
  now: number;
  p50Minutes: number | null;
  p80Minutes: number | null;
  summary: string | null;
}

export interface TimeRowView {
  text: string;
  /** Running and past the upper estimate: the only state the row turns warning. */
  overUpper: boolean;
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
  if (hasEstimate) {
    const lo = formatDuration(i.p50Minutes! * MINUTE);
    const hi = formatDuration(i.p80Minutes! * MINUTE);
    parts.push(lo === hi ? `est. ${lo}` : `est. ${lo}-${hi}`);
  }
  return {
    text: parts.join(' · '),
    overUpper: hasEstimate && !i.finished && elapsed > i.p80Minutes! * MINUTE,
    explanation: i.summary?.trim() || null,
  };
}
