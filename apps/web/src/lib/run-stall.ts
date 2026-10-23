/**
 * A running builder that has reported nothing for a while (Navigation:
 * one place per task, R-7). Progress is the newest milestone the run reported,
 * else its start; a heartbeat is not progress.
 */
import { formatElapsed } from '@/app/app/(protected)/tasks/[id]/format-elapsed';

export const STALL_AFTER_MS = 30 * 60_000;

export interface RunStall {
  quietMs: number;
  /** `Running 1h 12m · no progress for 48m` */
  label: string;
}

export function runStall({ status, startMs, progressMs, nowMs }: {
  status: string;
  startMs: number | null;
  progressMs: number | null;
  nowMs: number;
}): RunStall | null {
  if (status !== 'running' || startMs == null) return null;
  const quietMs = nowMs - Math.max(startMs, progressMs ?? startMs);
  if (quietMs < STALL_AFTER_MS) return null;
  return { quietMs, label: `Running ${formatElapsed(nowMs - startMs)} · no progress for ${formatElapsed(quietMs)}` };
}
