/**
 * Parked-holder TTL for path-overlap blocking. Pure — no DB import, so the
 * claim route can use it without every route test having to mock it.
 *
 * A worker parked on a question (`waiting_input`) keeps its path claims and
 * its open PR's manifest. That is right for a while: its worktree still holds
 * edits, and a sibling that edits the same files would conflict with them on
 * resume. It is wrong for hours: a question can sit unanswered long enough
 * that every task overlapping the parked holder's files stays pending, and the
 * fleet idles with a full queue. The waiting-input sweep only reclaims the
 * worker itself after 4h (mission tasks) or 24h (standalone) —
 * `cleanupStuckWaitingInput` in apps/web/src/lib/stale-workers.ts.
 *
 * So past this TTL a parked holder stops deferring others. Its claims are not
 * released — nothing is written — it just no longer counts at the three read
 * sites (claim route layers 1 and 2, `check_path_claim`). If the question is
 * later answered and the files did move underneath it, the normal
 * conflict-retry path handles the rebase; that is cheaper than idling.
 *
 * The clock is `workers.updatedAt`, the same one the waiting-input sweep uses,
 * so "parked for 2h" here and "parked for 4h" there are measured alike.
 */

/** How long a `waiting_input` holder may block overlapping tasks. */
export const PARKED_HOLDER_TTL_MS = 2 * 60 * 60 * 1000;

export interface HolderClock {
  status: string;
  updatedAt: Date | string | null | undefined;
}

/**
 * True when this worker is parked on a question and has been for longer than
 * the TTL. Any other status, and a missing or unparseable clock, is not
 * expired — the default is to keep blocking.
 */
export function isExpiredParkedHolder(
  w: HolderClock,
  now: number = Date.now(),
  ttlMs: number = PARKED_HOLDER_TTL_MS,
): boolean {
  if (w.status !== 'waiting_input' || w.updatedAt == null) return false;
  const t = w.updatedAt instanceof Date ? w.updatedAt.getTime() : Date.parse(w.updatedAt);
  if (!Number.isFinite(t)) return false;
  return now - t > ttlMs;
}

/**
 * Given the LIVE workers (idle/running/starting/waiting_input) of some tasks,
 * the ids of tasks whose every live worker is an expired parked holder. One
 * fresh worker on a task keeps all of that task's claims in force.
 */
export function expiredParkedTaskIds(
  liveWorkers: Array<HolderClock & { taskId: string | null }>,
  now: number = Date.now(),
  ttlMs: number = PARKED_HOLDER_TTL_MS,
): Set<string> {
  const verdict = new Map<string, boolean>();
  for (const w of liveWorkers) {
    if (!w.taskId) continue;
    const expired = isExpiredParkedHolder(w, now, ttlMs);
    verdict.set(w.taskId, (verdict.get(w.taskId) ?? true) && expired);
  }
  return new Set([...verdict].filter(([, expired]) => expired).map(([id]) => id));
}
