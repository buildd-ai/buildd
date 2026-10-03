/**
 * Postgres-backed {@link PostSessionRunStore} for the post-session quality
 * collector (`post-session-run.ts`).
 *
 * Writes go to `post_session_runs` and nowhere else — the worker and task a
 * run describes are read, never updated. Each Stage A sub-source is read
 * independently: one that fails becomes `null` + a name in `unavailable`, so a
 * slow reviewer query degrades the record instead of discarding it, and an
 * unread source is never reported as zero.
 */

import { db } from '@buildd/core/db';
import {
  knowledgeChunks,
  postSessionRuns,
  tasks,
  workerErrorTraces,
  workers,
  workspaces,
} from '@buildd/core/db/schema';
import { buildNamespace } from '@buildd/core/knowledge-store';
import {
  MAX_POST_SESSION_ATTEMPTS,
  POST_SESSION_STALE_COLLECTING_MS,
  type CorpusAvailability,
  type StageASource,
  type TranscriptAvailability,
} from '@buildd/core/post-session-quality';
import { TERMINAL_WORKER_STATUSES } from '@buildd/shared';
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { isStorageConfigured, objectExists } from './storage';
import { sessionArtifactKey } from './session-artifact-keys';
import type { PostSessionRunStore, PostSessionWorkerRef } from './post-session-run';

/** Reviewer rounds read per PR. A loop longer than this is itself the signal. */
const MAX_REVIEW_ROUNDS = 100;
const MAX_ERROR_PATTERNS = 10;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/** The verdict in force for one reviewer round — same precedence as derivePrReviewStatus. */
function reviewVerdict(result: unknown): { verdict: string | null; confidence: number | null } {
  const r = asRecord(result);
  const out = asRecord(r.structuredOutput);
  const verdict = typeof r.effectiveVerdict === 'string' ? r.effectiveVerdict
    : typeof out.verdict === 'string' ? out.verdict : null;
  return { verdict, confidence: typeof out.confidence === 'number' ? out.confidence : null };
}

async function corpusAvailability(namespace: string): Promise<CorpusAvailability> {
  const rows = await db
    .select({ id: knowledgeChunks.id })
    .from(knowledgeChunks)
    .where(and(eq(knowledgeChunks.namespace, namespace), eq(knowledgeChunks.isCurrent, true)))
    .limit(1);
  return rows.length > 0 ? 'indexed' : 'not_indexed';
}

export const postSessionRunStore: PostSessionRunStore = {
  async loadWorker(workerId) {
    const row = await db.query.workers.findFirst({
      where: eq(workers.id, workerId),
      columns: { id: true, status: true, startedAt: true, exitCause: true, taskId: true, workspaceId: true },
      with: {
        task: { columns: { missionId: true } },
        workspace: { columns: { gitConfig: true } },
      },
    });
    if (!row) return null;
    return {
      id: row.id,
      status: row.status,
      startedAt: row.startedAt,
      exitCause: row.exitCause,
      taskId: row.taskId,
      workspaceId: row.workspaceId,
      missionId: row.task?.missionId ?? null,
      gitConfig: row.workspace?.gitConfig ?? null,
    };
  },

  async claimRun({ workerId, taskId, workspaceId, missionId, policyVersion, mode, now }) {
    const inserted = await db
      .insert(postSessionRuns)
      .values({ workerId, taskId, workspaceId, missionId, policyVersion, mode, state: 'collecting', attempts: 1, createdAt: now, updatedAt: now })
      .onConflictDoNothing({ target: [postSessionRuns.workerId, postSessionRuns.policyVersion] })
      .returning({ id: postSessionRuns.id });
    if (inserted[0]) return { claimed: true, runId: inserted[0].id, attempt: 1 };

    // The row exists. Reclaim it only from a retryable state, as one atomic
    // compare-and-set: two sweepers can both get here, one wins.
    const staleBefore = new Date(now.getTime() - POST_SESSION_STALE_COLLECTING_MS);
    const reclaimed = await db
      .update(postSessionRuns)
      .set({ state: 'collecting', attempts: sql`${postSessionRuns.attempts} + 1`, updatedAt: now })
      .where(and(
        eq(postSessionRuns.workerId, workerId),
        eq(postSessionRuns.policyVersion, policyVersion),
        or(
          and(eq(postSessionRuns.state, 'failed'), sql`${postSessionRuns.attempts} < ${MAX_POST_SESSION_ATTEMPTS}`),
          and(eq(postSessionRuns.state, 'collecting'), sql`${postSessionRuns.updatedAt} < ${staleBefore.toISOString()}::timestamptz`),
        ),
      ))
      .returning({ id: postSessionRuns.id, attempts: postSessionRuns.attempts });
    if (reclaimed[0]) return { claimed: true, runId: reclaimed[0].id, attempt: reclaimed[0].attempts };

    const existing = await db
      .select({ id: postSessionRuns.id, state: postSessionRuns.state })
      .from(postSessionRuns)
      .where(and(eq(postSessionRuns.workerId, workerId), eq(postSessionRuns.policyVersion, policyVersion)))
      .limit(1);
    if (!existing[0]) throw new Error('post-session run neither inserted nor found');
    return { claimed: false, runId: existing[0].id, state: existing[0].state };
  },

  async loadSource(ref: PostSessionWorkerRef, mode) {
    const w = await db.query.workers.findFirst({
      where: eq(workers.id, ref.id),
      columns: {
        id: true, status: true, exitCause: true, error: true, turns: true, inputTokens: true, outputTokens: true,
        costUsd: true, startedAt: true, completedAt: true, prNumber: true, prLifecycleStatus: true, mergedAt: true,
        supersededByPrNumber: true, abandonedAt: true, rejectedCompletionPayload: true, dirtyWorktree: true,
        mcpCalls: true, resultMeta: true, createdAt: true, taskId: true, workspaceId: true,
      },
      with: {
        task: {
          columns: {
            id: true, status: true, kind: true, category: true, roleSlug: true, missionId: true,
            outputRequirement: true, creationSource: true, parentTaskId: true, result: true,
          },
        },
        workspace: { columns: { id: true, teamId: true, dataClass: true, gitConfig: true } },
      },
    });
    if (!w || !w.task || !w.workspace) throw new Error('worker, task or workspace row not found');
    const { task, workspace } = w;

    const unavailable: string[] = [];
    async function read<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
      try {
        return await fn();
      } catch {
        unavailable.push(name);
        return null;
      }
    }

    const prNumber = w.prNumber;
    const [attempts, reviews, ciFixAttempts, errorTraces, transcript, corpora] = await Promise.all([
      read('attempts', async () => {
        const [row] = await db
          .select({
            total: count(),
            upTo: sql<number>`count(*) filter (where ${workers.createdAt} <= ${w.createdAt.toISOString()}::timestamptz)`,
          })
          .from(workers)
          .where(eq(workers.taskId, task.id));
        return { attemptNumber: Number(row?.upTo ?? 0), totalAttempts: Number(row?.total ?? 0) };
      }),
      read('reviews', async () => {
        if (prNumber === null) return [];
        const rows = await db
          .select({ status: tasks.status, result: tasks.result })
          .from(tasks)
          .where(and(
            eq(tasks.workspaceId, workspace.id),
            eq(tasks.category, 'review'),
            sql`${tasks.context}->>'prNumber' = ${String(prNumber)}`,
          ))
          .orderBy(asc(tasks.createdAt))
          .limit(MAX_REVIEW_ROUNDS);
        return rows.map(r => ({ status: r.status, ...reviewVerdict(r.result) }));
      }),
      read('ci_fixes', async () => {
        if (prNumber === null) return 0;
        const [row] = await db
          .select({ n: count() })
          .from(tasks)
          .where(and(eq(tasks.workspaceId, workspace.id), eq(tasks.ciRetryPrNumber, prNumber)));
        return Number(row?.n ?? 0);
      }),
      read('error_traces', async () => {
        const rows = await db
          .select({ pattern: workerErrorTraces.pattern, count: count() })
          .from(workerErrorTraces)
          .where(eq(workerErrorTraces.workerId, w.id))
          .groupBy(workerErrorTraces.pattern)
          .orderBy(desc(count()))
          .limit(MAX_ERROR_PATTERNS);
        return rows.map(r => ({ pattern: r.pattern, count: Number(r.count) }));
      }),
      (async (): Promise<{ availability: TranscriptAvailability; sizeBytes: number | null }> => {
        // Sensitive workspaces never upload (refused at signing); do not probe.
        if (workspace.dataClass === 'sensitive') return { availability: 'excluded', sizeBytes: null };
        if (!isStorageConfigured() || !workspace.teamId) return { availability: 'unknown', sizeBytes: null };
        const probed = await read('transcript', () => objectExists(sessionArtifactKey({
          teamId: workspace.teamId,
          workspaceId: workspace.id,
          workerId: w.id,
          kind: 'transcript',
        })));
        return { availability: probed === null ? 'unknown' : probed ? 'present' : 'absent', sizeBytes: null };
      })(),
      read('corpora', async () => {
        const [code, docs] = await Promise.all([
          corpusAvailability(buildNamespace(workspace.id, 'code')),
          corpusAvailability(buildNamespace(workspace.id, 'docs')),
        ]);
        return { code, docs };
      }),
    ]);

    const source: StageASource = {
      worker: {
        id: w.id,
        status: w.status,
        exitCause: w.exitCause,
        error: w.error,
        turns: w.turns,
        inputTokens: w.inputTokens,
        outputTokens: w.outputTokens,
        costUsd: w.costUsd,
        startedAt: w.startedAt,
        completedAt: w.completedAt,
        prNumber: w.prNumber,
        prLifecycleStatus: w.prLifecycleStatus,
        mergedAt: w.mergedAt,
        supersededByPrNumber: w.supersededByPrNumber,
        abandonedAt: w.abandonedAt,
        rejectedCompletionPayload: w.rejectedCompletionPayload,
        dirtyWorktree: w.dirtyWorktree,
        mcpCallCount: Array.isArray(w.mcpCalls) ? w.mcpCalls.length : null,
        resultMeta: w.resultMeta,
      },
      task: {
        id: task.id,
        status: task.status,
        kind: task.kind,
        category: task.category,
        roleSlug: task.roleSlug,
        missionId: task.missionId,
        outputRequirement: task.outputRequirement,
        creationSource: task.creationSource,
        parentTaskId: task.parentTaskId,
        result: task.result,
      },
      workspace: {
        id: workspace.id,
        // The configured tier; null = the workspace runs on the default policy.
        mergePolicyTier: workspace.gitConfig?.mergePolicy?.tier ?? null,
        dataClass: workspace.dataClass,
      },
      mode,
      attempts,
      reviews,
      ciFixAttempts,
      errorTraces,
      transcript,
      corpora,
      unavailable,
    };
    return source;
  },

  async completeRun(runId, attempt, { facts, transcriptAvailability, now }) {
    const rows = await db
      .update(postSessionRuns)
      .set({
        state: 'collected',
        facts,
        factsSchemaVersion: facts.schemaVersion,
        transcriptAvailability,
        collectedAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(postSessionRuns.id, runId),
        eq(postSessionRuns.state, 'collecting'),
        eq(postSessionRuns.attempts, attempt),
      ))
      .returning({ id: postSessionRuns.id });
    return rows.length > 0;
  },

  async failRun(runId, attempt, { stage, error, now }) {
    await db
      .update(postSessionRuns)
      .set({ state: 'failed', errorStage: stage, lastError: error, failedAt: now, updatedAt: now })
      .where(and(
        eq(postSessionRuns.id, runId),
        eq(postSessionRuns.state, 'collecting'),
        eq(postSessionRuns.attempts, attempt),
      ));
  },

  async listCandidates({ policyVersion, since, limit, now }) {
    const staleBefore = new Date(now.getTime() - POST_SESSION_STALE_COLLECTING_MS).toISOString();
    const rows = await db
      .select({ id: workers.id })
      .from(workers)
      .innerJoin(workspaces, eq(workspaces.id, workers.workspaceId))
      .where(and(
        inArray(workers.status, [...TERMINAL_WORKER_STATUSES]),
        isNotNull(workers.startedAt),
        isNotNull(workers.taskId),
        or(isNull(workers.exitCause), ne(workers.exitCause, 'never_started')),
        gte(workers.completedAt, since),
        // Mirrors resolvePostSessionQualityMode: only an explicit 'off' opts out.
        sql`coalesce(${workspaces.gitConfig}->'postSessionQuality'->>'mode', '') <> 'off'`,
        sql`NOT EXISTS (
          SELECT 1 FROM post_session_runs r
          WHERE r.worker_id = ${workers.id}
            AND r.policy_version = ${policyVersion}
            AND NOT (
              (r.state = 'failed' AND r.attempts < ${MAX_POST_SESSION_ATTEMPTS})
              OR (r.state = 'collecting' AND r.updated_at < ${staleBefore}::timestamptz)
            )
        )`,
      ))
      .orderBy(asc(workers.completedAt))
      .limit(limit);
    return rows.map(r => r.id);
  },
};
