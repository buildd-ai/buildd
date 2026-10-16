/**
 * Make a confident file prediction the scope of a task filed without one.
 *
 * Runs only when the platform owner switched `orchestration_manifest` to
 * acting (packages/core/decision-feature-modes.ts), after the prediction was
 * recorded, still inside the creation request's `after()` callback. Every
 * rail of `prepareGatedManifest` holds (caller scope wins, the prediction is
 * complete over a candidate set with known coverage, every pick applied at the
 * threshold), and the write is one compare-and-swap: the task must still be
 * pending, unclaimed, with no concrete scope, at the path-claim revision we
 * read. Anything else leaves the task as it was. Never throws.
 *
 * What changes: `pathManifest` becomes the prediction (plus namespace
 * anchors), so the claim-time overlap and lease checks serialize it like a
 * declared scope. `pathDeclaration.declared` keeps what the filer gave, and
 * `pathDeclaration.predicted` records where the scope came from. dependsOn
 * edges are not added: the claim-time checks are what read the new scope.
 */
import type { ManifestPredictionRow } from '@buildd/core/manifest-prediction-source';
import type { ManifestPick, ManifestPredictionRecord } from '@buildd/core/manifest-prediction';
import type { PathDeclaration } from '@buildd/shared';
import type { WorkspaceGitConfig } from '@buildd/core/db/schema';

export interface PredictedManifestTask {
  status: string;
  pathManifest: string[] | null;
  pathDeclaration: PathDeclaration | null;
  pathClaimRevision: number;
  gitConfig: WorkspaceGitConfig | null;
}

export interface ApplyPredictedManifestDeps {
  loadTask?: (taskId: string) => Promise<PredictedManifestTask | null>;
  /** CAS write; true when exactly one row changed. */
  write?: (args: { taskId: string; revision: number; pathManifest: string[]; pathDeclaration: PathDeclaration }) => Promise<boolean>;
  now?: () => Date;
}

export type ApplyPredictedManifestResult =
  | { applied: true; manifest: string[] }
  | { applied: false; reason: string };

async function dbLoadTask(taskId: string): Promise<PredictedManifestTask | null> {
  const { db } = await import('@buildd/core/db');
  const { tasks, workspaces } = await import('@buildd/core/db/schema');
  const { eq } = await import('drizzle-orm');
  const [row] = await db
    .select({
      status: tasks.status,
      pathManifest: tasks.pathManifest,
      pathDeclaration: tasks.pathDeclaration,
      pathClaimRevision: tasks.pathClaimRevision,
      gitConfig: workspaces.gitConfig,
    })
    .from(tasks)
    .leftJoin(workspaces, eq(workspaces.id, tasks.workspaceId))
    .where(eq(tasks.id, taskId))
    .limit(1);
  return (row as PredictedManifestTask | undefined) ?? null;
}

async function dbWrite(args: { taskId: string; revision: number; pathManifest: string[]; pathDeclaration: PathDeclaration }): Promise<boolean> {
  const { db } = await import('@buildd/core/db');
  const { tasks } = await import('@buildd/core/db/schema');
  const { and, eq, sql } = await import('drizzle-orm');
  const rows = await db
    .update(tasks)
    .set({
      pathManifest: args.pathManifest,
      pathDeclaration: args.pathDeclaration,
      pathClaimRevision: sql`${tasks.pathClaimRevision} + 1`,
      updatedAt: new Date(),
    })
    .where(and(eq(tasks.id, args.taskId), eq(tasks.status, 'pending'), eq(tasks.pathClaimRevision, args.revision)))
    .returning({ id: tasks.id });
  return rows.length === 1;
}

export function predictionRecordOf(row: ManifestPredictionRow): ManifestPredictionRecord {
  return {
    candidates: row.candidates ?? [],
    selected: row.selected ?? [],
    picks: (row.picks ?? []) as unknown as ManifestPick[],
    stop: row.stopReason as ManifestPredictionRecord['stop'],
    complete: row.complete ?? false,
    unknownScope: row.unknownScope ?? true,
    allApplied: row.allApplied ?? false,
    decisionId: row.decisionId,
    candidatePolicyVersion: row.candidatePolicyVersion,
  };
}

export async function applyPredictedManifest(
  input: { taskId: string; row: ManifestPredictionRow; threshold: number },
  deps: ApplyPredictedManifestDeps = {},
): Promise<ApplyPredictedManifestResult> {
  try {
    const task = await (deps.loadTask ?? dbLoadTask)(input.taskId);
    if (!task) return { applied: false, reason: 'no_task' };
    if (task.status !== 'pending') return { applied: false, reason: 'not_pending' };
    const { prepareGatedManifest } = await import('@buildd/core/manifest-prediction');
    const { resolveAnchorInjections } = await import('@buildd/core/sequence-anchors');
    const decision = prepareGatedManifest({
      prediction: predictionRecordOf(input.row),
      callerManifest: task.pathManifest,
      eligibleMissingScope: true,
      minConfidence: input.threshold,
      injectAnchors: (m) => resolveAnchorInjections(m, task.gitConfig),
      enabled: true,
    });
    if (!decision.apply) return { applied: false, reason: decision.reason };
    const now = (deps.now ?? (() => new Date()))();
    const prior = task.pathDeclaration;
    const pathDeclaration: PathDeclaration = {
      ...(prior ?? {}),
      declared: prior ? prior.declared : task.pathManifest,
      source: prior?.source ?? 'creation',
      snapshotAt: prior?.snapshotAt ?? now.toISOString(),
      predicted: { ...decision.provenance, threshold: input.threshold, at: now.toISOString() },
    };
    const ok = await (deps.write ?? dbWrite)({
      taskId: input.taskId,
      revision: task.pathClaimRevision,
      pathManifest: decision.manifest,
      pathDeclaration,
    });
    return ok ? { applied: true, manifest: decision.manifest } : { applied: false, reason: 'changed_meanwhile' };
  } catch (err) {
    console.warn('[apply-predicted-manifest] failed open (non-fatal):', (err as Error)?.message ?? err);
    return { applied: false, reason: 'error' };
  }
}
