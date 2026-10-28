/**
 * The waiting count beside Health's Queue tab (spec 4bc3e70e r8 R-1). The
 * Queue tab publishes the count its one read gave, so that tab makes no
 * second read (R-14); another Health tab reads the queue once, after it
 * renders, when no count is fresh. Client-safe; one value per page session.
 */
import { useEffect, useSyncExternalStore } from 'react';

/** A published count older than this is read again by a tab other than Queue. */
export const QUEUE_COUNT_FRESH_MS = 60_000;

interface CountState { count: number | null; workspace: string | null; at: number }

let state: CountState = { count: null, workspace: null, at: 0 };
const listeners = new Set<() => void>();
let inFlight: string | null = null;

function emit() { for (const l of listeners) l(); }

export function publishQueueWaitingCount(count: number, workspace: string | null, at: number = Date.now()): void {
  if (state.count === count && state.workspace === workspace && at - state.at < QUEUE_COUNT_FRESH_MS) return;
  state = { count, workspace, at };
  emit();
}

/** The count for this workspace filter, or null when none was published for it. */
export function queueWaitingCountFor(s: CountState, workspace: string | null): number | null {
  return s.workspace === workspace ? s.count : null;
}

function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }
const snapshot = () => state;

/** Test hook. */
export function resetQueueWaitingCount(): void { state = { count: null, workspace: null, at: 0 }; inFlight = null; emit(); }

/**
 * The waiting count to show beside Queue. With `read` set (a Health tab that
 * is not Queue), a missing or stale count is read once from the queue route.
 */
export function useQueueWaitingCount(workspace: string | null, read: boolean): number | null {
  const s = useSyncExternalStore(subscribe, snapshot, snapshot);
  const stale = s.workspace !== workspace || Date.now() - s.at >= QUEUE_COUNT_FRESH_MS;
  useEffect(() => {
    if (!read || !stale) return;
    const key = workspace ?? '';
    if (inFlight === key) return;
    inFlight = key;
    const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}` : '';
    fetch(`/api/health/queue${qs}`)
      .then(res => (res.ok ? res.json() : null))
      .then((body: { tiles?: { waiting?: unknown } } | null) => {
        const n = body?.tiles?.waiting;
        if (typeof n === 'number') publishQueueWaitingCount(n, workspace);
      })
      .catch(() => {})
      .finally(() => { if (inFlight === key) inFlight = null; });
  }, [read, stale, workspace]);
  return queueWaitingCountFor(s, workspace);
}
