interface RouterLike {
  refresh: () => void;
}

interface PendingEntry {
  trailing: ReturnType<typeof setTimeout>;
  max: ReturnType<typeof setTimeout>;
}

// Module-level: RealTimeWorkerView (worker channel) and TaskAutoRefresh
// (workspace channel) both receive an event for the same underlying PATCH.
// Keying by taskId here — not per-component state — is what lets their calls
// collapse into one router.refresh() instead of two.
const pending = new Map<string, PendingEntry>();

function clearPending(taskId: string): void {
  const entry = pending.get(taskId);
  if (!entry) return;
  clearTimeout(entry.trailing);
  clearTimeout(entry.max);
  pending.delete(taskId);
}

/**
 * Trailing debounce keyed by taskId, with a maxWait ceiling so a continuous
 * event stream can't postpone the refresh forever.
 */
export function requestRefresh(
  router: RouterLike,
  taskId: string,
  delay = 2000,
  maxWait = 5000,
): void {
  const fire = () => {
    clearPending(taskId);
    router.refresh();
  };

  const existing = pending.get(taskId);
  if (existing) clearTimeout(existing.trailing);

  const trailing = setTimeout(fire, delay);
  const max = existing ? existing.max : setTimeout(fire, maxWait);
  pending.set(taskId, { trailing, max });
}

/**
 * Bypass the debounce and refresh immediately — for status transitions and
 * terminal events, which must never be delayed or coalesced away. Clears any
 * debounced call already pending for this taskId so it doesn't double-fire.
 */
export function flushRefresh(router: RouterLike, taskId: string): void {
  clearPending(taskId);
  router.refresh();
}
