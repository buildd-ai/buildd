/**
 * Heartbeat health and the watchdog that restarts a runner whose heartbeat died.
 *
 * Incident (2026-11-22): a runner stopped heartbeating while the process stayed
 * up. Its local API answered and it had no busy workers, but the server showed it
 * offline, so it never took the next update. Nothing was logged. Two gaps let
 * that happen:
 *
 *  1. `WorkerManager.sendHeartbeat` swallowed every failure in a bare `catch {}`,
 *     so a beat that kept failing left no line in the log.
 *  2. Nothing checked that beats kept landing. The "runner alive" log line
 *     (index.ts) counts a connected Pusher socket as contact, so it kept printing
 *     while the server saw no beat.
 *
 * `HeartbeatTracker` records every tick, attempt, success and failure, and
 * returns the line to log for failures (rate limited) and for recovery.
 * `HeartbeatWatchdog` reads it once a minute and decides whether to restart:
 *
 *  - the liveness timer stopped firing (the loop is dead): restart;
 *  - a beat has been in flight far past the fetch timeout (a hung request): restart;
 *  - no beat has landed for `staleMs`, and the last failure was a transport fault
 *    (timeout, network error) or there was no failure at all: restart. A
 *    process restart gets fresh sockets, timers and Pusher state;
 *  - no beat has landed but the server is answering with an HTTP error (401, 5xx):
 *    log an error and do not restart. A restart cannot fix a refusal, and a
 *    server outage would otherwise restart every runner in the fleet in a loop.
 *
 * A gap in the watchdog's own checks means the whole process was suspended
 * (laptop sleep, VM pause). The watchdog resets its baseline then and does not
 * restart because of time that passed while the process was not running.
 */
import { LIVENESS_PING_INTERVAL_MS, RUNNER_FALLBACK_PING_MS } from '@buildd/shared';
import { isServerRefusal } from './server-refusal';

function envMs(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * No landed beat for this long trips the watchdog. A healthy presence-connected
 * idle runner beats at least every RUNNER_FALLBACK_PING_MS (15m), so this
 * allows two missed fallback pings. Override with BUILDD_HEARTBEAT_WATCHDOG_MS.
 */
export const HEARTBEAT_STALE_MS = envMs('BUILDD_HEARTBEAT_WATCHDOG_MS', 3 * RUNNER_FALLBACK_PING_MS);

/** The 60s liveness timer has not fired for this long, so the loop is dead. */
export const HEARTBEAT_TICK_STALL_MS = 5 * LIVENESS_PING_INTERVAL_MS;

/** A single beat still in flight after this long is hung (the fetch timeout is 30s). */
export const HEARTBEAT_HANG_MS = 5 * 60_000;

/** How often a continuing failure streak is logged again after its first line. */
export const HEARTBEAT_FAILURE_LOG_EVERY_MS = 10 * 60_000;

/** How often the watchdog checks. */
export const HEARTBEAT_WATCHDOG_INTERVAL_MS = 60_000;

export type HeartbeatFailureKind = 'refused' | 'transport';

export interface HeartbeatHealth {
  /** False until the heartbeat loop has started (serverless runners never start it). */
  armed: boolean;
  /** When monitoring started or was last reset (arm, or resume after a suspend). */
  baselineAt: number;
  lastTickAt: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastFailureKind: HeartbeatFailureKind | null;
  lastFailureDetail: string | null;
  consecutiveFailures: number;
  /** Start time of the oldest beat still in flight. */
  oldestInFlightAt: number | null;
}

export function describeHeartbeatError(err: unknown): { kind: HeartbeatFailureKind; detail: string } {
  if (isServerRefusal(err)) return { kind: 'refused', detail: `HTTP ${err.status}${err.message ? `: ${err.message}` : ''}`.slice(0, 300) };
  const e = err as { name?: string; message?: string } | null;
  const detail = e && typeof e === 'object'
    ? [e.name, e.message].filter(Boolean).join(': ') || String(err)
    : String(err);
  return { kind: 'transport', detail: detail.slice(0, 300) };
}

function ago(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

export class HeartbeatTracker {
  private armed = false;
  private baselineAt: number;
  private lastTickAt: number | null = null;
  private lastSuccessAt: number | null = null;
  private lastFailureAt: number | null = null;
  private lastFailureKind: HeartbeatFailureKind | null = null;
  private lastFailureDetail: string | null = null;
  private consecutiveFailures = 0;
  private failureStreakStartedAt: number | null = null;
  private lastFailureLoggedAt: number | null = null;
  private inFlight = new Map<number, number>();
  private nextToken = 1;

  constructor(now: number = Date.now()) {
    this.baselineAt = now;
  }

  /** The heartbeat loop started: the watchdog may judge it from now on. */
  arm(now: number = Date.now()): void {
    this.armed = true;
    this.baselineAt = now;
    this.lastTickAt = now;
  }

  /** The process was suspended: measure staleness from now, not from before. */
  resetBaseline(now: number = Date.now()): void {
    this.baselineAt = now;
    if (this.lastTickAt !== null) this.lastTickAt = now;
    for (const token of this.inFlight.keys()) this.inFlight.set(token, now);
  }

  /** The liveness timer fired. */
  noteTick(now: number = Date.now()): void {
    this.lastTickAt = now;
  }

  /** A beat is about to be sent. Returns a token for `succeed`/`fail`. */
  begin(now: number = Date.now()): number {
    const token = this.nextToken++;
    this.inFlight.set(token, now);
    return token;
  }

  /** The beat landed. Returns a recovery line to log when it ends a failure streak. */
  succeed(token: number, now: number = Date.now()): string | null {
    this.inFlight.delete(token);
    this.lastSuccessAt = now;
    const failures = this.consecutiveFailures;
    const since = this.failureStreakStartedAt;
    this.consecutiveFailures = 0;
    this.failureStreakStartedAt = null;
    this.lastFailureLoggedAt = null;
    if (failures === 0) return null;
    return `[heartbeat] recovered after ${failures} failed beat${failures === 1 ? '' : 's'}${since !== null ? ` over ${ago(now - since)}` : ''}`;
  }

  /**
   * The beat failed. Returns the line to log: the first failure of a streak
   * always, then at most once every HEARTBEAT_FAILURE_LOG_EVERY_MS.
   */
  fail(token: number, err: unknown, now: number = Date.now()): string | null {
    this.inFlight.delete(token);
    const { kind, detail } = describeHeartbeatError(err);
    this.lastFailureAt = now;
    this.lastFailureKind = kind;
    this.lastFailureDetail = detail;
    this.consecutiveFailures++;
    if (this.failureStreakStartedAt === null) this.failureStreakStartedAt = now;
    const due = this.lastFailureLoggedAt === null || now - this.lastFailureLoggedAt >= HEARTBEAT_FAILURE_LOG_EVERY_MS;
    if (!due) return null;
    this.lastFailureLoggedAt = now;
    const last = this.lastSuccessAt !== null ? `last landed ${ago(now - this.lastSuccessAt)} ago` : 'none landed since start';
    return `[heartbeat] beat failed (${kind}: ${detail}); ${this.consecutiveFailures} in a row, ${last}`;
  }

  snapshot(): HeartbeatHealth {
    let oldest: number | null = null;
    for (const at of this.inFlight.values()) if (oldest === null || at < oldest) oldest = at;
    return {
      armed: this.armed,
      baselineAt: this.baselineAt,
      lastTickAt: this.lastTickAt,
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
      lastFailureKind: this.lastFailureKind,
      lastFailureDetail: this.lastFailureDetail,
      consecutiveFailures: this.consecutiveFailures,
      oldestInFlightAt: oldest,
    };
  }
}

export type WatchdogVerdict =
  | { kind: 'ok' }
  /** No beat landing, but the server answers: log, do not restart. */
  | { kind: 'stale-refused'; reason: string }
  | { kind: 'restart'; reason: string };

export interface WatchdogThresholds {
  staleMs?: number;
  tickStallMs?: number;
  hangMs?: number;
}

export function heartbeatWatchdogVerdict(h: HeartbeatHealth, now: number, t: WatchdogThresholds = {}): WatchdogVerdict {
  if (!h.armed) return { kind: 'ok' };
  const staleMs = t.staleMs ?? HEARTBEAT_STALE_MS;
  const tickStallMs = t.tickStallMs ?? HEARTBEAT_TICK_STALL_MS;
  const hangMs = t.hangMs ?? HEARTBEAT_HANG_MS;

  const tickAt = h.lastTickAt ?? h.baselineAt;
  if (now - tickAt > tickStallMs) {
    return { kind: 'restart', reason: `the heartbeat timer has not fired for ${ago(now - tickAt)}` };
  }
  if (h.oldestInFlightAt !== null && now - h.oldestInFlightAt > hangMs) {
    return { kind: 'restart', reason: `a heartbeat request has been in flight for ${ago(now - h.oldestInFlightAt)}` };
  }
  const since = Math.max(h.lastSuccessAt ?? 0, h.baselineAt);
  if (now - since <= staleMs) return { kind: 'ok' };
  const landed = h.lastSuccessAt !== null ? `no heartbeat has landed for ${ago(now - h.lastSuccessAt)}` : `no heartbeat has landed in ${ago(now - h.baselineAt)} since start`;
  const failure = h.lastFailureKind ? ` (${h.consecutiveFailures} failed in a row, last: ${h.lastFailureKind}: ${h.lastFailureDetail})` : ' (no beat attempted or failed)';
  if (h.lastFailureKind === 'refused') return { kind: 'stale-refused', reason: `${landed}${failure}` };
  return { kind: 'restart', reason: `${landed}${failure}` };
}

/**
 * Runs the verdict on a timer's behalf. `check` is called every
 * HEARTBEAT_WATCHDOG_INTERVAL_MS; a gap well beyond that means the process was
 * suspended, so the baseline resets instead of judging the gap.
 */
export class HeartbeatWatchdog {
  private lastCheckAt: number | null = null;
  private lastRefusedLogAt: number | null = null;

  constructor(
    private readonly opts: {
      intervalMs?: number;
      thresholds?: WatchdogThresholds;
      /** Log interval for the not-restarting `stale-refused` case. */
      refusedLogEveryMs?: number;
    } = {},
  ) {}

  /**
   * Returns what to do now: `restart` (log and exit), `log` (an error line,
   * rate limited) or nothing.
   */
  check(tracker: HeartbeatTracker, now: number = Date.now()): { action: 'restart' | 'log'; message: string } | null {
    const interval = this.opts.intervalMs ?? HEARTBEAT_WATCHDOG_INTERVAL_MS;
    const prev = this.lastCheckAt;
    this.lastCheckAt = now;
    if (prev !== null && now - prev > 3 * interval) {
      tracker.resetBaseline(now);
      this.lastRefusedLogAt = null;
      return null;
    }
    const verdict = heartbeatWatchdogVerdict(tracker.snapshot(), now, this.opts.thresholds);
    if (verdict.kind === 'ok') {
      this.lastRefusedLogAt = null;
      return null;
    }
    if (verdict.kind === 'restart') {
      return { action: 'restart', message: `[heartbeat-watchdog] ${verdict.reason}; restarting the runner` };
    }
    const every = this.opts.refusedLogEveryMs ?? HEARTBEAT_FAILURE_LOG_EVERY_MS;
    if (this.lastRefusedLogAt !== null && now - this.lastRefusedLogAt < every) return null;
    this.lastRefusedLogAt = now;
    return { action: 'log', message: `[heartbeat-watchdog] ${verdict.reason}; the server is refusing beats, so a restart would not help` };
  }
}
