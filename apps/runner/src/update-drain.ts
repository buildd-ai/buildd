/**
 * Drain-before-restart for the self-updater (Living Spec "Runner updates in
 * minutes: pause, update, continue", R-1 to R-5).
 *
 * Why: the auto-updater used to apply only after the runner had been idle for
 * five minutes, which a busy runner never is; then it waited up to an hour for
 * running work to finish, with every free slot idle behind one long task
 * (2026-10-23: 11 of 12 slots for 48 minutes). Agents survive a restart now
 * (restart-resume.ts, R-37), so an update pauses them instead of waiting.
 *
 * How:
 *  - The moment an update is eligible (available, auto-update not disabled,
 *    not already updating, target not skipped and still within its retry
 *    budget) the runner STOPS CLAIMING. Both claim paths (poll and Pusher)
 *    consult `claimsHaltedForUpdate()`.
 *  - Idle at that moment → apply immediately (reason `idle`).
 *  - Busy → a short window opens (10 minutes). At its start the caller decides
 *    per running agent with `planDrain`: one whose task estimate says it
 *    finishes inside the window may finish; every other one (and one with no
 *    estimate) is paused now, at its next safe point, the way a person's pause
 *    works. As soon as none is running the update applies (reason `drained`).
 *  - The window ends with an agent still running → apply anyway (reason
 *    `timeout`). Nothing is killed: the caller pauses what is still running
 *    within the stop grace, commits its worktree as a checkpoint and pushes
 *    every paused agent's branch before the restart; after it the agents
 *    continue in their own sessions.
 *  - Eligibility lost mid-drain (auto-update switched off, the target got
 *    skipped, a canary rollback took over, the update is no longer
 *    advertised) → the drain is cancelled and claiming resumes.
 *
 * What counts as "busy": only `working` and `stale` workers. A worker parked
 * in `waiting` (a question, or a pause) survives a restart as-is.
 *
 * Boot hold: a runner that just started does not know yet whether an update
 * is waiting (the version arrives with the first heartbeat). Until it does, or
 * for at most `bootHoldMs`, it claims nothing, so it never starts work on the
 * old build only to open a drain for it a minute later.
 *
 * Kill switch: `BUILDD_DISABLE_AUTO_UPDATE` (manual mode) makes nothing
 * eligible, so no drain opens and no auto-restart happens; manual
 * `/api/update` is unchanged. `BUILDD_UPDATE_DRAIN_WINDOW_MIN` sets the window
 * (default 10), `BUILDD_UPDATE_BOOT_HOLD_SEC` the boot hold (default 90, 0 off).
 *
 * The post-update canary is untouched by this: it detects an update at boot by
 * comparing against the commit the previous boot persisted, so however the
 * restart was reached, the previous SHA is recorded the same way.
 */

export const DEFAULT_DRAIN_WINDOW_MIN = 10;
export const DEFAULT_BOOT_HOLD_SEC = 90;

export interface DrainConfig {
  windowMs: number;
  /** How long a fresh start claims nothing while it learns whether an update waits. 0 = off. */
  bootHoldMs?: number;
}

export function readDrainConfig(env: Record<string, string | undefined> = process.env): DrainConfig {
  const raw = Number((env.BUILDD_UPDATE_DRAIN_WINDOW_MIN ?? '').trim());
  const min = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DRAIN_WINDOW_MIN;
  const holdRaw = (env.BUILDD_UPDATE_BOOT_HOLD_SEC ?? '').trim();
  const hold = holdRaw === '' ? NaN : Number(holdRaw);
  const holdSec = Number.isFinite(hold) && hold >= 0 ? hold : DEFAULT_BOOT_HOLD_SEC;
  return { windowMs: min * 60_000, bootHoldMs: holdSec * 1000 };
}

export type DrainEndReason = 'idle' | 'drained' | 'timeout';

export type DrainDecision =
  | { action: 'none' }
  /** `started`: this tick opened the window; the caller plans the agents now (planDrain). */
  | { action: 'wait'; started?: true }
  | { action: 'apply'; reason: DrainEndReason; inFlight: number; waitedMs: number };

export interface DrainTickInput {
  /** An update is available AND auto-update would be allowed to apply it now, ignoring idleness. */
  eligible: boolean;
  /** Workers still running (`working` / `stale`). */
  busy: number;
  now: number;
}

// ── which agents finish, which pause ────────────────────────────────────────

export interface DrainAgent {
  workerId: string;
  /** When its session started (epoch ms). */
  startedAt?: number | null;
  /** Its task's estimate in minutes (the p50 the Queue and mission page show); null without one. */
  estimateMinutes?: number | null;
}

export interface DrainPlan {
  /** Agents whose remaining time fits in the window: they finish before the update applies. */
  finish: string[];
  /** Everything else: paused now, at the next safe point. */
  pause: string[];
  /** Per agent, in words, for the log. */
  why: Record<string, string>;
}

/**
 * R-2: remaining = estimate minus elapsed. Fits in the window → finish. No
 * estimate, no start time, or already past its estimate (nothing says when it
 * ends) → pause.
 */
export function planDrain(agents: readonly DrainAgent[], now: number, windowMs: number): DrainPlan {
  const plan: DrainPlan = { finish: [], pause: [], why: {} };
  for (const a of agents) {
    const est = typeof a.estimateMinutes === 'number' && Number.isFinite(a.estimateMinutes) && a.estimateMinutes > 0 ? a.estimateMinutes : null;
    if (est === null || typeof a.startedAt !== 'number') {
      plan.pause.push(a.workerId);
      plan.why[a.workerId] = est === null ? 'no estimate' : 'no start time';
      continue;
    }
    const remaining = est * 60_000 - Math.max(0, now - a.startedAt);
    if (remaining > 0 && remaining <= windowMs) {
      plan.finish.push(a.workerId);
      plan.why[a.workerId] = `${fmt(remaining)} left by its estimate`;
    } else {
      plan.pause.push(a.workerId);
      plan.why[a.workerId] = remaining <= 0 ? 'past its estimate' : `${fmt(remaining)} left by its estimate`;
    }
  }
  return plan;
}

// ── what the heartbeat reports ──────────────────────────────────────────────

/** An agent paused so the update can apply (epoch ms). */
export interface PausedForUpdateReport {
  workerId: string;
  taskId: string | null;
  title: string | null;
  since: number | null;
}

export interface DrainSnapshot {
  since: number;
  /** The window's end; once applying, the moment the update applied. */
  endsAt: number;
  busy: number;
  phase: 'draining' | 'updating';
  targetVersion: string | null;
  paused: PausedForUpdateReport[];
}

/**
 * After the restart: the new version reports `updating` while the agents
 * paused for it have not continued yet (R-5), so no reader counts their slots
 * as free in between. Null when none is left.
 */
export function resumingSnapshot(paused: PausedForUpdateReport[], now: number, targetVersion: string | null): DrainSnapshot | null {
  if (paused.length === 0) return null;
  const sinces = paused.map(p => p.since).filter((s): s is number => typeof s === 'number');
  return { since: sinces.length ? Math.min(...sinces) : now, endsAt: now, busy: 0, phase: 'updating', targetVersion, paused };
}

type Phase = 'idle' | 'draining' | 'applying';

type Logger = Pick<Console, 'log' | 'warn'>;

export class UpdateDrain {
  private phase: Phase = 'idle';
  private startedAt: number | null = null;
  private appliedAt: number | null = null;
  private lastBusy = 0;
  private bootHoldUntil: number | null = null;

  constructor(readonly config: DrainConfig = readDrainConfig(), private readonly logger: Logger = console) {}

  /** True from the moment an update is eligible until it restarts or is abandoned, and during the boot hold. */
  claimsHalted(now: number = Date.now()): boolean {
    return this.phase !== 'idle' || this.bootHoldActive(now);
  }

  /** A fresh start claims nothing until it knows whether an update waits (releaseBootHold), or for `ms`. */
  holdForBoot(now: number, ms: number = this.config.bootHoldMs ?? DEFAULT_BOOT_HOLD_SEC * 1000): void {
    if (!(ms > 0)) return;
    this.bootHoldUntil = now + ms;
    this.logger.log(`[update-drain] boot hold: no claims for up to ${fmt(ms)} while this start learns whether an update is waiting`);
  }

  releaseBootHold(reason: string): void {
    if (this.bootHoldUntil === null) return;
    this.bootHoldUntil = null;
    this.logger.log(`[update-drain] boot hold released: ${reason}`);
  }

  private bootHoldActive(now: number): boolean {
    if (this.bootHoldUntil === null) return false;
    if (now < this.bootHoldUntil) return true;
    this.bootHoldUntil = null;
    this.logger.warn('[update-drain] boot hold expired before the version was known: claiming normally');
    return false;
  }

  isDraining(): boolean {
    return this.phase === 'draining';
  }

  isApplying(): boolean {
    return this.phase === 'applying';
  }

  drainStartedAt(): number | null {
    return this.startedAt;
  }

  /**
   * What the heartbeat reports so list_runners, Health and Home say the runner
   * is updating, not free (R-5). Null while idle.
   */
  snapshot(extra: { targetVersion?: string | null; paused?: PausedForUpdateReport[] } = {}): DrainSnapshot | null {
    const common = { busy: this.lastBusy, targetVersion: extra.targetVersion ?? null, paused: extra.paused ?? [] };
    if (this.phase === 'draining' && this.startedAt !== null) {
      return { since: this.startedAt, endsAt: this.startedAt + this.config.windowMs, phase: 'draining', ...common };
    }
    if (this.phase === 'applying' && this.appliedAt !== null) {
      return { since: this.startedAt ?? this.appliedAt, endsAt: this.appliedAt, phase: 'updating', ...common };
    }
    return null;
  }

  /** One auto-update tick. Pure apart from logging and the phase it keeps. */
  tick(input: DrainTickInput): DrainDecision {
    // While an apply is in flight the updater owns the runner; the caller
    // reports the outcome via `applyFailed` (or never returns, on restart).
    if (this.phase === 'applying') return { action: 'none' };
    this.lastBusy = input.busy;

    if (!input.eligible) {
      if (this.phase === 'draining') {
        this.logger.log(`[update-drain] drain cancelled after ${fmt(input.now - (this.startedAt ?? input.now))}: update no longer eligible — resuming claims`);
        this.reset();
      }
      return { action: 'none' };
    }

    if (this.phase === 'idle') {
      if (input.busy === 0) {
        this.toApplying(input.now);
        this.logger.log('[update-drain] update available and runner idle — claims halted, applying now');
        return { action: 'apply', reason: 'idle', inFlight: 0, waitedMs: 0 };
      }
      this.phase = 'draining';
      this.startedAt = input.now;
      this.logger.log(
        `[update-drain] drain started: update available, ${input.busy} worker(s) running — claims halted; ` +
        `agents that finish inside ${fmt(this.config.windowMs)} by their estimate finish, the rest pause now`,
      );
      return { action: 'wait', started: true };
    }

    // phase === 'draining'
    const waitedMs = input.now - (this.startedAt ?? input.now);
    if (input.busy === 0) {
      this.toApplying(input.now);
      this.logger.log(`[update-drain] drain ended: every agent finished or paused after ${fmt(waitedMs)}`);
      return { action: 'apply', reason: 'drained', inFlight: 0, waitedMs };
    }
    if (waitedMs >= this.config.windowMs) {
      this.toApplying(input.now);
      this.logger.warn(
        `[update-drain] drain ended: timeout — ${input.busy} worker(s) still running after ${fmt(waitedMs)}; ` +
        'they are paused within the stop grace (a checkpoint commit for any mid-tool), never killed, and continue in their own sessions after the update',
      );
      return { action: 'apply', reason: 'timeout', inFlight: input.busy, waitedMs };
    }
    return { action: 'wait' };
  }

  /** The apply did not end in a restart (refused, no progress, failed health, threw). Resume claiming. */
  applyFailed(detail: string): void {
    if (this.phase === 'idle') return;
    this.logger.warn(`[update-drain] update did not restart the runner (${detail}) — resuming claims`);
    this.reset();
  }

  private toApplying(now: number): void {
    this.phase = 'applying';
    this.appliedAt = now;
  }

  private reset(): void {
    this.phase = 'idle';
    this.startedAt = null;
    this.appliedAt = null;
    this.lastBusy = 0;
  }
}

function fmt(ms: number): string {
  const min = ms / 60_000;
  if (min >= 90) return `${Math.round(min / 60)}h`;
  return min >= 1 ? `${Math.round(min)}min` : `${Math.round(ms / 1000)}s`;
}

let instance: UpdateDrain | null = null;

export function initUpdateDrain(config?: DrainConfig, logger?: Logger): UpdateDrain {
  instance = new UpdateDrain(config, logger);
  return instance;
}

export function getUpdateDrain(): UpdateDrain | null { return instance; }

/** Claim gate for workers.ts — false when no drain has been initialised (tests, CLI tools). */
export function claimsHaltedForUpdate(): boolean {
  return instance?.claimsHalted() ?? false;
}
