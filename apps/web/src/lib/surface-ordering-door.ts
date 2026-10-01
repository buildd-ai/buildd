/**
 * The two calls every merge door makes for surface ordering
 * (conflict-aware-orchestration.md §3), shaped so the default policy costs
 * nothing: with `surfaceOrdering` off the ordering module is never loaded and
 * nothing is read.
 *
 *   const order = await checkSurfaceOrder({...});      // before ANY branch mutation
 *   if (order.blocks) return defer(order.reason);
 *   ...rails, verdict...
 *   const merged = await mergeInSurfaceSlot(order, () => mergePullRequest(...));
 *   if ('refused' in merged) return defer(merged.refused);
 */
import type { WorkspaceGitConfig } from '@buildd/core/db/schema';
import { resolveSurfaceOrderingMode } from '@/lib/surface-ordering-config';
import type { GuardInput, SurfaceOrderingVerdict } from '@/lib/surface-ordering';

export type DoorGuardInput = Omit<GuardInput, 'gitConfig'> & {
  /** Pass it when the door has the workspace; `undefined` loads it (a failed load reads as off). */
  gitConfig: WorkspaceGitConfig | null | undefined;
};

const PASS: SurfaceOrderingVerdict = { blocks: false, slot: null };

async function loadGitConfig(workspaceId: string): Promise<WorkspaceGitConfig | null> {
  try {
    const [{ db }, { workspaces }, { eq }] = await Promise.all([
      import('@buildd/core/db'),
      import('@buildd/core/db/schema'),
      import('drizzle-orm'),
    ]);
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId), columns: { gitConfig: true } });
    return (ws?.gitConfig as WorkspaceGitConfig | null) ?? null;
  } catch {
    return null;
  }
}

export async function checkSurfaceOrder(input: DoorGuardInput): Promise<SurfaceOrderingVerdict> {
  const gitConfig = input.gitConfig === undefined ? await loadGitConfig(input.workspaceId) : input.gitConfig;
  if (resolveSurfaceOrderingMode(gitConfig) === 'off') return PASS;
  try {
    const { guardSurfaceOrdering } = await import('@/lib/surface-ordering');
    return await guardSurfaceOrdering({ ...input, gitConfig });
  } catch (err) {
    // The guard never throws by design; an import/runtime failure here is a
    // platform fault. Enforce fails closed, shadow does not.
    const reason = `surface ordering could not run: ${err instanceof Error ? err.message : String(err)}`;
    if (resolveSurfaceOrderingMode(gitConfig) === 'enforce' && !input.override) {
      return { blocks: true, kind: 'unverified', reason, counterpartPrNumber: null, surface: null };
    }
    return PASS;
  }
}

/** Reserve the verdict's surfaces around `merge`, always releasing. A verdict with no slot just merges. */
export async function mergeInSurfaceSlot<T>(
  verdict: SurfaceOrderingVerdict,
  merge: () => Promise<T>,
): Promise<{ refused: string } | { result: T }> {
  if (verdict.blocks) return { refused: verdict.reason };
  if (!verdict.slot) return { result: await merge() };
  const { withMergeSlot } = await import('@/lib/surface-ordering');
  return withMergeSlot(verdict.slot, merge);
}
