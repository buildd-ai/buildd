import { OPEN_TASK_STATUSES } from '@buildd/shared';
import type { LoopConfig, LoopState } from '@buildd/shared';

/** Non-terminal task statuses — still counted as "remaining work" for a mission. */
export const NON_TERMINAL_STATUSES = new Set<string>(OPEN_TASK_STATUSES);

/** Bounded default resume window for a wait with no known resolve time (e.g. a loop in backoff). */
const DEFAULT_WAIT_MS = 30 * 60 * 1000;

/**
 * How long a queued reviewer/retry attempt with no worker still counts as
 * "about to start". Filing it wakes the runners, and an idle one claims it in
 * seconds; the runner's fallback poll is only a backstop. Past this, nothing
 * is about to pick it up — a claim gate refused it — and it must read as
 * stalled, not as a wait that resolves itself.
 */
export const QUEUED_ATTEMPT_GRACE_MS = 15 * 60 * 1000;

export interface WaitClassifiableTask {
  status: string;
  mode: string | null;
  taskClass: 'work' | 'attempt' | 'bookkeeping';
  context: Record<string, unknown> | null;
  startAt: Date | null;
  loopConfig: LoopConfig | null;
  loopState: LoopState | null;
  /** Bounds the queued-attempt wait. Every loader passes it; absent, the wait is unbounded (legacy). */
  createdAt?: Date | null;
}

export interface MissionWaitResult {
  reason: string;
  waitUntil: Date;
}

/**
 * Classify a single non-terminal task as a known self-resolving wait, or null
 * when it needs real attention (active work, or an unrecognised state — the
 * safe default is to fall through to planning, never to suppress it).
 */
export function classifySingleTaskWait(t: WaitClassifiableTask, now: Date): MissionWaitResult | null {
  // Provider budget/rate-limit pause: the worker-terminal path (workers/[id]/route.ts)
  // stamps context.budgetExhausted + startAt = the reset time when it requeues a
  // budget-limited task. Once startAt has passed, the pause has lifted — even if
  // the stale flag is still on context — so this must not report "still waiting" forever.
  if (t.context?.budgetExhausted === true && t.startAt && t.startAt > now) {
    return { reason: 'provider budget/rate-limit pause', waitUntil: t.startAt };
  }

  // Infra-retry backoff: an infrastructure failure (a cloud container that died
  // under the runner, a crash-reconciled runner restart, a stale worker) is
  // requeued on the infraRetryCount budget with startAt = now + backoff (the
  // worker PATCH route and stale-workers.ts). The platform retries it by itself
  // — the deferred-dispatch sweep wakes the runner once startAt passes — so
  // until then it is a wait with a known end, not a stall or a failure.
  if (
    t.status === 'pending' &&
    typeof t.context?.infraRetryCount === 'number' && t.context.infraRetryCount > 0 &&
    t.startAt && t.startAt > now
  ) {
    return { reason: 'infrastructure failure, automatic retry scheduled', waitUntil: t.startAt };
  }

  // Loop task inside its backoff (docs/design/loop-until-verified.md) — covers a
  // CI run in progress via the pr_checks_green exit condition, a command loop
  // still failing, etc. loopState 'running' means a worker is actively iterating
  // right now, which is real progress, not a wait.
  if (t.loopConfig && t.loopState === 'condition_unmet') {
    const waitUntil = t.startAt && t.startAt > now ? t.startAt : new Date(now.getTime() + DEFAULT_WAIT_MS);
    return { reason: 'loop task waiting on its exit condition', waitUntil };
  }

  // Reviewer / CI-retry attempt task queued but not yet claimed by a worker.
  // taskClass='attempt' already means "collapses under its parent" (schema.ts) —
  // these are exactly the review-pass / retry tasks that pile up behind a
  // capacity wall elsewhere in the mission. Only within QUEUED_ATTEMPT_GRACE_MS
  // of filing: the deadline is fixed at createdAt + grace, never rolled forward
  // from `now`, so a reviewer nobody claims stops reading as a wait.
  if (t.taskClass === 'attempt' && (t.status === 'pending' || t.status === 'assigned')) {
    if (!t.createdAt) {
      return { reason: 'reviewer/retry task queued', waitUntil: new Date(now.getTime() + DEFAULT_WAIT_MS) };
    }
    const waitUntil = new Date(new Date(t.createdAt).getTime() + QUEUED_ATTEMPT_GRACE_MS);
    return waitUntil > now ? { reason: 'reviewer/retry task queued', waitUntil } : null;
  }

  return null;
}

/**
 * Decide whether EVERY non-terminal task in a mission is sitting on a known
 * self-resolving condition. Returns null the moment any task is not
 * classifiable — this must never suppress planning on uncertainty.
 */
export function classifyMissionWait(
  allTasks: WaitClassifiableTask[],
  now: Date = new Date(),
): MissionWaitResult | null {
  const nonTerminal = allTasks.filter(t => NON_TERMINAL_STATUSES.has(t.status) && t.mode !== 'planning');
  if (nonTerminal.length === 0) return null;

  const reasons = new Set<string>();
  let waitUntil: Date | null = null;

  for (const t of nonTerminal) {
    const classified = classifySingleTaskWait(t, now);
    if (!classified) return null;
    reasons.add(classified.reason);
    if (!waitUntil || classified.waitUntil < waitUntil) waitUntil = classified.waitUntil;
  }

  return { reason: [...reasons].join('; '), waitUntil: waitUntil! };
}

