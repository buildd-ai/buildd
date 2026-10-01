/**
 * Schedule a PR-scope reconciliation (lib/pr-scope-reconcile.ts) without
 * making the caller wait for, or fail on, the GitHub reads it needs.
 *
 * Kept apart from the reconciler so hot routes (the webhook, worker PATCH) and
 * retry filers do not load it — or its ownership primitives — until it runs.
 * Runs after the response when there is a request scope, immediately (still
 * detached) when there is not. Never throws: skipping a reconciliation leaves
 * the conservative, wider scope in place.
 */
import { after } from 'next/server';

export interface PrScopeReconcileRequest {
  workspaceId: string;
  installationId: number;
  repoFullName: string;
  prNumber: number;
  /** The head the caller saw; a read at any other head changes nothing. */
  expectedHeadSha?: string | null;
}

export function schedulePrScopeReconcile(input: PrScopeReconcileRequest): void {
  const run = async () => {
    try {
      const { reconcilePrBackedScopeSafely } = await import('@/lib/pr-scope-reconcile');
      await reconcilePrBackedScopeSafely(input);
    } catch (err) {
      console.error(`[pr-scope] could not run reconciliation for PR #${input.prNumber}:`, err);
    }
  };
  try {
    after(run);
  } catch {
    void run();
  }
}
