/**
 * Is THIS worker's runner alive? The one judgment the offline-runner reaper
 * (lib/stale-workers.ts) and explain share.
 *
 * A worker records the runner that claimed it (`workers.runner`, the runner's
 * `localUiUrl`; `workers.localUiUrl` once it registers), and a runner's
 * heartbeat row is unique per (account, localUiUrl), so the two join
 * (`runnerKey` / `matchRunnerHeartbeat` in lib/runner-display.ts). Judging a
 * worker by its own runner is what lets a dead runner's workers be reaped
 * while the account's other runners keep heartbeating: keyed on the account,
 * "is any runner alive?" was true, so they never became orphans (Oct 22: two
 * workers of a Mac that went offline stayed `running` for hours, held their
 * path leases, and the tasks a person set back to pending were refused by
 * the claim guard because a live-status worker row still sat on them).
 *
 * The only evidence of life is the runner speaking: its heartbeat row (Redis
 * beat overlaid, lib/runner-beats.ts) and the worker lease it renews on that
 * beat. `workers.updated_at` is NOT evidence: a message a person sends, an
 * idle probe, a description-change notice or a path-release notice all bump
 * it from the server side, and would keep a dead worker alive indefinitely.
 */
import { db } from '@buildd/core/db';
import { workerHeartbeats } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { RUNNER_STALE_CUTOFF_MS, runnerUpdateState } from '@buildd/shared';
import { withLiveRunnerBeats } from '@/lib/runner-beats';
import { runnerIdentity, runnerKey, runnerNameFromUrl, type RunnerHeartbeatLike, type RunnerWorkerLike } from '@/lib/runner-display';

export interface RunnerBeat extends RunnerHeartbeatLike {
  accountId: string;
  localUiUrl: string;
  /** Stored value raised to the Redis beat when that is newer. */
  lastHeartbeatAt: Date;
  /** The update the runner reported it was applying (shared runner-update.ts), when one. */
  updateDrain?: unknown;
}

/** A worker row as the liveness judgment reads it. */
export interface RunnerWorkerEvidence extends RunnerWorkerLike {
  /** Renewed by the owning runner's heartbeat; NULL on a build that never renews. */
  leaseExpiresAt?: Date | string | null;
}

export type RunnerVerdict =
  /** Its runner beat inside the cutoff. */
  | 'live'
  /** Its runner's last beat (or its lease) is past the cutoff. */
  | 'dead'
  /** Nothing to judge by: no runner named, or no row and no lease. The caller falls back to the account-wide rule. */
  | 'unknown';

export interface RunnerLiveness {
  key: string | null;
  /** The runner's display name (lib/runner-display.ts), when one is named. */
  name: string | null;
  lastBeatAt: Date | null;
  /** How long since the last beat; null without a row. */
  silentMs: number | null;
  verdict: RunnerVerdict;
}

/**
 * Every runner heartbeat on ONE account, any age, with the Redis beat
 * overlaid. All rows, not just fresh ones: a stale row and a missing row are
 * different evidence (a row is deleted only once past the same cutoff, after
 * the reap in the same sweep). Throws when the table cannot be read: a read
 * failure is not evidence of death, so the reaper must not proceed on it.
 */
export async function loadRunnerBeats(accountId: string): Promise<RunnerBeat[]> {
  const rows = await db.query.workerHeartbeats.findMany({
    where: sqlWhere(eq(workerHeartbeats.accountId, accountId)),
    columns: { accountId: true, localUiUrl: true, lastHeartbeatAt: true, environment: true, updateDrain: true },
  });
  const live = await withLiveRunnerBeats(rows.map(r => ({
    accountId: r.accountId,
    localUiUrl: r.localUiUrl,
    lastHeartbeatAt: r.lastHeartbeatAt,
    environment: { labels: r.environment?.labels ?? null },
    updateDrain: r.updateDrain ?? null,
  })));
  return live.map(r => ({ ...r, lastHeartbeatAt: r.lastHeartbeatAt instanceof Date ? r.lastHeartbeatAt : new Date(r.lastHeartbeatAt as string) }));
}

const toMs = (v: Date | string | null | undefined): number | null => {
  if (v == null) return null;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
};

/**
 * Judge one worker by its own runner. `beats` are the worker's account's rows
 * (`loadRunnerBeats`); `cutoffMs` is the "not dead" window and must stay
 * RUNNER_STALE_CUTOFF_MS wherever the verdict kills work.
 */
export function runnerLiveness(
  w: RunnerWorkerEvidence,
  beats: readonly RunnerBeat[],
  now: Date,
  cutoffMs: number = RUNNER_STALE_CUTOFF_MS,
): RunnerLiveness {
  const key = runnerKey(w);
  if (!key) return { key: null, name: null, lastBeatAt: null, silentMs: null, verdict: 'unknown' };
  const hb = beats.find(h => h.localUiUrl === key && (!w.accountId || h.accountId === w.accountId)) ?? null;
  if (hb) {
    const lastBeatAt = hb.lastHeartbeatAt;
    const silentMs = Math.max(0, now.getTime() - lastBeatAt.getTime());
    return { key, name: runnerIdentity(hb).name, lastBeatAt, silentMs, verdict: silentMs > cutoffMs ? 'dead' : 'live' };
  }
  // No row: deleted once past the cutoff, or never written. The worker's own
  // lease is the runner's other signature: a lease the runner was renewing
  // and let lapse past the cutoff is a runner that stopped.
  const lease = toMs(w.leaseExpiresAt);
  const verdict: RunnerVerdict = lease !== null && lease < now.getTime() - cutoffMs ? 'dead' : 'unknown';
  return { key, name: runnerNameFromUrl(key), lastBeatAt: null, silentMs: null, verdict };
}

/**
 * R-38 for an update (spec 47c97f48, R-6): a worker paused while its runner
 * updates stays with that runner, however late its heartbeat, until the
 * runner has been silent UPDATE_RELEASE_SILENCE_MS. The offline-runner reaper
 * skips it; the update watch (lib/runner-update-watch.ts) releases it then.
 */
export function heldForRunnerUpdate(
  w: RunnerWorkerEvidence & { status?: string | null; waitingFor?: { type?: string } | null },
  beats: readonly RunnerBeat[],
  now: Date,
): boolean {
  if (w.status !== 'waiting_input' || w.waitingFor?.type !== 'pause') return false;
  const key = runnerKey(w);
  const hb = key ? beats.find(h => h.localUiUrl === key && (!w.accountId || h.accountId === w.accountId)) : undefined;
  if (!hb?.updateDrain) return false;
  const view = runnerUpdateState({ updateDrain: hb.updateDrain, lastHeartbeatAt: hb.lastHeartbeatAt }, now.getTime());
  return !!view && !view.release;
}

/** "12m", "2h 31m". Under a minute rounds to "0m". */
export function formatSilence(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * What explain says about a live-status worker whose runner has gone quiet:
 * not RUNNING, but what the task is actually waiting on.
 */
export function offlineRunnerWaitLine(l: RunnerLiveness, cutoffMs: number = RUNNER_STALE_CUTOFF_MS): string {
  const name = l.name ?? 'unknown';
  const offline = l.silentMs !== null ? `offline ${formatSilence(l.silentMs)}` : 'offline, no heartbeat on record';
  return `waiting for runner ${name} (${offline}) to be confirmed dead: its worker is still recorded as running, and the task is requeued for another runner once the runner has been silent for ${formatSilence(cutoffMs)}`;
}
