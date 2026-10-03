/**
 * The creation-manifest shadow's one post-insert hook (knowledge-base:
 * buildd/design/conflict-aware-orchestration.md §5a; jev-scheduling.md §3).
 * Every path that files work calls it with the row it just inserted: POST
 * /api/tasks (MCP and chat land there too), plan approval (approve-plan.ts)
 * and schedule-filed tasks (cron/schedules). The hook decides eligibility, so
 * the callers cannot drift apart on it.
 *
 * The prediction runs AFTER the response via `after()`, so it cannot add
 * latency to, change, or fail the request: the task row, its manifest, its
 * dependsOn and every creation rejection are decided before this is called
 * and never revisited. It never writes a manifest, a lease or a dependsOn edge.
 *
 * Opt-in per team (`orchestration_manifest` in `teams.enabledDecisionShadows`);
 * a team that has not opted in costs one team-row read, after the response.
 *
 * The core module is imported lazily inside the run, so the callers' static
 * import graphs gain nothing.
 */
import type { CreationManifestDeps, CreationManifestInput } from '@buildd/core/manifest-prediction-source';
import { hasConcretePathManifest } from '@buildd/core/path-overlap';

export type CreationManifestShadowInput = CreationManifestInput;

/** Work kinds whose scope is files. Unknown (null) is predicted too: most rows carry no kind. */
export const MANIFEST_PREDICTION_KINDS: ReadonlySet<string> = new Set(['engineering', 'writing', 'design']);

/** The columns of an inserted task row the hook reads. */
export interface CreatedTaskForManifest {
  id: string;
  workspaceId: string | null;
  missionId?: string | null;
  title: string;
  description?: string | null;
  createdAt?: Date | string | null;
  pathManifest?: string[] | null;
  taskClass?: string | null;
  kind?: string | null;
  context?: unknown;
}

export type ManifestShadowSkipReason = 'not_work' | 'kind' | 'caller_declared';

export function creationManifestEligibility(
  task: Pick<CreatedTaskForManifest, 'taskClass' | 'kind' | 'pathManifest'>,
): { eligible: true } | { eligible: false; reason: ManifestShadowSkipReason } {
  if ((task.taskClass ?? 'work') !== 'work') return { eligible: false, reason: 'not_work' };
  if (task.kind && !MANIFEST_PREDICTION_KINDS.has(task.kind)) return { eligible: false, reason: 'kind' };
  // The caller's concrete manifest always wins. The sentinel and too-wide
  // globs are missing scope, the same test the creation gate uses.
  if (hasConcretePathManifest(task.pathManifest ?? null)) return { eligible: false, reason: 'caller_declared' };
  return { eligible: true };
}

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

/**
 * Schedules a prediction for an eligible, just-inserted task. Returns whether
 * one was scheduled. Never throws.
 */
export function scheduleCreationManifestShadow(
  task: CreatedTaskForManifest,
  ctx: { teamId: string | null | undefined; accountId?: string | null; userId?: string | null },
  schedule: (fn: () => Promise<unknown>) => void,
  deps: CreationManifestDeps = {},
): boolean {
  let input: CreationManifestShadowInput;
  try {
    if (!task?.id || !task.workspaceId || !ctx?.teamId) return false;
    if (!creationManifestEligibility(task).eligible) return false;
    const created = task.createdAt instanceof Date
      ? task.createdAt
      : task.createdAt ? new Date(task.createdAt) : new Date();
    const context = (task.context ?? null) as Record<string, unknown> | null;
    input = {
      taskId: task.id,
      teamId: ctx.teamId,
      workspaceId: task.workspaceId,
      missionId: task.missionId ?? null,
      accountId: ctx.accountId ?? null,
      userId: ctx.userId ?? null,
      title: task.title,
      description: task.description ?? null,
      createdAt: Number.isFinite(created.getTime()) ? created : new Date(),
      callerManifest: task.pathManifest ?? null,
      baseRef: typeof context?.baseBranch === 'string' ? context.baseBranch : null,
    };
  } catch (err) {
    console.warn('[manifest-shadow] not scheduled (non-fatal):', (err as Error)?.message ?? err);
    return false;
  }
  const run = () => runCreationManifestShadow(input, deps);
  try {
    schedule(run);
  } catch {
    // after() is unavailable outside a request scope; still never block.
    void run();
  }
  return true;
}
