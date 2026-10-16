/** The task Time row uses the same frozen payload and formatter as API/MCP. */
import { formatTaskEstimate, type TaskEstimatePayload } from '@buildd/shared';
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


export interface TimeRowSession { startedAt: Date | null; completedAt: Date | null }
export interface TimeRowInput {
  sessions: readonly TimeRowSession[];
  finished: boolean;
  now: number;
  estimate: TaskEstimatePayload | null;
}
export interface TimeRowView {
  text: string;
  overUpper: boolean;
  explanation: string | null;
  breakdown: string | null;
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
  const elapsed = agentMs(i.sessions, i.now);
  const display = i.estimate ? formatTaskEstimate(i.estimate) : null;
  if (!display && elapsed === 0) return null;
  const parts: string[] = [];
  if (elapsed > 0) parts.push(i.finished ? `Took ${formatDuration(elapsed)}` : `${formatDuration(elapsed)} so far`);
  if (display) parts.push(display.headline);
  return {
    text: parts.join(' · '),
    overUpper: !!display?.range && !i.finished && elapsed > display.range.upperMinutes * MINUTE,
    explanation: display?.provenance ?? null,
    breakdown: display?.breakdown ?? null,
  };
}
