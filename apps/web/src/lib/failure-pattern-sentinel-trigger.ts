/**
 * Fire a bounded, single-workspace Failure Pattern Sentinel sweep after a
 * lifecycle transition Buildd already processes as terminal (a worker
 * completing/failing, a PR review reaching a verdict, CI retries exhausting) —
 * without the request that observed the transition waiting on it, or failing
 * because of it.
 *
 * Same fire-and-forget idiom as `schedulePrScopeReconcile` /
 * `scheduleMemoryUseLabels`: `after()` when there is a request scope to defer
 * into, an immediate detached promise otherwise, never thrown back at the
 * caller either way.
 *
 * Debounced, not just deferred: a burst of terminal transitions for the same
 * workspace (a mission finishing ten tasks within a few seconds) must not
 * dispatch ten sweeps. A short claim in `system_cache`
 * (`failure-sentinel-trigger:<workspaceId>`, same atomic
 * insert-or-update-if-expired shape `failure-incident-actions.ts` uses for the
 * fix-task filing claim) lets exactly one caller per debounce window actually
 * run the sweep; everyone else is a no-op. This is purely a cost control — the
 * cron backstop and the incident store's own idempotent upsert already make a
 * lost or suppressed trigger harmless, so losing a race here never loses an
 * incident, only some minutes of detection latency the backstop closes anyway.
 */
import { after } from 'next/server';

/** Long enough to collapse a burst (a mission's tasks finishing within seconds of each other), short enough that a real new failure a minute later still gets its own sweep. */
const DEBOUNCE_MS = 2 * 60 * 1000;

async function claimTrigger(workspaceId: string): Promise<boolean> {
  const { db } = await import('@buildd/core/db');
  const { systemCache } = await import('@buildd/core/db/schema');
  const { lt } = await import('drizzle-orm');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + DEBOUNCE_MS);
  const key = `failure-sentinel-trigger:${workspaceId}`;
  const claimed = await db
    .insert(systemCache)
    .values({ key, value: { claimedAt: now.toISOString() }, updatedAt: now, expiresAt })
    .onConflictDoUpdate({
      target: systemCache.key,
      set: { value: { claimedAt: now.toISOString() }, updatedAt: now, expiresAt },
      setWhere: lt(systemCache.expiresAt, now),
    })
    .returning({ key: systemCache.key });
  return claimed.length > 0;
}

async function runTriggeredSweep(workspaceId: string): Promise<void> {
  try {
    if (!(await claimTrigger(workspaceId))) return; // another transition already claimed this window
    const { runFailurePatternSweep, productionSweepDeps } = await import('./failure-pattern-sweep');
    const counters = await runFailurePatternSweep(productionSweepDeps(), { workspaceIds: [workspaceId] });
    if (counters.candidates > 0 || counters.runFailures > 0) {
      console.log(JSON.stringify({ event: 'failure_pattern_sentinel_triggered', workspaceId, ...counters }));
    }
  } catch (err) {
    // Never the caller's problem: the cron backstop covers a sweep that could
    // not even start.
    console.error(`[failure-pattern-sentinel] triggered sweep failed for workspace ${workspaceId}:`, err);
  }
}

/**
 * Schedule a bounded sentinel sweep for one workspace. Fire-and-forget: never
 * throws, never awaited by the caller, and a missing/invalid workspaceId is a
 * silent no-op (the self-health floor and the cron backstop never depend on
 * this path firing).
 *
 * Inert under the test runner by default (`NODE_ENV=test`), same convention as
 * `scheduleMemoryUseLabels` (`memory-decisions.ts`): every OTHER route that
 * calls this (worker completion, PR review, CI-retry exhaustion) runs its own
 * unit tests against a hand-rolled `db.insert` spy that is overwritten by the
 * next insert — a real `after()` fallback firing a background DB write mid-test
 * would silently clobber whatever that test is asserting about ITS OWN insert.
 * `opts.force` is the escape hatch this module's own tests use to exercise the
 * real scheduling path.
 */
export function scheduleFailurePatternSentinel(
  workspaceId: string | null | undefined,
  opts: { force?: boolean } = {},
): void {
  if (!workspaceId) return;
  if (!opts.force && process.env.NODE_ENV === 'test') return;
  const run = () => runTriggeredSweep(workspaceId);
  try {
    after(run);
  } catch {
    void run();
  }
}
