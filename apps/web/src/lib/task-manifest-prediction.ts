/**
 * Schedules the creation-manifest shadow (knowledge-base: buildd/design/conflict-aware-orchestration.md
 * §5a) from task creation. The prediction runs AFTER the response via `after()`,
 * so it cannot add latency to, change, or fail the request: the task row, its
 * manifest, its inferred dependsOn and every creation rejection are decided
 * before this is called and never revisited.
 *
 * Opt-in per team (`orchestration_manifest` in `teams.enabledDecisionShadows`);
 * a team that has not opted in costs one team-row read, after the response.
 *
 * The core module is imported lazily inside the run, so the task route's static
 * import graph gains nothing.
 */
import type { CreationManifestDeps, CreationManifestInput } from '@buildd/core/manifest-prediction-source';

export type CreationManifestShadowInput = CreationManifestInput;

export async function runCreationManifestShadow(
  input: CreationManifestShadowInput,
  deps: CreationManifestDeps = {},
): Promise<void> {
  try {
    const { predictCreationManifest } = await import('@buildd/core/manifest-prediction-source');
    const onReceipt = deps.onReceipt ?? (async (receipt) => {
      const { insertDecisionReceipts } = await import('./memory-decisions');
      await insertDecisionReceipts([receipt], { teamId: input.teamId, accountId: input.accountId ?? null });
    });
    await predictCreationManifest(input, { ...deps, onReceipt });
  } catch (err) {
    console.warn('[manifest-shadow] failed (non-fatal):', (err as Error)?.message ?? err);
  }
}

export function scheduleCreationManifestShadow(
  input: CreationManifestShadowInput,
  schedule: (fn: () => Promise<unknown>) => void,
  deps: CreationManifestDeps = {},
): void {
  const run = () => runCreationManifestShadow(input, deps);
  try {
    schedule(run);
  } catch {
    // after() is unavailable outside a request scope; still never block.
    void run();
  }
}
