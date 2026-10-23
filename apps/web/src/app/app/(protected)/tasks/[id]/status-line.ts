/**
 * The task's state under its title while a builder runs (Navigation: one
 * place per task, R-14): one word and how long, `Running 12m`. A run that has
 * reported nothing for 30 minutes reads as R-7 has it,
 * `Running 1h 12m · no progress for 48m`. Progress is the newest milestone
 * the run reported (lib/run-stall.ts), the same clock the live block uses.
 */
import { runStall } from '@/lib/run-stall';
import { formatElapsed } from './format-elapsed';

export interface RunningStatusLine {
  text: string;
  stalled: boolean;
}

const RUNNING = new Set(['running', 'starting']);

export function runningStatusLine({ status, startedAt, milestones, waiting, nowMs }: {
  status: string;
  startedAt: string | Date | null;
  milestones: ReadonlyArray<{ ts: number }>;
  /** An open question: the question card carries the state, not this line. */
  waiting: boolean;
  nowMs: number;
}): RunningStatusLine | null {
  if (waiting || !RUNNING.has(status)) return null;
  const startMs = startedAt ? new Date(startedAt).getTime() : null;
  if (startMs == null || !Number.isFinite(startMs)) return { text: 'Running', stalled: false };
  const progressMs = milestones.reduce<number | null>((m, x) => (m == null || x.ts > m ? x.ts : m), null);
  const stall = runStall({ status, startMs, progressMs, nowMs });
  if (stall) return { text: stall.label, stalled: true };
  return { text: `Running ${formatElapsed(nowMs - startMs)}`, stalled: false };
}
