/**
 * The I/O around packages/core/model-observation.ts: write one observation per
 * worker attempt when its terminal report arrives, fold late independent
 * evidence into the same row, and read a workspace's rows.
 *
 * Telemetry: every writer is best-effort and never throws into the report or
 * webhook path that calls it.
 */
import { db } from '@buildd/core/db';
import { modelObservations, tasks, workers, workspaces } from '@buildd/core/db/schema';
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { knownPriceForModel } from '@buildd/core/model-prices';
import {
  buildObservation,
  evidenceColumns,
  parentAttemptOf,
  sanitizeDescriptor,
  type ObservationEvidence,
} from '@buildd/core/model-observation';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { runToObservation, validateRunRecord, type RunRecord } from '@buildd/core/local-eval';

export interface RecordObservationInput {
  workerId: string;
  /** The runner's `modelObservation` payload, untrusted. */
  rawDescriptor?: unknown;
  actualModel?: string | null;
  /** The classified exit cause and the final status at the terminal write. */
  exitCause?: string | null;
  status: string;
  costUsd?: number | string | null;
  durationMs?: number | null;
}

/** Record (upsert) the observation for a worker's terminal report. */
export async function recordModelObservation(input: RecordObservationInput): Promise<boolean> {
  try {
    const worker = await db.query.workers.findFirst({ where: sqlWhere(eq(workers.id, input.workerId)) });
    if (!worker) return false;
    const ws = await db.query.workspaces.findFirst({
      where: sqlWhere(eq(workspaces.id, worker.workspaceId)),
      columns: { teamId: true },
    });
    if (!ws?.teamId) return false;
    const task = worker.taskId
      ? await db.query.tasks.findFirst({
          where: sqlWhere(eq(tasks.id, worker.taskId)),
          columns: { id: true, kind: true, complexity: true, context: true },
        })
      : null;

    const descriptor = sanitizeDescriptor(input.rawDescriptor);
    const ctx = (task?.context ?? {}) as Record<string, unknown>;
    const chainId = task ? (typeof ctx.rootTaskId === 'string' && ctx.rootTaskId ? ctx.rootTaskId : task.id) : null;

    let parentWorkerId: string | null = null;
    if (chainId) {
      const prior = await db.select({ workerId: modelObservations.workerId, startedAt: modelObservations.startedAt })
        .from(modelObservations)
        .where(and(eq(modelObservations.chainId, chainId), eq(modelObservations.workspaceId, worker.workspaceId)))
        .orderBy(desc(modelObservations.startedAt))
        .limit(50);
      parentWorkerId = parentAttemptOf(prior, { workerId: worker.id, startedAt: worker.startedAt ?? null });
    }

    const model = input.actualModel ?? null;
    const localModel = descriptor.endpointKind === 'local_loopback';
    const costNum = input.costUsd === null || input.costUsd === undefined ? null : Number(input.costUsd);
    const values = buildObservation({
      workerId: worker.id,
      taskId: worker.taskId ?? null,
      workspaceId: worker.workspaceId,
      teamId: ws.teamId,
      chainId,
      parentWorkerId,
      resolvedModel: model,
      taskClass: task ? [task.kind, task.complexity].filter(Boolean).join('/') || null : null,
      modelRoute: worker.modelRoute ?? null,
      localModel,
      startedAt: worker.startedAt ?? null,
      endedAt: new Date(),
      durationMs: input.durationMs ?? null,
      inputTokens: worker.inputTokens ?? null,
      outputTokens: worker.outputTokens ?? null,
      turns: worker.turns ?? null,
      retries: typeof ctx.retryCount === 'number' ? (ctx.retryCount as number) : 0,
      status: input.status,
      exitCause: input.exitCause ?? worker.exitCause ?? null,
      costUsd: Number.isFinite(costNum as number) ? costNum : null,
      costBasis: worker.costBasis ?? null,
      priced: !localModel && !!model && knownPriceForModel(model) !== null,
      descriptor,
    });

    const row = { ...values, costUsd: values.costUsd === null ? null : String(values.costUsd) };
    const { workerId: _w, attempt: _a, ...updateRow } = row;
    await db.insert(modelObservations)
      .values(row)
      .onConflictDoUpdate({
        // Evidence columns are never in the set: a redelivered report must not erase late evidence.
        target: [modelObservations.workerId, modelObservations.attempt],
        set: { ...updateRow, updatedAt: new Date() },
      });

    // A completed attempt that needed another attempt was reworked. A failed one was only retried.
    if (parentWorkerId) {
      await db.update(modelObservations)
        .set({ reworked: true, evidenceUpdatedAt: new Date() })
        .where(and(eq(modelObservations.workerId, parentWorkerId), eq(modelObservations.terminalOutcome, 'completed')));
    }
    return true;
  } catch (err) {
    console.error(`[model-observation] recording worker ${input.workerId} failed:`, err instanceof Error ? err.message : String(err));
    return false;
  }
}

export type EvidenceTarget = { workerId: string } | { workspaceId: string; taskId: string } | { workspaceId: string; prNumber: number };

/**
 * Fold one late, independently recorded fact (a review verdict, CI result, spec
 * verdict, merge) into the latest observation of the attempt that produced it.
 * A no-op when no observation exists (a run from before capture): nothing is
 * backfilled.
 */
export async function recordObservationEvidence(target: EvidenceTarget, patch: Partial<ObservationEvidence>): Promise<boolean> {
  try {
    const set = evidenceColumns(patch);
    if (!set) return false;
    let workerId: string | null = null;
    if ('workerId' in target) {
      workerId = target.workerId;
    } else if ('taskId' in target) {
      const [r] = await db.select({ workerId: modelObservations.workerId }).from(modelObservations)
        .where(and(eq(modelObservations.workspaceId, target.workspaceId), eq(modelObservations.taskId, target.taskId)))
        .orderBy(desc(modelObservations.startedAt)).limit(1);
      workerId = r?.workerId ?? null;
    } else {
      const w = await db.query.workers.findFirst({
        where: sqlWhere(and(eq(workers.workspaceId, target.workspaceId), eq(workers.prNumber, target.prNumber))),
        columns: { id: true },
      });
      workerId = w?.id ?? null;
    }
    if (!workerId) return false;
    const [latest] = await db.select({ id: modelObservations.id }).from(modelObservations)
      .where(eq(modelObservations.workerId, workerId))
      .orderBy(desc(modelObservations.attempt)).limit(1);
    if (!latest) return false;
    await db.update(modelObservations)
      .set({ ...set, evidenceUpdatedAt: new Date() })
      .where(eq(modelObservations.id, latest.id));
    return true;
  } catch (err) {
    console.error('[model-observation] recording evidence failed:', err instanceof Error ? err.message : String(err));
    return false;
  }
}

/** Newest-first rows of one workspace (access is checked by the caller), bounded. */
export async function listModelObservations(workspaceId: string, limit = 100) {
  const n = Math.max(1, Math.min(500, Math.floor(limit)));
  return db.select().from(modelObservations)
    .where(eq(modelObservations.workspaceId, workspaceId))
    .orderBy(desc(modelObservations.createdAt))
    .limit(n);
}


/** The window a comparison reads: bounded so one page cannot scan a workspace's whole history. */
export const COMPARISON_ROW_LIMIT = 5000;

/** One workspace's observations since `since`, newest first (access is checked by the caller). */
export async function listObservationsForComparison(workspaceId: string, since: Date | null, until: Date | null = null) {
  const conds = [eq(modelObservations.workspaceId, workspaceId)];
  if (since) conds.push(gte(modelObservations.createdAt, since));
  if (until) conds.push(lte(modelObservations.createdAt, until));
  return db.select().from(modelObservations)
    .where(and(...conds))
    .orderBy(desc(modelObservations.createdAt))
    .limit(COMPARISON_ROW_LIMIT);
}

/**
 * Ingest controlled replay runs (packages/core/local-eval.ts) as observation
 * rows carrying their case/config attribution. Idempotent: a run id maps to a
 * fixed worker id, so re-sending a run updates its one row. Returns the ids
 * ingested and the reasons any record was refused.
 */
export async function ingestReplayRuns(workspaceId: string, records: unknown[]): Promise<{ ingested: string[]; rejected: Array<{ index: number; errors: string[] }> }> {
  const ws = await db.query.workspaces.findFirst({ where: sqlWhere(eq(workspaces.id, workspaceId)), columns: { teamId: true } });
  const ingested: string[] = [];
  const rejected: Array<{ index: number; errors: string[] }> = [];
  if (!ws?.teamId) return { ingested, rejected: records.map((_, index) => ({ index, errors: ['workspace has no team'] })) };
  for (const [index, raw] of records.entries()) {
    const errors = validateRunRecord(raw);
    if (errors.length) { rejected.push({ index, errors }); continue; }
    const run = raw as RunRecord;
    const { values, evaluation, evidence } = runToObservation(run, { workspaceId, teamId: ws.teamId });
    const row = { ...values, costUsd: null, evaluation: evaluation as unknown as Record<string, unknown>, ...evidence, evidenceUpdatedAt: new Date() };
    const { workerId: _w, attempt: _a, ...update } = row;
    await db.insert(modelObservations).values(row).onConflictDoUpdate({
      target: [modelObservations.workerId, modelObservations.attempt],
      set: { ...update, updatedAt: new Date() },
    });
    ingested.push(run.runId);
  }
  return { ingested, rejected };
}
