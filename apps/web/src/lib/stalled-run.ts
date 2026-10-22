/**
 * Is a running worker stalled? (Living Spec "Navigation: one place per task",
 * R-7 / AC-15: `Running 1h 12m · no progress for 48m`.)
 *
 * Progress is the newest stored sign that the agent did something:
 *   - a milestone (`workers.milestones[].ts`): phase = a turn, action = a tool
 *     call, plan/status from the agent, checkpoint = first commit / first push;
 *   - an MCP call (`workers.mcpCalls[].ts`);
 *   - otherwise the run's start (`workers.startedAt`), so a fresh run is not stalled.
 *
 * Heartbeats are NOT progress: a hung test keeps heartbeating. That rules out
 * `updatedAt` (bumped by every runner sync), `leaseExpiresAt` and
 * `workerHeartbeats.lastHeartbeatAt`.
 *
 * Not stored, so not read: the time of each commit after the first (only
 * `lastCommitSha` / `commitCount`, no timestamp) and the time `currentAction`
 * last changed. Turns are a bare count; phase milestones stand in for them.
 *
 * Only `running` can stall. Waiting on a person (waiting_input, a pending
 * pause or question, a requested pause, a parked run) is not a stall.
 */

/** No progress for longer than this flags a running worker as stalled. */
export const STALLED_RUN_THRESHOLD_MS = 30 * 60_000;

type DateLike = Date | string | number | null | undefined;

export interface StalledRunWorker {
  status: string;
  waitingFor?: unknown;
  startedAt?: DateLike;
  pauseRequestedAt?: DateLike;
  parkedUntil?: DateLike;
  milestones?: ReadonlyArray<{ ts?: unknown }> | null;
  mcpCalls?: ReadonlyArray<{ ts?: unknown }> | null;
}

function toMs(v: unknown): number | null {
  if (v == null) return null;
  const ms = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

/** Newest progress signal, in epoch ms, or null when there is none at all. */
export function lastProgressAt(worker: StalledRunWorker): number | null {
  let newest = toMs(worker.startedAt);
  for (const list of [worker.milestones, worker.mcpCalls]) {
    for (const entry of list ?? []) {
      const ts = toMs(entry?.ts);
      if (ts != null && (newest == null || ts > newest)) newest = ts;
    }
  }
  return newest;
}

/**
 * How long a running worker has gone without progress, in ms, when that is
 * longer than STALLED_RUN_THRESHOLD_MS; otherwise null.
 */
export function stalledFor(worker: StalledRunWorker, now: Date | number = Date.now()): number | null {
  if (worker.status !== 'running') return null;
  if (worker.waitingFor) return null;
  if (toMs(worker.pauseRequestedAt) != null) return null;
  if (toMs(worker.parkedUntil) != null) return null;

  const last = lastProgressAt(worker);
  if (last == null) return null;
  const idle = toMs(now)! - last;
  return idle > STALLED_RUN_THRESHOLD_MS ? idle : null;
}
