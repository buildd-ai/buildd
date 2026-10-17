/**
 * Pausing a running agent (task baf3809a).
 *
 * A pause is a question the person asked themselves: the runner stops the
 * session at a safe point, keeps the worktree and the session id, and reports
 * `waiting_input` with `waitingFor.type = 'pause'`. Everything a parked
 * question already has then applies unchanged: the answer path resumes the SAME
 * session (`sendMessage` → `resumeSession`, by session id, in the same
 * worktree), a cloud `--once` run with resumable runs on parks its bundle and
 * lets the container go, and the existing waiting_input timeouts bound it.
 *
 * The safe point is "no tool is executing": stopping mid tool call would leave
 * a half-run command behind and a tool_use with no result in the transcript.
 * A pause requested during a tool waits for it to finish.
 *
 * Pure decisions here; WorkerManager does the I/O.
 */
import type { WaitingFor, WorkerStatus } from './types';

/**
 * What a runner can do with a pause:
 * - `session`: a long-lived host runner. The session ends, the worktree and
 *   session id stay on disk, and the answer resumes it here.
 * - `park`: a cloud `--once` run with resumable runs on (BUILDD_ONCE_PARK=1 and
 *   a snapshot store). The existing park uploads the bundle and the container goes.
 * - `none`: a `--once` run without parking. Stopping the session would only
 *   hold the container until its max wait and then fail the run, so it refuses.
 */
export type PauseMode = 'session' | 'park' | 'none';

/** Prefix of `worker.error` while a pause is being applied, like `needs_input:` for a question. */
export const PAUSED_ERROR_PREFIX = 'paused:';
/** The full `worker.error` while paused: the prefix, then a sentence a person can read. */
export const PAUSED_ERROR = `${PAUSED_ERROR_PREFIX} paused by a person; Resume continues the same session`;

export const PAUSE_UNAVAILABLE_MESSAGE =
  "Pause isn't available on this runner (resumable runs are off), so the agent keeps running. Stop it, or let it finish.";

export const PAUSE_UNAVAILABLE_CODEX_MESSAGE =
  "Pause isn't available for a Codex run on a cloud runner yet (its session can't be saved with the run), so the agent keeps running. Stop it, or let it finish.";

export const PAUSED_PROMPT =
  'Paused. Resume to continue the same session where it stopped. The first turn after a long pause costs more, because the prompt cache has expired.';

export function pauseModeFor(opts: { singleTask?: boolean; parkingEnabled?: boolean }): PauseMode {
  if (!opts.singleTask) return 'session';
  return opts.parkingEnabled ? 'park' : 'none';
}

export type PauseDecision =
  | { action: 'apply' }
  | { action: 'defer' }
  | { action: 'refuse'; reason: 'unavailable' | 'unavailable_backend' | 'not_running' | 'no_session' | 'already_paused' };

/** Whether a pause can happen now, must wait for the running tool, or is refused. */
export function decidePause(input: {
  mode: PauseMode;
  status: WorkerStatus;
  hasLiveSession: boolean;
  toolInFlight: boolean;
  waitingFor?: Pick<WaitingFor, 'type'> | null;
  /** The backend the session runs on. A park bundle carries Claude transcripts only. */
  backend?: 'claude' | 'codex';
}): PauseDecision {
  if (input.status === 'waiting' && input.waitingFor?.type === 'pause') return { action: 'refuse', reason: 'already_paused' };
  if (input.mode === 'none') return { action: 'refuse', reason: 'unavailable' };
  if (input.mode === 'park' && input.backend === 'codex') return { action: 'refuse', reason: 'unavailable_backend' };
  if (input.status !== 'working' && input.status !== 'stale') return { action: 'refuse', reason: 'not_running' };
  if (!input.hasLiveSession) return { action: 'refuse', reason: 'no_session' };
  return input.toolInFlight ? { action: 'defer' } : { action: 'apply' };
}

/**
 * Who paused it: a person (`p` in top, Pause on the dashboard, `buildd stop`),
 * or the runner itself when its service stopped or restarted (R-37), or when
 * it came back from a crash with the run's worktree and session intact.
 */
export type PauseCause = 'person' | 'shutdown' | 'crash';

const PAUSE_CONTEXT: Record<PauseCause, string> = {
  person: 'You paused this run. Its worktree, uncommitted work and session are kept.',
  shutdown: 'The runner stopped or restarted, so it paused this run. Its worktree, uncommitted work and session are kept.',
  crash: 'The runner stopped without warning while this run was going. Its worktree and session were still there, so it is paused, not failed.',
};

export function pausedWaitingFor(cause: PauseCause = 'person', now: number = Date.now()): WaitingFor {
  return {
    type: 'pause',
    prompt: PAUSED_PROMPT,
    since: new Date(now).toISOString(),
    context: PAUSE_CONTEXT[cause],
    options: [{ label: 'Resume', recommended: true, consequence: 'The agent picks up in the same session, with everything it had worked out.' }],
  };
}

/**
 * True for a session that ended because the agent was parked on purpose (a
 * question or a pause), not because it crashed. Both are reported as
 * `waiting_input`, never as a failure.
 */
export function isParkedAbortError(error: string | undefined | null): boolean {
  return !!error && (error.startsWith('needs_input') || error.startsWith(PAUSED_ERROR_PREFIX));
}

/**
 * A paused worker holds no runner slot: it is excluded from the busy count the
 * heartbeat reports. Nor does a question whose session ended (the default
 * inputAsRetry park): nothing runs until the answer resumes it, and the claim
 * loop already leaves it out of `busySlotCount`. Only a question asked inside a
 * live session holds one.
 */
export function holdsRunnerSlot(
  worker: { status: WorkerStatus; waitingFor?: Pick<WaitingFor, 'type'> | null },
  hasLiveSession = true,
): boolean {
  if (worker.status === 'working') return true;
  if (worker.status === 'waiting') return hasLiveSession && worker.waitingFor?.type !== 'pause';
  return false;
}
