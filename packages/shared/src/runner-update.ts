/**
 * A runner applying a self-update (Living Spec "Runner updates in minutes:
 * pause, update, continue", R-5 to R-7). The runner reports the update on
 * every heartbeat as `updateDrain`; the server stores it on the heartbeat row
 * and reads it back here, so list_runners, Health and Home say the same thing.
 *
 *  - `draining`: claims are halted; agents that fit the window finish, the
 *    rest are being paused.
 *  - `updating`: the window has closed (or the new version has just started)
 *    and the agents paused for it wait to continue. No free slots either way.
 *
 * A runner whose heartbeat is late while draining, or that has not beaten
 * again UPDATE_STUCK_GRACE_MS after the window's end, is "stuck"; after
 * UPDATE_RELEASE_SILENCE_MS of silence its paused tasks are released as new
 * attempts (UPDATE_STOPPED_REASON).
 */
import { RUNNER_LIVE_WINDOW_MS } from './runner-liveness';

export type RunnerUpdatePhase = 'draining' | 'updating';

/** One agent paused so the update could apply. */
export interface PausedForUpdate {
  workerId: string;
  taskId: string | null;
  title: string | null;
  /** ISO time it was paused. */
  since: string | null;
}

/** The heartbeat row's `update_drain`, as stored (ISO strings). */
export interface StoredUpdateDrain {
  since: string;
  /** The window's end; once the update applies, the moment it applied. */
  endsAt: string;
  busy: number;
  /** Absent on a row an older runner wrote: read as `draining`. */
  phase?: RunnerUpdatePhase;
  targetVersion?: string | null;
  paused?: PausedForUpdate[];
  /** Set once the team has been told the update is stuck (one notification, R-6). */
  stuckNotifiedAt?: string | null;
}

/** How long past the window's end a silent runner is still only "updating". */
export const UPDATE_STUCK_GRACE_MS = 15 * 60_000;
/** How long a silent updating runner keeps its paused tasks before they are released. */
export const UPDATE_RELEASE_SILENCE_MS = 60 * 60_000;
/** A heartbeat older than this is late (a presence-connected runner beats on change and every 10-15 minutes; an older build every minute). */
export const UPDATE_HEARTBEAT_LATE_MS = RUNNER_LIVE_WINDOW_MS;
/** The reason a released task's new attempt carries. */
export const UPDATE_STOPPED_REASON = 'runner stopped during an update';

const MAX_PAUSED = 50;
const MAX_TEXT = 160;

function iso(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString();
  if (typeof v === 'string' && v) {
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }
  return null;
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, MAX_TEXT) : null;
}

/**
 * The `updateDrain` a heartbeat sent (epoch ms or ISO), normalised for
 * storage, or null when it is not one. Junk entries in `paused` are dropped.
 */
export function parseUpdateDrain(raw: unknown): StoredUpdateDrain | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const since = iso(r.since);
  const endsAt = iso(r.endsAt);
  if (!since || !endsAt) return null;
  const phase: RunnerUpdatePhase = r.phase === 'updating' ? 'updating' : 'draining';
  const paused: PausedForUpdate[] = [];
  if (Array.isArray(r.paused)) {
    for (const p of r.paused) {
      if (paused.length >= MAX_PAUSED) break;
      if (!p || typeof p !== 'object') continue;
      const e = p as Record<string, unknown>;
      const workerId = text(e.workerId);
      if (!workerId) continue;
      paused.push({ workerId, taskId: text(e.taskId), title: text(e.title), since: iso(e.since) });
    }
  }
  return {
    since,
    endsAt,
    busy: typeof r.busy === 'number' && Number.isFinite(r.busy) ? Math.max(0, Math.floor(r.busy)) : 0,
    phase,
    targetVersion: text(r.targetVersion),
    paused,
  };
}

export type RunnerUpdateView = {
  phase: RunnerUpdatePhase;
  targetVersion: string | null;
  paused: PausedForUpdate[];
  /** ISO window end (or the moment the update applied). */
  endsAt: string;
  /** Late heartbeat while draining, or silent UPDATE_STUCK_GRACE_MS past the window's end. */
  stuck: boolean;
  /** The last heartbeat, ISO: what "stuck since" names. */
  lastHeartbeatAt: string;
  /** Silent UPDATE_RELEASE_SILENCE_MS: its paused tasks are released as new attempts. */
  release: boolean;
};

/** What a heartbeat row says about an update in progress, or null when there is none. */
export function runnerUpdateState(
  row: { updateDrain?: unknown; lastHeartbeatAt: Date | string | number | null | undefined },
  now: number = Date.now(),
): RunnerUpdateView | null {
  const drain = parseUpdateDrain(row.updateDrain);
  const hb = row.lastHeartbeatAt;
  const last = hb instanceof Date ? hb.getTime() : typeof hb === 'number' ? hb : Date.parse(String(hb ?? ''));
  if (!drain || Number.isNaN(last)) return null;
  const silent = Math.max(0, now - last);
  const late = silent > UPDATE_HEARTBEAT_LATE_MS;
  // R-6: 15 minutes after the window's end, or after its last word if it beat
  // since then (a runner that reported `updating` and then went quiet).
  const quietFrom = Math.max(Date.parse(drain.endsAt), last);
  const stuck = late && (drain.phase === 'draining' || now - quietFrom >= UPDATE_STUCK_GRACE_MS);
  return {
    phase: drain.phase ?? 'draining',
    targetVersion: drain.targetVersion ?? null,
    paused: drain.paused ?? [],
    endsAt: drain.endsAt,
    stuck,
    lastHeartbeatAt: new Date(last).toISOString(),
    release: silent >= UPDATE_RELEASE_SILENCE_MS,
  };
}

/** When a sweep should next look at this runner: when it would turn stuck, then when it would be released. */
export function nextUpdateCheckAt(row: { updateDrain?: unknown; lastHeartbeatAt: Date | string | number }, now: number = Date.now()): number | null {
  const view = runnerUpdateState(row, now);
  if (!view) return null;
  const last = Date.parse(view.lastHeartbeatAt);
  if (!view.stuck) {
    const late = last + UPDATE_HEARTBEAT_LATE_MS + 1;
    return view.phase === 'draining' ? late : Math.max(late, Math.max(Date.parse(view.endsAt), last) + UPDATE_STUCK_GRACE_MS);
  }
  return view.release ? null : last + UPDATE_RELEASE_SILENCE_MS;
}

function pausedNames(paused: PausedForUpdate[]): string {
  const names = paused.map(p => p.title ? `"${p.title}"` : `worker ${p.workerId.slice(0, 8)}`);
  return names.length > 5 ? `${names.slice(0, 5).join(', ')} and ${names.length - 5} more` : names.join(', ');
}

/**
 * One line for list_runners, Health and Home. `runnerName` names the runner
 * in the stuck line; `formatTime` renders its last heartbeat.
 */
export function runnerUpdateLine(
  view: RunnerUpdateView,
  runnerName: string,
  formatTime: (iso: string) => string = (s) => s,
): string {
  if (view.stuck) {
    const held = view.paused.length > 0 ? ` (${view.paused.length} paused agent${view.paused.length === 1 ? '' : 's'} waiting)` : '';
    return `Update stuck on ${runnerName} since ${formatTime(view.lastHeartbeatAt)}${held}`;
  }
  const head = view.phase === 'draining'
    ? `Updating${view.targetVersion ? ` to ${view.targetVersion}` : ''}: pausing agents, applies by ${formatTime(view.endsAt)}`
    : `Updating${view.targetVersion ? ` to ${view.targetVersion}` : ''}`;
  if (view.paused.length === 0) return head;
  return `${head} · Paused for update: ${pausedNames(view.paused)}`;
}
