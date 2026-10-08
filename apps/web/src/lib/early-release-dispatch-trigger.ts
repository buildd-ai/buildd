/**
 * Schedule an early-release dispatch (lib/early-release-dispatch.ts) without
 * making the webhook wait for, or fail on, the GitHub/decision-model reads it
 * needs.
 *
 * Kept apart from the dispatcher so the hot webhook route does not load
 * `decision-policy.ts` and everything behind it until a dispatch actually
 * runs — mirrors `pr-scope-reconcile-trigger.ts`. Runs after the response
 * when there is a request scope, immediately (still detached) when there is
 * not. Never throws: a dropped dispatch leaves the dependsOn gate closed,
 * today's default.
 */
import { after } from 'next/server';
import type { DispatchEarlyReleaseInput } from '@/lib/early-release-dispatch';

export function scheduleEarlyReleaseDispatch(input: DispatchEarlyReleaseInput): void {
  const run = async () => {
    try {
      const { dispatchEarlyRelease } = await import('@/lib/early-release-dispatch');
      await dispatchEarlyRelease(input);
    } catch (err) {
      console.error(`[early-release] dispatch failed for upstream PR #${input.upstreamPrNumber}:`, err);
    }
  };
  try {
    after(run);
  } catch {
    void run();
  }
}
