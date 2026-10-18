/**
 * A runner's heartbeat in Redis (lib/liveness.ts), and the overlay its
 * "online now" readers use.
 *
 * POST /api/workers/heartbeat writes `worker_heartbeats` only when the row's
 * content changes (slots, busy count, version, update state, ...), when it
 * renews a worker it has not renewed before, or once per
 * LIVENESS_DB_WRITE_INTERVAL_MS. Every other beat stamps Redis. So a stored
 * `last_heartbeat_at` can be up to one interval old for a runner that is up.
 *
 * Windows at or above RUNNER_RECENTLY_SEEN_MS (10 min) are longer than that
 * and read the table as before. RUNNER_LIVE_WINDOW_MS ("online now", 3 min) is
 * not: every reader of it passes its rows through `withLiveRunnerBeats`, and
 * one that filters in SQL widens its cutoff with `runnerLiveCandidateCutoff`
 * first. Without Redis every beat writes the table, so the table alone is
 * current and the overlay is a no-op.
 */
import * as redis from './redis';
import { latestBeat, liveness, LIVENESS_DB_WRITE_INTERVAL_MS, type LivenessGate } from './liveness';

/** One runner instance: the heartbeat table's unique key. */
export function runnerBeatId(accountId: string, localUiUrl: string): string {
  return `${accountId}|${localUiUrl}`;
}

/** Stamp a runner's Redis beat this long, so the overlay covers the stored value's whole staleness. */
export const RUNNER_BEAT_TTL_MS = 2 * LIVENESS_DB_WRITE_INTERVAL_MS;

/** Rows with `lastHeartbeatAt` raised to the runner's Redis beat when that is newer. */
export async function withLiveRunnerBeats<T extends { accountId: string; localUiUrl: string; lastHeartbeatAt: Date | string | null | undefined }>(
  rows: T[],
  gate: LivenessGate = liveness,
): Promise<T[]> {
  if (rows.length === 0) return rows;
  const ids = rows.map(r => runnerBeatId(r.accountId, r.localUiUrl));
  const beats = await gate.readBeats('runner', ids);
  if (!beats || beats.size === 0) return rows;
  return rows.map((r, i) => {
    const beat = beats.get(ids[i]);
    return beat === undefined || r.lastHeartbeatAt == null ? r : { ...r, lastHeartbeatAt: latestBeat(r.lastHeartbeatAt, beat) };
  });
}

/**
 * SQL prefilter for a window shorter than the write interval: candidates whose
 * stored beat is inside window + interval; `withLiveRunnerBeats` then decides.
 */
export function runnerLiveCandidateCutoff(nowMs: number, windowMs: number): Date {
  return new Date(nowMs - windowMs - LIVENESS_DB_WRITE_INTERVAL_MS);
}

/**
 * What the heartbeat route needs from the last row it wrote, so a beat that
 * changes nothing reads no row either. `fp` is the written content; `leaseIds`
 * the workers whose lease that write renewed (scoped to this account and live,
 * by the UPDATE). A beat naming any other worker writes, so Redis never
 * vouches for a worker the database did not.
 */
export interface RunnerBeatState {
  viewerToken: string;
  updateAvailable: boolean | null;
  updateAvailableSince: string | null;
  fp: string;
  leaseIds: string[];
}

const r = redis as Partial<typeof redis>;
const stateKey = (id: string) => `buildd:live-state:runner:${id}`;
/** Outlives the write interval by a margin; a lapsed state only costs one read and one write. */
const STATE_TTL_SEC = Math.ceil((3 * LIVENESS_DB_WRITE_INTERVAL_MS) / 1000);

export interface RunnerBeatStateStore {
  /** Undefined: could not ask. Null: none. */
  get(id: string): Promise<RunnerBeatState | null | undefined>;
  set(id: string, state: RunnerBeatState): Promise<void>;
}

export const redisRunnerBeatStateStore: RunnerBeatStateStore = {
  async get(id) {
    try {
      const v = await r.getKey?.<RunnerBeatState>(stateKey(id));
      if (v === undefined) return undefined;
      return v && typeof v === 'object' && typeof v.viewerToken === 'string' && typeof v.fp === 'string' && Array.isArray(v.leaseIds) ? v : null;
    } catch {
      return undefined;
    }
  },
  async set(id, state) {
    try {
      await r.setWithTtl?.(stateKey(id), state, STATE_TTL_SEC);
    } catch {
      // Next beat reads the row instead.
    }
  },
};
