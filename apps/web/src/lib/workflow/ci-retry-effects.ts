/**
 * The CI family's halves of the kernel's ports (docs/specs/workflow-state-kernel.md
 * §5.7, §10.2, §10.5), owned by the reviews module and reached only through
 * the composition root (`workflowKernelHooks()` in apps/web/src/modules.ts).
 * The handlers (`dispatch_ci_fix`, `capture_ci_evidence`, `escalate_exhaustion`
 * for family `ci`) are the package's (packages/workflow-kernel/src/handlers/ci.ts):
 * they revalidate against a live read, file through `Work` under the ledger
 * row's id, bind the row and wake the task. What is buildd's is here:
 *
 *  - `ciFixWork` (`Work`, role `ci_fix`): the legacy-shaped CI fix, or the
 *    schema-drift diagnose task, from the run's failure logs, plus the PR's
 *    `ci_fixing` activity line. The job log it names is owed as evidence.
 *  - `ciEvidence` (`Evidence`): stores that job log (`captureCiJobLogEvidence`),
 *    now an effect of its own instead of work after the response.
 *  - `ciEscalate` (`Escalate`, family `ci`): a person owns the red PR.
 */
import { desc, eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks, workers, workspaces } from '@buildd/core/db/schema';
import { sqlOrderBy, sqlWhere } from '@buildd/core/db/relational-sql';
import type { Escalate, Evidence } from '@buildd/workflow-kernel/ports';
import { appendPrActivity, taskActivityUrl } from '@/lib/pr-activity-comment';
import { fetchCIFailureLogs } from '@/lib/ci-failure-inspect';
import { buildCIRetryTask } from '@/lib/ci-retry';
import { buildDriftDiagnoseTask, isSchemaDriftFailure } from '@/lib/ci-drift-diagnose';
import { inheritAttemptIdentity } from '@/lib/attempt-identity';
import { captureCiJobLogEvidence } from '@/lib/ci-job-log-evidence';
import { escalateCiRedHead } from '@/lib/ci-failure-retry';
import { prWorkerWhere } from './pr-worker-where';
import { workspaceRepo } from './github-facts';
import type { WorkBuilder } from './kernel-ports';

async function prWorker(workspaceId: string, repoFullName: string, prNumber: number) {
  return db.query.workers.findFirst({
    where: sqlWhere(prWorkerWhere(workspaceId, repoFullName, prNumber)),
    columns: { id: true, branch: true, prUrl: true, prNumber: true },
    orderBy: sqlOrderBy([desc(workers.createdAt)]),
  });
}

/** `Work` for role `ci_fix`: the task the kernel's `dispatch_ci_fix` files under the ledger row's id. */
export const ciFixWork: WorkBuilder = async (req) => {
  const { repoFullName } = req.target;
  const prNumber = req.target.prNumber;
  const headSha = req.target.headSha;
  const ownerTaskId = req.lineage.parentTaskId;
  if (prNumber == null || !headSha || !ownerTaskId) return { skipped: 'no_pr' };
  const detail = req.detail ?? {};
  const [owner, workspace, prw, repo] = await Promise.all([
    db.query.tasks.findFirst({ where: sqlWhere(eq(tasks.id, ownerTaskId)) }),
    db.query.workspaces.findFirst({ where: sqlWhere(eq(workspaces.id, req.workspaceId)) }),
    prWorker(req.workspaceId, repoFullName, prNumber),
    workspaceRepo(req.workspaceId),
  ]);
  if (!owner || !workspace) return { skipped: 'missing_context' };
  if (!repo) throw new Error('no GitHub installation for the workspace');
  const ciLogs = await fetchCIFailureLogs(repo.installationId, repoFullName, headSha);
  const failureContext = ciLogs.summary || `CI check suite failed on ${repoFullName} PR #${prNumber} (SHA: ${headSha})`;
  const human = detail.trigger === 'human';
  const attemptNo = Number(detail.attemptNo ?? 1);
  const maxAttempts = Number(detail.maxAttempts ?? attemptNo);
  const branch = prw?.branch ?? '';
  const identity = await inheritAttemptIdentity(owner.id);
  const kernelContext = { workflowAttemptId: req.lineage.attemptId, prNumber, headSha };
  const drift = isSchemaDriftFailure(ciLogs.failedJobNames);

  const built = drift
    ? buildDriftDiagnoseTask({
      originalTask: { id: owner.id, title: owner.title, workspaceId: owner.workspaceId, missionId: owner.missionId ?? null },
      repoFullName, prNumber, headSha, failureContext, ciRunUrl: ciLogs.runUrl,
    })
    : buildCIRetryTask({
      originalTask: {
        id: owner.id, title: owner.title, description: owner.description, workspaceId: owner.workspaceId,
        context: (owner.context as Record<string, unknown> | null) ?? {}, missionId: owner.missionId ?? null,
      },
      worker: { id: prw?.id ?? '', branch, prNumber },
      failureContext,
      repoFullName,
      ciRunId: ciLogs.runId,
      ciFailedJobId: ciLogs.failedJobId,
      ciRunUrl: ciLogs.runUrl,
      // Display only: "attempt N of M" from the ledger row (§5.7 rule 4).
      attemptsUsed: attemptNo - 1,
      workspaceMaxCiRetries: Math.max(maxAttempts, attemptNo),
    });
  if (!built) return { skipped: 'not_buildable' };

  return {
    workspace,
    values: {
      workspaceId: built.workspaceId,
      title: built.title,
      description: built.description,
      parentTaskId: built.parentTaskId,
      ...identity,
      ciRetryPrNumber: prNumber,
      // One row per (workspace, PR, head) in the legacy dedupe index; a second attempt on the
      // same head (the first one failed without pushing) is deduped by the ledger instead.
      ciRetryHeadSha: detail.firstAtHead ? headSha : null,
      missionId: built.missionId,
      context: { ...built.context, ...kernelContext },
      creationSource: human ? 'dashboard' : 'webhook',
      taskClass: built.taskClass,
      ...('outputRequirement' in built ? { outputRequirement: (built as { outputRequirement?: string }).outputRequirement } : {}),
      deliveryId: req.lineage.deliveryId,
      deliveryRole: 'ci_fix',
      status: 'pending',
      priority: human ? 8 : 7,
    },
    // Either an earlier run filed it (a crash before the link) or another index refused it.
    refused: 'CI fix task not filed: another CI retry is still pending on this PR',
    variant: drift ? 'diagnose' : undefined,
    evidence: { failedJobId: ciLogs.failedJobId, parentTaskId: owner.id, workerId: prw?.id ?? '', prNumber, repoFullName },
    afterFile: async (row) => {
      await appendPrActivity({
        installationId: repo.installationId, repoFullName, prNumber,
        entry: drift
          ? { kind: 'ci_fixing', detail: 'schema drift · diagnose only', url: ciLogs.runUrl, taskUrl: taskActivityUrl(row.id) }
          : { kind: 'ci_fixing', iteration: attemptNo, maxIterations: maxAttempts, ...(human ? { detail: 'manual' } : {}), url: ciLogs.runUrl, taskUrl: taskActivityUrl(row.id) },
        workspaceId: req.workspaceId,
      });
    },
  };
};

/** `Evidence` for the CI fix's failed job log (the payload `ciFixWork` owed, plus the task). */
export const ciEvidence: Evidence = {
  async capture(p) {
    if (p.kind !== 'ci_job_log') return { status: 'skipped', record: { reason: `no capture for ${p.kind}` } };
    const repo = await workspaceRepo(p.workspaceId);
    if (!repo) return { status: 'skipped', record: { reason: 'no GitHub installation for the workspace' } };
    const x = p.payload;
    const r = await captureCiJobLogEvidence({
      installationId: repo.installationId,
      repoFullName: String(x.repoFullName ?? ''),
      failedJobId: typeof x.failedJobId === 'number' ? x.failedJobId : null,
      workspaceId: p.workspaceId,
      retryTaskId: String(x.taskId ?? ''),
      parentTaskId: String(x.parentTaskId ?? ''),
      workerId: String(x.workerId ?? ''),
      prNumber: typeof x.prNumber === 'number' ? x.prNumber : null,
    });
    if (r.status === 'stored') return { status: 'stored', record: { objectKey: r.objectKey, bytes: r.bytes } };
    return { status: r.status, record: r.status === 'failed' ? { error: r.error } : { reason: r.reason } };
  },
};

/** `Escalate` for family `ci`: the owner task, a notice and a mission note (`escalateCiRedHead`). */
export const ciEscalate: Escalate = {
  async exhausted(d, n) {
    if (n.family !== 'ci') throw new Error(`no escalation for family ${n.family}`);
    if (!d.repoFullName || d.prNumber == null) return 'skipped:no_pr';
    const repo = await workspaceRepo(d.workspaceId);
    if (!repo) return 'skipped:no_installation';
    const owner = await db.query.tasks.findFirst({ where: sqlWhere(eq(tasks.id, d.ownerTaskId)), columns: { id: true, title: true, workspaceId: true, missionId: true, result: true } });
    if (!owner) return 'skipped:no_owner';
    const escalated = await escalateCiRedHead({
      installationId: repo.installationId, repoFullName: d.repoFullName, prNumber: d.prNumber, headSha: n.headSha,
      task: { id: owner.id, title: owner.title, workspaceId: owner.workspaceId, missionId: owner.missionId ?? null, result: owner.result },
      detail: n.detail,
      missionTitle: n.title,
      missionMessage: `${owner.title} — ${n.detail} Needs a human.`,
    });
    return escalated ? 'ok' : 'ok:already_escalated';
  },
};
