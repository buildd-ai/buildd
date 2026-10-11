/**
 * Liveness of an open conflict-fix task (workflow-state-kernel S37): is it
 * stalled, why, and what recovery it is owed. Pure (no I/O), so
 * both the recovery path (conflict-retry.ts) and the read models (Home, the
 * kernel's DeliveryView) apply the same rule.
 */
import { TERMINAL_WORKER_STATUSES } from '@buildd/shared';

/** A pending conflict fix no runner claimed within this window is stalled (same bound CI retries use). */
export const STALE_PENDING_CONFLICT_FIX_MS = 30 * 60 * 1000;
/** A claimed conflict fix whose worker has not reported within this window is stalled. */
export const SILENT_CONFLICT_FIX_MS = 20 * 60 * 1000;
/** One recovery per remediation per window: sweeps, webhooks and repeated clicks collapse into it. */
export const CONFLICT_RECOVERY_THROTTLE_MS = 10 * 60 * 1000;

export type ConflictRecoveryAction = 'none' | 'redispatch' | 'repair';

export interface ConflictFixLiveness {
  status: string;
  createdAt: Date | string | null;
  claimedAt?: Date | string | null;
  workerStatus?: string | null;
  workerUpdatedAt?: Date | string | null;
  lastRecoveryAt?: string | null;
}

const ms = (v: Date | string | null | undefined): number | null => (v == null ? null : new Date(v).getTime());
const ENDED_WORKER = new Set<string>(TERMINAL_WORKER_STATUSES);

/**
 * Pure: is an open conflict-fix task stalled, why, and what recovery it is
 * owed. `redispatch` re-wakes a pending task; `repair` requeues a claimed
 * task whose worker already ended. A claimed task whose worker is merely
 * silent is stalled but left to the reaper (no action), so recovery never
 * races a live agent.
 */
export function classifyConflictFix(t: ConflictFixLiveness, now: number = Date.now()): { stalled: boolean; reason: string | null; action: ConflictRecoveryAction } {
  const mins = (d: number) => `${Math.max(1, Math.round(d / 60_000))}m`;
  const created = ms(t.createdAt) ?? now;
  const throttled = (() => { const at = ms(t.lastRecoveryAt ?? null); return at != null && now - at < CONFLICT_RECOVERY_THROTTLE_MS; })();
  const act = (a: ConflictRecoveryAction): ConflictRecoveryAction => (throttled ? 'none' : a);
  if (t.status === 'pending') {
    // A re-dispatch restarts the wait: the fix is stalled again only if the
    // wake it got also went unclaimed for the full window.
    const since = Math.max(created, ms(t.lastRecoveryAt ?? null) ?? 0);
    if (now - since <= STALE_PENDING_CONFLICT_FIX_MS) return { stalled: false, reason: null, action: 'none' };
    return { stalled: true, reason: `the conflict fix has waited ${mins(now - since)} with no runner claim`, action: act('redispatch') };
  }
  if (t.workerStatus && ENDED_WORKER.has(t.workerStatus)) {
    return { stalled: true, reason: `the conflict fix's worker ended (${t.workerStatus}) without resolving it`, action: act('repair') };
  }
  const seen = ms(t.workerUpdatedAt ?? null);
  if (seen != null && now - seen > SILENT_CONFLICT_FIX_MS) {
    return { stalled: true, reason: `the conflict fix's worker has been silent for ${mins(now - seen)}`, action: 'none' };
  }
  const claimed = ms(t.claimedAt ?? null);
  if (!t.workerStatus && claimed != null && now - claimed > SILENT_CONFLICT_FIX_MS) {
    return { stalled: true, reason: 'the conflict fix was claimed but no worker ever started', action: act('repair') };
  }
  return { stalled: false, reason: null, action: 'none' };
}

