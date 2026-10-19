import { after as nextAfter } from 'next/server';
import { withLoaderLabel } from '@buildd/core/db/query-label';

/**
 * Work that does not change the reply runs after it is sent (spec 3ef37387
 * R-33): `after()` inside a request, inline outside one (tests, scripts), so
 * nothing is lost where no response is being sent. Never throws.
 *
 * The drain runs until the queue is empty, and a push that arrives after it
 * finished schedules again. The first version drained once: an item queued
 * while the drain was already running (it can start before the handler is
 * done) was never run, which dropped reviewer verdicts in v0.367.0.
 */
export function deferredReplyWork(opts: { after?: (cb: () => Promise<unknown>) => void } = {}) {
  const after = opts.after ?? nextAfter;
  const pending: Array<{ label: string; fn: () => Promise<unknown> }> = [];
  let scheduled = false;
  const run = async () => {
    try {
      while (pending.length > 0) {
        const item = pending.shift()!;
        try { await withLoaderLabel(`workers.patch.after.${item.label}`, item.fn); }
        catch (err) { console.error(`[workers PATCH] ${item.label} failed:`, err); }
      }
    } finally {
      scheduled = false;
    }
  };
  return async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    pending.push({ label, fn });
    if (scheduled) return;
    scheduled = true;
    try {
      after(run);
    } catch {
      // Direct invocation (scripts/unit tests) has no request lifetime.
      await run();
    }
  };
}
