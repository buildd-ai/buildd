/**
 * Rate-limiting and event-filtering policy for the layout-wide realtime
 * consumers (EscalationProvider, NeedsInputProvider, HomeAutoRefresh).
 *
 * The runner PATCHes every active worker roughly every 10s, and each PATCH
 * publishes `worker:progress` on the workspace channel. Reacting to every one of
 * those means N workers → N inbox fetches / Home renders per 10s per open tab
 * (and Neon never gets to sleep). The rule everywhere below: a steady-status
 * heartbeat is not news; a status *change* is, and even then the work is
 * throttled to a small constant rate per tab.
 *
 * Kept free of React and Pusher so the policy is testable with a fake clock.
 */

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface Throttle {
  /**
   * Request an invocation. `maxDelayMs` caps how long this particular request
   * may wait — used to flush urgent transitions quickly without lifting the
   * rate limit for everything else.
   */
  call(opts?: { maxDelayMs?: number }): void;
  /** Drop any pending trailing invocation. */
  cancel(): void;
}

export interface ThrottleOptions {
  /** Trailing delay after the latest call, and the minimum gap for a leading call. */
  waitMs: number;
  /** Upper bound on how long a pending call may be deferred. Defaults to `waitMs` (i.e. a throttle). */
  maxWaitMs?: number;
  /** Invoke immediately when idle. Default true. */
  leading?: boolean;
}

/**
 * Trailing throttle with a leading call and max-wait.
 *
 * - Idle (no pending call, last invocation ≥ waitMs ago) + leading → fire now.
 * - Otherwise one trailing invocation is scheduled `waitMs` after the latest
 *   call, but never later than `maxWaitMs` after the first un-served call.
 *
 * With the default `maxWaitMs = waitMs` this is a throttle (≤1 call per
 * interval under a steady stream); with `leading: false` and a larger
 * `maxWaitMs` it is a debounce that cannot be starved.
 */
export function createThrottle(
  fn: () => void,
  opts: ThrottleOptions,
  clock: Clock = realClock,
): Throttle {
  const { waitMs, maxWaitMs = waitMs, leading = true } = opts;
  let timer: unknown = null;
  let lastInvokeAt = -Infinity;
  let pendingSince: number | null = null;
  let urgentDeadline = Infinity;

  function clearTimer() {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  }

  function invoke() {
    clearTimer();
    pendingSince = null;
    urgentDeadline = Infinity;
    lastInvokeAt = clock.now();
    fn();
  }

  return {
    call(callOpts) {
      const now = clock.now();
      if (leading && timer === null && now - lastInvokeAt >= waitMs) {
        invoke();
        return;
      }
      if (pendingSince === null) pendingSince = now;
      if (callOpts?.maxDelayMs !== undefined) {
        urgentDeadline = Math.min(urgentDeadline, now + callOpts.maxDelayMs);
      }
      const deadline = Math.min(now + waitMs, pendingSince + maxWaitMs, urgentDeadline);
      clearTimer();
      timer = clock.setTimeout(invoke, Math.max(0, deadline - now));
    },
    cancel() {
      clearTimer();
      pendingSince = null;
      urgentDeadline = Infinity;
    },
  };
}

/** Thin worker event payload: `{workerId, taskId, status}`; webhooks send only `{taskId}`. */
export interface WorkerEventPayload {
  workerId?: string | null;
  taskId?: string | null;
  status?: string;
  worker?: { taskId?: string | null; status?: string };
}

function asPayload(data: unknown): WorkerEventPayload {
  return data && typeof data === 'object' ? (data as WorkerEventPayload) : {};
}

/**
 * Record `status` for `workerId` and report whether it changed. The first
 * sighting of a worker only records — a freshly opened tab has no baseline, and
 * the page it just loaded already reflects that state.
 */
function statusChanged(lastStatusByWorker: Map<string, string>, workerId: string, status: string): boolean {
  const prev = lastStatusByWorker.get(workerId);
  lastStatusByWorker.set(workerId, status);
  return prev !== undefined && prev !== status;
}

// ── Escalation inbox ────────────────────────────────────────────────────────

export const ESCALATION_THROTTLE_MS = 15_000;
export const ESCALATION_COMPLETED_DEBOUNCE_MS = 2_000;

export interface EscalationRefresher {
  onEvent(event: string, data: unknown): void;
  /** Call when the tab becomes visible: one catch-up fetch if anything was missed. */
  onVisible(): void;
  dispose(): void;
}

/**
 * Decides when the nav badge refetches `/api/prs/escalation-inbox` (several
 * cross-workspace queries per call):
 *   - `mission:note_posted` → fetch now, throttled to one per 15s;
 *   - `worker:completed` → 2s trailing debounce, then the same throttle;
 *   - `worker:progress` → only when that worker's status changed;
 *   - hidden tab → nothing; one catch-up fetch on return to visible.
 */
export function createEscalationRefresher(deps: {
  fetch: () => void;
  isHidden: () => boolean;
  clock?: Clock;
}): EscalationRefresher {
  const clock = deps.clock ?? realClock;
  const lastStatusByWorker = new Map<string, string>();
  let missedWhileHidden = false;

  const throttled = createThrottle(() => {
    // A trailing call can come due after the tab was hidden.
    if (deps.isHidden()) {
      missedWhileHidden = true;
      return;
    }
    deps.fetch();
  }, { waitMs: ESCALATION_THROTTLE_MS }, clock);

  const completedDebounce = createThrottle(
    () => throttled.call(),
    { waitMs: ESCALATION_COMPLETED_DEBOUNCE_MS, maxWaitMs: ESCALATION_COMPLETED_DEBOUNCE_MS * 5, leading: false },
    clock,
  );

  return {
    onEvent(event, data) {
      const payload = asPayload(data);
      let relevant: boolean;
      if (event === 'worker:progress') {
        relevant = !!payload.workerId && !!payload.status
          && statusChanged(lastStatusByWorker, payload.workerId, payload.status);
      } else {
        if (event === 'worker:completed' && payload.workerId) lastStatusByWorker.delete(payload.workerId);
        relevant = true;
      }
      if (!relevant) return;

      if (deps.isHidden()) {
        missedWhileHidden = true;
        return;
      }
      if (event === 'worker:completed') completedDebounce.call();
      else throttled.call();
    },
    onVisible() {
      if (!missedWhileHidden || deps.isHidden()) return;
      missedWhileHidden = false;
      deps.fetch();
    },
    dispose() {
      throttled.cancel();
      completedDebounce.cancel();
    },
  };
}

// ── Home ────────────────────────────────────────────────────────────────────

/** Home re-renders at most this often for ordinary status churn. */
export const HOME_THROTTLE_MS = 12_000;
/** Terminal and waiting_input transitions flush within this. */
export const HOME_URGENT_MS = 500;

const URGENT_WORKER_STATUSES = new Set(['waiting_input', 'completed', 'failed']);

export type HomeRefreshDecision = 'none' | 'throttled' | 'urgent';

/**
 * Whether a workspace event should re-render Home (a full force-dynamic render).
 *
 * - Non-progress events (task lifecycle, worker completed/failed) refresh as
 *   they always have: urgently.
 * - `worker:progress` without a workerId is a webhook / merge / PR-refresh
 *   nudge — always refresh, it's what keeps Merge cards live (#1899).
 * - `worker:progress` with a workerId refreshes only on a status change; the
 *   first sighting just records the baseline.
 */
export function shouldRefreshHomeOnEvent(
  event: string,
  data: unknown,
  lastStatusByWorker: Map<string, string>,
): HomeRefreshDecision {
  const payload = asPayload(data);

  if (event !== 'worker:progress') {
    if ((event === 'worker:completed' || event === 'worker:failed') && payload.workerId) {
      lastStatusByWorker.delete(payload.workerId);
    }
    return 'urgent';
  }

  if (!payload.workerId) return 'throttled';
  if (!payload.status) return 'none';
  if (!statusChanged(lastStatusByWorker, payload.workerId, payload.status)) return 'none';
  return URGENT_WORKER_STATUSES.has(payload.status) ? 'urgent' : 'throttled';
}

// ── Needs-input list ────────────────────────────────────────────────────────

export type NeedsInputAction =
  | { kind: 'none' }
  | { kind: 'refetch' }
  | { kind: 'remove'; taskId: string };

/**
 * How the needs-input list reacts to a worker event. A task leaves the list
 * only on positive evidence that it stopped waiting — a status other than
 * waiting_input, or the worker finishing. CI / merge / PR-refresh webhooks
 * publish status-less `{taskId}` progress; treating those as "no longer
 * waiting" dropped the task and re-toasted it on the next fetch.
 */
export function needsInputEventAction(
  event: string,
  data: unknown,
  knownTaskIds: ReadonlySet<string>,
): NeedsInputAction {
  const payload = asPayload(data);
  const taskId = payload.taskId ?? payload.worker?.taskId;
  const status = payload.status ?? payload.worker?.status;
  if (!taskId) return { kind: 'none' };

  if (event === 'worker:completed' || event === 'worker:failed') {
    return knownTaskIds.has(taskId) ? { kind: 'remove', taskId } : { kind: 'none' };
  }
  if (!status) return { kind: 'none' };
  if (status === 'waiting_input') {
    return knownTaskIds.has(taskId) ? { kind: 'none' } : { kind: 'refetch' };
  }
  return knownTaskIds.has(taskId) ? { kind: 'remove', taskId } : { kind: 'none' };
}

/** Pusher `state_change` → true when the connection came back after a drop. */
export function createReconnectDetector(): (states: { previous: string; current: string }) => boolean {
  let dropped = false;
  return ({ previous, current }) => {
    if (current === 'connected') {
      const wasDropped = dropped;
      dropped = false;
      return wasDropped;
    }
    if (previous === 'connected') dropped = true;
    return false;
  };
}
