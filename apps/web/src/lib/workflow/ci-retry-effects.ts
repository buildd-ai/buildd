/**
 * Effect handlers for the CI family of the workflow kernel
 * (docs/specs/workflow-state-kernel.md §5.7, §10.2, §10.5), owned by the
 * reviews module like review-effects.ts and reached only through the
 * composition root (`WORKFLOW_EFFECT_HANDLERS` in apps/web/src/modules.ts).
 *
 * The ledger row was allocated by the transition that queued `dispatch_ci_fix`
 * (allocation is consumption, §5.7 rule 1). The handler only revalidates
 * against a live read (§10.5) and files the legacy-shaped CI fix (or the
 * schema-drift diagnose task), bound to that row. It never counts anything.
 */
import { eq, sql } from 'drizzle-orm';
import { after } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, workers, workspaces } from '@buildd/core/db/schema';
import { and, desc } from 'drizzle-orm';
import { announceTaskCreated, wakeTask } from '@/lib/dispatch-authority';
import { appendPrActivity, taskActivityUrl } from '@/lib/pr-activity-comment';
import { fetchCIFailureLogs } from '@/lib/ci-failure-inspect';
import { buildCIRetryTask } from '@/lib/ci-retry';
import { buildDriftDiagnoseTask, isSchemaDriftFailure } from '@/lib/ci-drift-diagnose';
import { inheritAttemptIdentity } from '@/lib/attempt-identity';
import { captureCiJobLogEvidence } from '@/lib/ci-job-log-evidence';
import { escalateCiRedHead } from '@/lib/ci-failure-retry';
import type { EffectHandler, EffectHandlers } from './effects';
import { applyCommand, loadView, type Exec } from './kernel';
import { ingestFact } from './facts';
import { githubReader, workspaceRepo } from './github-facts';

const dbExec: Exec = (q) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;

async function prWorker(workspaceId: string, prNumber: number) {
  return db.query.workers.findFirst({
    where: and(eq(workers.workspaceId, workspaceId), eq(workers.prNumber, prNumber)),
    columns: { id: true, branch: true, prUrl: true, prNumber: true },
    orderBy: [desc(workers.createdAt)],
  });
}

// ── dispatch_ci_fix: revalidate, then file the attempt's task ───────────────

const dispatchCiFix: EffectHandler = async (e) => {
  const view = await loadView({ deliveryId: e.deliveryId }, dbExec);
  const d = view.delivery;
  const attempt = view.attempts.find((a) => a.id === e.payload.attemptId);
  if (!d || !attempt) return { outcome: 'skipped:no_attempt' };
  // The task id IS the attempt id, so a re-run after a crash between insert and link files nothing twice.
  const taskId = attempt.id;
  if (attempt.taskId) return { outcome: 'ok:task_exists' };
  if (attempt.status !== 'queued') return { outcome: `skipped:attempt_${attempt.status}` };
  if (d.state !== 'REPAIRING' || d.boundAttemptId !== attempt.id) {
    const r = await applyCommand({ type: 'RepairNotNeeded', actor: 'effect:dispatch_ci_fix', attemptId: attempt.id, reason: 'state_moved' }, { ref: { deliveryId: d.id }, exec: dbExec });
    return { outcome: `skipped:${'reason' in r ? r.reason : 'state_moved'}` };
  }
  if (!d.repoFullName || d.prNumber == null || !attempt.boundHeadSha) return { outcome: 'skipped:no_pr' };
  const repo = await workspaceRepo(d.workspaceId);
  if (!repo) throw new Error('no GitHub installation for the workspace');
  const reader = githubReader(repo.installationId);
  const live = await reader.readPr(d.repoFullName, d.prNumber);
  if (!live) throw new Error('live PR read failed');

  // §10.5 at dispatch: the trigger fact must still be true for the current head.
  // A closed or merged PR is answered by its own fact (T17/T18 cancel the row).
  if (live.state !== 'open' || live.merged) return { outcome: 'skipped:pr_not_open' };
  if (live.headSha !== attempt.boundHeadSha) {
    // The head moved before the fix started: T3 skips the queued row and handles the head.
    await ingestFact({ kind: 'head_observed', workspaceId: d.workspaceId, source: 'effect:dispatch_ci_fix', repoFullName: d.repoFullName, prNumber: d.prNumber },
      { exec: dbExec, github: { ...reader, readPr: async () => live } });
    return { outcome: 'skipped:head_moved' };
  }
  if ((await reader.ciGreen?.(d.repoFullName, live.headSha)) === true) {
    await applyCommand({ type: 'RepairNotNeeded', actor: 'effect:dispatch_ci_fix', attemptId: attempt.id, reason: 'ci_green', live }, { ref: { deliveryId: d.id }, exec: dbExec });
    return { outcome: 'skipped:ci_green' };
  }

  const [owner, workspace, prw] = await Promise.all([
    db.query.tasks.findFirst({ where: eq(tasks.id, d.ownerTaskId) }),
    db.query.workspaces.findFirst({ where: eq(workspaces.id, d.workspaceId) }),
    prWorker(d.workspaceId, d.prNumber),
  ]);
  if (!owner || !workspace) return { outcome: 'skipped:missing_context' };
  const headSha = attempt.boundHeadSha;
  const ciLogs = await fetchCIFailureLogs(repo.installationId, d.repoFullName, headSha);
  const failureContext = ciLogs.summary || `CI check suite failed on ${d.repoFullName} PR #${d.prNumber} (SHA: ${headSha})`;
  const human = attempt.trigger === 'human';
  const branch = prw?.branch ?? '';
  // One row per (workspace, PR, head) in the legacy dedupe index; a second attempt on the
  // same head (the first one failed without pushing) is deduped by the ledger instead.
  const firstAtHead = view.attempts.filter((a) => a.family === 'ci' && a.boundHeadSha === headSha && a.status !== 'skipped').length <= 1;
  const identity = await inheritAttemptIdentity(owner.id);
  const kernelContext = { workflowAttemptId: attempt.id, prNumber: d.prNumber, headSha };
  const drift = isSchemaDriftFailure(ciLogs.failedJobNames);

  const built = drift
    ? buildDriftDiagnoseTask({
      originalTask: { id: owner.id, title: owner.title, workspaceId: owner.workspaceId, missionId: owner.missionId ?? null },
      repoFullName: d.repoFullName, prNumber: d.prNumber, headSha, failureContext, ciRunUrl: ciLogs.runUrl,
    })
    : buildCIRetryTask({
      originalTask: {
        id: owner.id, title: owner.title, description: owner.description, workspaceId: owner.workspaceId,
        context: (owner.context as Record<string, unknown> | null) ?? {}, missionId: owner.missionId ?? null,
      },
      worker: { id: prw?.id ?? '', branch, prNumber: d.prNumber },
      failureContext,
      repoFullName: d.repoFullName,
      ciRunId: ciLogs.runId,
      ciFailedJobId: ciLogs.failedJobId,
      ciRunUrl: ciLogs.runUrl,
      // Display only: "attempt N of M" from the ledger row (§5.7 rule 4).
      attemptsUsed: attempt.attemptNo - 1,
      workspaceMaxCiRetries: Math.max(attempt.maxAttempts, attempt.attemptNo),
    });
  if (!built) return { outcome: 'skipped:not_buildable' };

  const [row] = await db.insert(tasks).values({
    id: taskId,
    workspaceId: built.workspaceId,
    title: built.title,
    description: built.description,
    parentTaskId: built.parentTaskId,
    ...identity,
    ciRetryPrNumber: d.prNumber,
    ciRetryHeadSha: firstAtHead ? headSha : null,
    missionId: built.missionId,
    context: { ...built.context, ...kernelContext },
    creationSource: human ? 'dashboard' : 'webhook',
    taskClass: built.taskClass,
    ...('outputRequirement' in built ? { outputRequirement: (built as { outputRequirement?: string }).outputRequirement } : {}),
    deliveryId: d.id,
    deliveryRole: 'ci_fix',
    status: 'pending',
    priority: human ? 8 : 7,
  } as never).onConflictDoNothing().returning();
  if (!row) {
    // Either an earlier run filed it (crash before the link) or another index refused it
    // (a legacy CI retry still pending on this PR): link only a task that exists.
    const existing = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId), columns: { id: true } });
    if (!existing) throw new Error('CI fix task not filed: another CI retry is still pending on this PR');
  }
  await dbExec(sql`-- workflow:link_attempt_task
UPDATE workflow_attempts SET task_id = ${taskId}::uuid, updated_at = now()
WHERE id = ${attempt.id}::uuid AND task_id IS NULL`);
  if (!row) return { outcome: 'ok:task_exists' };

  await announceTaskCreated(row as never, workspace as never);
  await wakeTask(row.id, 'ci.retry');
  const captureEvidence = () => captureCiJobLogEvidence({
    installationId: repo.installationId, repoFullName: d.repoFullName!, failedJobId: ciLogs.failedJobId,
    workspaceId: d.workspaceId, retryTaskId: row.id, parentTaskId: owner.id, workerId: prw?.id ?? '', prNumber: d.prNumber!,
  });
  try { after(captureEvidence); } catch { await captureEvidence().catch(() => null); }
  await appendPrActivity({
    installationId: repo.installationId, repoFullName: d.repoFullName, prNumber: d.prNumber,
    entry: drift
      ? { kind: 'ci_fixing', detail: 'schema drift · diagnose only', url: ciLogs.runUrl, taskUrl: taskActivityUrl(row.id) }
      : { kind: 'ci_fixing', iteration: attempt.attemptNo, maxIterations: attempt.maxAttempts, ...(human ? { detail: 'manual' } : {}), url: ciLogs.runUrl, taskUrl: taskActivityUrl(row.id) },
    workspaceId: d.workspaceId,
  });
  return { outcome: drift ? 'ok:diagnose' : 'ok' };
};

// ── escalate_exhaustion (family ci): a person owns the red PR ──────────────

const escalateCiExhaustion: EffectHandler = async (e) => {
  const view = await loadView({ deliveryId: e.deliveryId }, dbExec);
  const d = view.delivery;
  if (!d?.repoFullName || d.prNumber == null) return { outcome: 'skipped:no_pr' };
  const repo = await workspaceRepo(d.workspaceId);
  if (!repo) return { outcome: 'skipped:no_installation' };
  const owner = await db.query.tasks.findFirst({ where: eq(tasks.id, d.ownerTaskId), columns: { id: true, title: true, workspaceId: true, missionId: true, result: true } });
  if (!owner) return { outcome: 'skipped:no_owner' };
  const spent = Number(e.payload.attempts ?? 0);
  const max = Number(e.payload.max ?? spent);
  const headSha = String(e.payload.headSha ?? d.currentHeadSha ?? '');
  const disabled = max <= 0;
  const detail = disabled
    ? `CI retries are disabled for this workspace; CI is failing on PR #${d.prNumber}.`
    : `CI fix attempts used ${spent} of ${max} on PR #${d.prNumber}; CI is still failing.`;
  const escalated = await escalateCiRedHead({
    installationId: repo.installationId, repoFullName: d.repoFullName, prNumber: d.prNumber, headSha,
    task: { id: owner.id, title: owner.title, workspaceId: owner.workspaceId, missionId: owner.missionId ?? null, result: owner.result },
    detail,
    missionTitle: disabled ? 'CI failing — retries disabled' : 'CI failing — agent retries exhausted',
    missionMessage: `${owner.title} — ${detail} Needs a human.`,
  });
  return { outcome: escalated ? 'ok' : 'ok:already_escalated' };
};

/** The review handlers plus the CI family: what the composition root registers. */
export function withCiRetryEffects(base: EffectHandlers): EffectHandlers {
  return {
    ...base,
    dispatch_ci_fix: dispatchCiFix,
    escalate_exhaustion: async (e) => (e.payload.family === 'ci'
      ? escalateCiExhaustion(e)
      : (base.escalate_exhaustion ? base.escalate_exhaustion(e) : { outcome: 'skipped:no_handler' })),
  };
}

// Exported for tests.
export const __ciHandlers = { dispatchCiFix, escalateCiExhaustion };
