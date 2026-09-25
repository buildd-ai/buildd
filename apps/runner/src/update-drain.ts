/**
 * Drain-before-restart for the self-updater.
 *
 * Why: the auto-updater used to apply only after the runner had been idle for
 * five minutes. A busy runner claims its next task before it is ever idle that
 * long, so it never applied an update at all — it kept running old code for as
 * long as there was work, which is exactly when running old code matters most.
 *
 * How:
 *  - The moment an update is eligible (available, auto-update not disabled,
 *    not already updating, target not skipped and still within its retry
 *    budget) the runner STOPS CLAIMING. Both claim paths (poll and Pusher)
 *    consult `claimsHaltedForUpdate()`.
 *  - Idle at that moment → apply immediately (reason `idle`). There is no
 *    idle-delay any more: halting claims first is what makes applying safe,
 *    since no new task can land between "idle" and the restart.
 *  - Busy → a bounded drain window opens. Running workers finish, and as soon
 *    as none are left the update applies (reason `drained`).
 *  - The window expires with work still running → apply anyway (reason
 *    `timeout`). In-flight sessions die with the process; see "Timeout" below.
 *  - Eligibility lost mid-drain (auto-update switched off, the target got
 *    skipped, a canary rollback took over, the update is no longer
 *    advertised) → the drain is cancelled and claiming resumes.
 *
 * What counts as "busy": only `working` and `stale` workers. A worker parked
 * in `waiting` (waiting on a human answer) survives a restart as-is — the
 * store keeps its status and a later answer resumes the session — so it must
 * not hold an update hostage for however long the human takes.
 *
 * Timeout: the restart kills whatever is still running. That work is not
 * silently lost — it goes through the same path every runner restart already
 * uses: the worker record is persisted as `working`, the next boot rewrites it
 * to `error` and reports it to the server as a crash reconciliation ("Process
 * restarted"), the server treats that as an infra termination (retryable, and
 * the post-update canary ignores it), and the worktree is retained for resume.
 * The drain logs every worker it is about to kill so the loss is attributable.
 *
 * Kill switch: `BUILDD_DISABLE_AUTO_UPDATE` (manual mode) makes nothing
 * eligible, so no drain opens and no auto-restart happens; manual
 * `/api/update` is unchanged. `BUILDD_UPDATE_DRAIN_WINDOW_MIN` sets the window
 * (default 60).
 *
 * The post-update canary is untouched by this: it detects an update at boot by
 * comparing against the commit the previous boot persisted, so however the
 * restart was reached, the previous SHA is recorded the same way.
 */

export const DEFAULT_DRAIN_WINDOW_MIN = 60;

export interface DrainConfig {
  windowMs: number;
}

export function readDrainConfig(env: Record<string, string | undefined> = process.env): DrainConfig {
  const raw = Number((env.BUILDD_UPDATE_DRAIN_WINDOW_MIN ?? '').trim());
  const min = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DRAIN_WINDOW_MIN;
  return { windowMs: min * 60_000 };
}

export type DrainEndReason = 'idle' | 'drained' | 'timeout';

export type DrainDecision =
  | { action: 'none' }
  | { action: 'wait' }
  | { action: 'apply'; reason: DrainEndReason; inFlight: number; waitedMs: number };

export interface DrainTickInput {
  /** An update is available AND auto-update would be allowed to apply it now, ignoring idleness. */
  eligible: boolean;
  /** Workers whose session dies on restart (`working` / `stale`). */
  busy: number;
  now: number;
}

type Phase = 'idle' | 'draining' | 'applying';

type Logger = Pick<Console, 'log' | 'warn'>;

export class UpdateDrain {
  private phase: Phase = 'idle';
  private startedAt: number | null = null;

  constructor(readonly config: DrainConfig = readDrainConfig(), private readonly logger: Logger = console) {}

  /** True from the moment an update is eligible until it restarts or is abandoned. */
  claimsHalted(): boolean {
    return this.phase !== 'idle';
  }

  isDraining(): boolean {
    return this.phase === 'draining';
  }

  drainStartedAt(): number | null {
    return this.startedAt;
  }

  /** One auto-update tick. Pure apart from logging and the phase it keeps. */
  tick(input: DrainTickInput): DrainDecision {
    // While an apply is in flight the updater owns the runner; the caller
    // reports the outcome via `applyFailed` (or never returns, on restart).
    if (this.phase === 'applying') return { action: 'none' };

    if (!input.eligible) {
      if (this.phase === 'draining') {
        this.logger.log(`[update-drain] drain cancelled after ${fmt(input.now - (this.startedAt ?? input.now))}: update no longer eligible — resuming claims`);
        this.reset();
      }
      return { action: 'none' };
    }

    if (this.phase === 'idle') {
      if (input.busy === 0) {
        this.phase = 'applying';
        this.logger.log('[update-drain] update available and runner idle — claims halted, applying now');
        return { action: 'apply', reason: 'idle', inFlight: 0, waitedMs: 0 };
      }
      this.phase = 'draining';
      this.startedAt = input.now;
      this.logger.log(
        `[update-drain] drain started: update available, ${input.busy} worker(s) running — claims halted, ` +
        `waiting up to ${fmt(this.config.windowMs)} for them to finish`,
      );
      return { action: 'wait' };
    }

    // phase === 'draining'
    const waitedMs = input.now - (this.startedAt ?? input.now);
    if (input.busy === 0) {
      this.phase = 'applying';
      this.logger.log(`[update-drain] drain ended: completed — all workers finished after ${fmt(waitedMs)}`);
      return { action: 'apply', reason: 'drained', inFlight: 0, waitedMs };
    }
    if (waitedMs >= this.config.windowMs) {
      this.phase = 'applying';
      this.logger.warn(
        `[update-drain] drain ended: timeout — ${input.busy} worker(s) still running after ${fmt(waitedMs)}; ` +
        'restarting anyway (their sessions are reported as "Process restarted" on the next boot and their worktrees are kept)',
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

  private reset(): void {
    this.phase = 'idle';
    this.startedAt = null;
  }
}

function fmt(ms: number): string {
  const min = ms / 60_000;
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
