/**
 * The review loop's halves of the kernel's ports (docs/specs/workflow-state-kernel.md
 * §10.2), owned by the reviews module and reached only through the
 * composition root (`workflowKernelHooks()` in apps/web/src/modules.ts). The
 * handlers (`dispatch_review`, `dispatch_fix`, `post_review`, `mission_note`,
 * `notify`, `cancel_open_attempts`, `push_recovery`, review exhaustion) are the
 * package's (packages/workflow-kernel/src/handlers/review.ts); what is buildd's
 * is here:
 *
 *  - `reviewWork` (`Work`, role `review`): the round's reviewer through
 *    `createReviewerTask` (its own supersession guard and live-reviewer dedupe:
 *    a live reviewer for the head is adopted as the round's), announced, plus
 *    the PR's `review_queued` line. No role that can review answers `no_role`.
 *  - `fixWork` (`Work`, role `fix`): the legacy-shaped fix task under the
 *    ledger row's task id; a dependency bot's PR gets no fix, only a note.
 *  - `reviewsHost` (`Reviews`): a round's reviewer output, the §5.9
 *    composition attestation, a review GitHub refused, the approval's
 *    supersession of the open fix, the escalation notice.
 *  - `reviewEscalate` (`Escalate`, family `review_fix`).
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { missionNotes, missions, tasks, workers, workspaces } from '@buildd/core/db/schema';
import { sqlOrderBy, sqlWhere } from '@buildd/core/db/relational-sql';
import { NO_ROLE, type Escalate, type Reviews } from '@buildd/workflow-kernel/ports';
import type { DeliverySnapshot, RoundSnapshot } from '@buildd/workflow-kernel/types';
import { githubApi } from '@/lib/github';
import { notifyTeamOf } from '@/lib/notify';
import { appendPrActivity, taskActivityUrl } from '@/lib/pr-activity-comment';
import { announceTaskCreated } from '@/lib/dispatch-authority';
import { resolvePolicy, RESOLVE_POLICY_MISSION_COLUMNS } from '@/lib/merge-policy';
import { listWorkspaceRoles } from '@/lib/pr-review-request';
import { pickReviewerRole } from '@/lib/pr-review-status';
import { conformanceManifest } from '@/lib/path-declaration';
import { formatAttemptTitle, reviewerTitle } from '@/lib/task-title';
import { attemptIdentityFrom } from '@/lib/attempt-identity';
import { lineageStamp } from '@/lib/attempt-lineage';
import { isDependencyBotPrContext } from '@/lib/dependency-bot-pr';
import { schedulePrScopeReconcile } from '@/lib/pr-scope-reconcile-trigger';
import { refreshDeltaBase } from '@/lib/integration-refresh';
import type { Exec } from './kernel';
import { ingestFact } from './facts';
import { collectComposition, compositionConstituentBase } from './review-composition';
import { workspaceRepo } from './github-facts';
import { prWorkerWhere } from './pr-worker-where';
import type { WorkBuilder } from './kernel-ports';

const dbExec: Exec = (q) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;

type Output = { verdict?: string; confidence?: number; summary?: string; feedback?: string | null; escalationReason?: string | null };

/** The reviewer's structured output for a round (the raw fact the verdict came from). */
async function roundOutput(round: Pick<RoundSnapshot, 'reviewerTaskId'> | null | undefined): Promise<Output> {
  if (!round?.reviewerTaskId) return {};
  const t = await db.query.tasks.findFirst({ where: sqlWhere(eq(tasks.id, round.reviewerTaskId)), columns: { result: true } });
  const result = (t?.result ?? {}) as Record<string, unknown>;
  const out = result.structuredOutput;
  return out && typeof out === 'object' ? (out as Output) : {};
}

async function prWorker(workspaceId: string, repoFullName: string, prNumber: number) {
  return db.query.workers.findFirst({
    where: sqlWhere(prWorkerWhere(workspaceId, repoFullName, prNumber)),
    columns: { id: true, branch: true, prUrl: true, prBaseRef: true, lastCommitSha: true },
    orderBy: sqlOrderBy([desc(workers.createdAt)]),
  });
}

const reviewOwnerColumns = { id: true, title: true, description: true, backend: true, missionId: true, pathManifest: true, pathDeclaration: true, context: true } as const;

// ── Work, role `review`: one reviewer per round ─────────────────────────────

export const reviewWork: WorkBuilder = async (req) => {
  const { repoFullName } = req.target;
  const prNumber = req.target.prNumber;
  const headSha = req.target.headSha;
  const ownerTaskId = req.lineage.parentTaskId;
  if (prNumber == null || !headSha || !ownerTaskId) return { skipped: 'no_pr' };
  const detail = req.detail ?? {};
  const workspace = await db.query.workspaces.findFirst({ where: sqlWhere(eq(workspaces.id, req.workspaceId)) });
  const owner = await db.query.tasks.findFirst({ where: sqlWhere(eq(tasks.id, ownerTaskId)), columns: reviewOwnerColumns });
  const repo = await workspaceRepo(req.workspaceId);
  const prw = await prWorker(req.workspaceId, repoFullName, prNumber);
  if (!workspace || !owner || !repo) return { skipped: 'missing_context' };
  const mission = owner.missionId
    ? await db.query.missions.findFirst({ where: sqlWhere(eq(missions.id, owner.missionId)), columns: RESOLVE_POLICY_MISSION_COLUMNS })
    : null;
  const baseRef = req.target.baseRef ?? null;
  const policy = resolvePolicy(workspace as never, mission as never, null, { baseRef });
  const roles = await listWorkspaceRoles(workspace.id, workspace.teamId);
  const picked = pickReviewerRole({ requested: null, policyRole: policy.agentReview?.reviewerRole ?? null, available: roles });
  if (!picked.role) return { skipped: NO_ROLE };

  const round = Number(detail.round ?? 1);
  const roundId = String(detail.roundId ?? '');
  const { createReviewerTask } = await import('@/lib/reviewer');
  const created = await createReviewerTask({
    workspaceId: req.workspaceId,
    originalTaskId: owner.id,
    originalTask: {
      title: owner.title, description: owner.description, backend: owner.backend, missionId: owner.missionId ?? null,
      pathManifest: conformanceManifest(owner as never),
      // Display only: the round budget is the delivery's, not this context.
      iteration: round - 1, maxIterations: Number(detail.maxRounds ?? 3),
    },
    worker: { branch: prw?.branch ?? '' },
    prNumber,
    prUrl: prw?.prUrl ?? `https://github.com/${repoFullName}/pull/${prNumber}`,
    headSha,
    reviewerRole: picked.role,
    confidenceThreshold: policy.agentReview?.maxConfidenceThreshold,
    installationId: repo.installationId,
    repoFullName,
    policyConfig: (workspace.gitConfig as { policyConfig?: never } | null)?.policyConfig ?? undefined,
    baseRef,
    priorVerdict: (detail.priorVerdict as import('@/lib/reviewer').PriorVerdict | undefined) ?? undefined,
    compositionScope: (detail.compositionScope as { novelDeltaPaths: string[] } | undefined) ?? undefined,
    workflowRound: { deliveryId: req.lineage.deliveryId, roundId, round },
  });
  if (!created) return { skipped: 'dispatch_refused' };
  if (created.deduplicated) {
    // Another door's live reviewer already covers this head: adopt it as the round's.
    await db.update(tasks)
      .set({
        deliveryId: req.lineage.deliveryId, deliveryRole: 'review',
        context: sql`COALESCE(${tasks.context}, '{}'::jsonb) || jsonb_build_object('workflowRoundId', ${roundId}::text)`,
      })
      .where(and(eq(tasks.id, created.id), sql`${tasks.deliveryId} IS NULL`));
    // Nobody has it yet: maybe never woken (the run that filed it died before linking it), so the kernel wakes it.
    const adopted = await db.query.tasks.findFirst({ where: sqlWhere(eq(tasks.id, created.id)), columns: { status: true } });
    return { filed: { taskId: created.id, created: false, ...(adopted?.status === 'pending' ? { unclaimed: true } : {}) } };
  }
  await announceTaskCreated({
    id: created.id, title: reviewerTitle(prNumber, owner.title), description: null, workspaceId: req.workspaceId,
    missionId: owner.missionId ?? null, backend: owner.backend, roleSlug: picked.role,
  } as never, workspace as never);
  await appendPrActivity({ installationId: repo.installationId, repoFullName, prNumber, entry: { kind: 'review_queued' }, workspaceId: req.workspaceId });
  return { filed: { taskId: created.id, created: true } };
};

// ── Work, role `fix`: the fix task under the ledger row's task id ───────────

const STOP_AND_REPORT =
  'If this turns out to be a misdiagnosis rather than a real defect, stop and report why instead of patching around it.';

/**
 * T23: the fix task a person dispatched from an escalation. Their instructions are the
 * authoritative ask; the reviewer's own words are context below them.
 */
export function humanFixDescription(original: string | null, instructions: string | null, reviewer: string | null): string {
  const sections: string[] = [];
  if (instructions) sections.push('## Instructions from the person who applied this (authoritative)', instructions, '');
  if (reviewer) {
    sections.push(instructions
      ? "## Reviewer's escalation (context; the instructions above take precedence wherever they conflict)"
      : "## Apply the reviewer's recommendation", reviewer, '');
  }
  sections.push(STOP_AND_REPORT, '', '## Original task', original ?? '');
  return sections.join('\n');
}

export const fixWork: WorkBuilder = async (req) => {
  const { repoFullName } = req.target;
  const prNumber = req.target.prNumber;
  const ownerTaskId = req.lineage.parentTaskId;
  if (prNumber == null || !ownerTaskId) return { skipped: 'no_pr' };
  const repo = await workspaceRepo(req.workspaceId);
  if (!repo) throw new Error('no GitHub installation for the workspace');
  const detail = req.detail ?? {};
  const human = detail.trigger === 'human';
  const humanInstructions = typeof detail.humanInstructions === 'string' ? detail.humanInstructions : null;
  const humanActor = typeof detail.actor === 'string' ? detail.actor : null;
  const owner = await db.query.tasks.findFirst({
    where: sqlWhere(eq(tasks.id, ownerTaskId)),
    columns: {
      id: true, title: true, description: true, missionId: true, pathManifest: true, backend: true, roleSlug: true,
      kind: true, complexity: true, missionPhaseIndex: true, missionPhaseLabel: true, context: true,
    },
  });
  if (!owner) return { skipped: 'no_owner' };
  const out = await roundOutput({ reviewerTaskId: typeof detail.reviewerTaskId === 'string' ? detail.reviewerTaskId : null });
  const reviewerFeedback = out.feedback ?? (human ? out.escalationReason : null) ?? out.summary ?? null;
  const feedback = humanInstructions ?? reviewerFeedback ?? 'Reviewer requested changes';
  if (isDependencyBotPrContext(owner.context)) {
    await appendPrActivity({ installationId: repo.installationId, repoFullName, prNumber, entry: { kind: 'review_escalated', detail: 'dependency-bot PR · no fix pushed', note: feedback }, workspaceId: req.workspaceId });
    return { skipped: 'dependency_bot' };
  }
  const prw = await prWorker(req.workspaceId, repoFullName, prNumber);
  const branch = prw?.branch ?? '';
  const lastCommitSha = prw?.lastCommitSha ?? null;
  const headSha = req.target.headSha ?? null;
  const prUrl = prw?.prUrl ?? `https://github.com/${repoFullName}/pull/${prNumber}`;
  const attemptNo = Number(detail.attemptNo ?? 1);
  const maxAttempts = Number(detail.maxAttempts ?? attemptNo);
  return {
    values: {
      workspaceId: req.workspaceId,
      title: formatAttemptTitle('builder', owner.title, { reason: 'after review', iteration: attemptNo }),
      description: human ? humanFixDescription(owner.description, humanInstructions, reviewerFeedback) : owner.description,
      missionId: owner.missionId,
      parentTaskId: owner.id,
      taskClass: 'attempt',
      ...attemptIdentityFrom(owner),
      reviewerRetryPrNumber: prNumber,
      // The (workspace, PR, head) dedupe index allows one row per head; the ledger dedupes a second attempt.
      reviewerRetryHeadSha: detail.firstAtHead ? headSha : null,
      deliveryId: req.lineage.deliveryId,
      deliveryRole: 'fix',
      context: {
        // Display only (attempt N of M): the budget is the ledger row.
        iteration: attemptNo,
        maxIterations: maxAttempts,
        baseBranch: prw?.prBaseRef ?? req.target.baseRef ?? branch,
        resumeBranch: branch,
        ...(lastCommitSha ? { lastCommitSha } : {}),
        failureContext: { summary: feedback, errorType: human ? 'reviewer_escalation_applied' : 'reviewer_request_changes', ...(lastCommitSha ? { commitSha: lastCommitSha } : {}) },
        ...(human ? { trigger: 'human', appliedBy: humanActor, humanInstructions, recommendation: reviewerFeedback } : {}),
        prNumber,
        prUrl,
        workerBranch: branch,
        headSha,
        workflowAttemptId: req.lineage.attemptId,
        workflowRoundId: detail.roundId,
        ...lineageStamp(owner as never, [prNumber]),
      },
      pathManifest: owner.pathManifest,
      release: 'false',
      priority: 8,
      status: 'pending',
      creationSource: human ? 'dashboard' : 'webhook',
    },
    afterFile: async (row) => {
      schedulePrScopeReconcile({ workspaceId: req.workspaceId, installationId: repo.installationId, repoFullName, prNumber, expectedHeadSha: headSha ?? undefined } as never);
      await appendPrActivity({
        installationId: repo.installationId, repoFullName, prNumber,
        entry: { kind: 'review_changes_requested', iteration: attemptNo, maxIterations: maxAttempts, note: feedback, taskUrl: taskActivityUrl(row.id), taskTitle: row.title },
        workspaceId: req.workspaceId,
      });
    },
  };
};

// ── Reviews ─────────────────────────────────────────────────────────────────

/**
 * Attest a composed PR's head before its review is dispatched (§5.9). Returns
 * the effect outcome when the attestation took the round (no reviewer for it
 * now), or null to fall through to the normal full review: an ordinary PR, an
 * unverifiable composition, or a rejected one all review in full.
 */
async function attestComposition(d: DeliverySnapshot, round: RoundSnapshot): Promise<string | null> {
  if (!d.repoFullName || d.prNumber == null || round.headSha !== d.currentHeadSha) return null;
  const [workspace, owner, repo] = await Promise.all([
    db.query.workspaces.findFirst({ where: sqlWhere(eq(workspaces.id, d.workspaceId)) }),
    db.query.tasks.findFirst({ where: sqlWhere(eq(tasks.id, d.ownerTaskId)), columns: reviewOwnerColumns }),
    workspaceRepo(d.workspaceId),
  ]);
  if (!workspace || !owner || !repo) return null;
  const mission = owner.missionId
    ? await db.query.missions.findFirst({ where: sqlWhere(eq(missions.id, owner.missionId)), columns: RESOLVE_POLICY_MISSION_COLUMNS })
    : null;
  const refreshTrunkOfOwner = refreshDeltaBase(owner.context, (workspace.gitConfig ?? null) as never);
  try {
    const pull = (await githubApi(repo.installationId, `/repos/${d.repoFullName}/pulls/${d.prNumber}`)) as {
      head?: { ref?: string; sha?: string; repo?: { full_name?: string } | null };
      base?: { ref?: string; repo?: { full_name?: string } | null };
      user?: { login?: string } | null;
      body?: string | null;
    } | null;
    // The live head first: an attestation computed against a head the PR has
    // already moved past proves nothing about what would merge. A mismatch (or
    // an unreadable head) attests nothing; the head webhook / floor re-rounds it.
    const liveHead = pull?.head?.sha ?? null;
    if (liveHead !== round.headSha) {
      console.log(`[workflow] composition of ${d.repoFullName}#${d.prNumber} skipped: live head ${liveHead?.slice(0, 12) ?? 'unreadable'} is not the round's ${round.headSha.slice(0, 12)}; full review`);
      return null;
    }
    const headRef = pull?.head?.ref ?? null;
    const baseRef = pull?.base?.ref ?? d.baseRef;
    if (!headRef || !baseRef) return null;
    const missionWorkingBranch = (mission as { workingBranch?: string | null } | null)?.workingBranch ?? null;
    // A frozen release candidate is recognised only with its provenance (the
    // author, the release workflow's metadata, and that metadata naming this
    // exact head): a hand-made release/v* branch reviews in full.
    const constituentBase = compositionConstituentBase({
      headRef, baseRef, missionWorkingBranch, releaseConfig: (workspace.releaseConfig ?? null) as never, refreshTrunk: refreshTrunkOfOwner,
      pr: {
        headSha: liveHead,
        author: pull?.user?.login ?? null,
        headRepoFullName: pull?.head?.repo?.full_name ?? null,
        baseRepoFullName: pull?.base?.repo?.full_name ?? null,
        body: pull?.body ?? null,
      },
    });
    if (!constituentBase) return null;
    // A refresh PR is composed from trunk's PRs; a PR from the mission branch (its integration PR) is not a refresh.
    const refreshTrunk = refreshTrunkOfOwner && missionWorkingBranch && baseRef === missionWorkingBranch.trim() ? refreshTrunkOfOwner : null;
    const built = await collectComposition({
      api: githubApi, exec: dbExec, installationId: repo.installationId, workspaceId: d.workspaceId,
      repoFullName: d.repoFullName, prNumber: d.prNumber, baseRef, headRef, aggregateHeadSha: round.headSha, refreshTrunk,
      constituentBase: refreshTrunk ? null : constituentBase,
    });
    if (built.attestation.novelDelta.result === 'unverifiable') {
      console.log(`[workflow] composition of ${d.repoFullName}#${d.prNumber} unverifiable (${built.attestation.novelDelta.reason}); full review`);
      return null;
    }
    const res = await ingestFact(
      { kind: 'composition_attested', workspaceId: d.workspaceId, source: 'effect:dispatch_review', attestation: built.attestation },
      { exec: dbExec },
    );
    if (res.result !== 'applied' && res.result !== 'duplicate') {
      console.log(`[workflow] composition of ${d.repoFullName}#${d.prNumber} not accepted: ${(res as { reason?: string }).reason ?? res.result}; full review`);
      return null;
    }
    return built.attestation.novelDelta.result === 'none' ? 'ok:composition_attested' : 'skipped:composition_delta';
  } catch (err) {
    console.warn(`[workflow] composition check failed for ${d.repoFullName}#${d.prNumber}; full review:`, err instanceof Error ? err.message : err);
    return null;
  }
}

export const reviewsHost: Reviews = {
  output: (round) => roundOutput(round),
  attestComposition,
  async postFailed(d, p) {
    const owner = await db.query.tasks.findFirst({ where: sqlWhere(eq(tasks.id, d.ownerTaskId)), columns: { missionId: true } });
    if (!owner?.missionId) return;
    await db.insert(missionNotes).values({
      missionId: owner.missionId, taskId: d.ownerTaskId, authorType: 'system', type: 'warning',
      title: `Reviewer verdict could not be posted to GitHub for PR #${d.prNumber}`,
      body: `buildd recorded a ${p.event === 'APPROVE' ? 'approve' : 'request-changes'} verdict, but posting it to GitHub as a review failed: ${p.reason}`,
      status: 'open',
    });
  },
  async supersedeFixOnApproval(d) {
    const repo = await workspaceRepo(d.workspaceId);
    if (!repo || !d.repoFullName || d.prNumber == null) return;
    const { supersedeFixTaskOnApproval } = await import('@/lib/reviewer');
    await supersedeFixTaskOnApproval({ originalTaskId: d.ownerTaskId, workspaceId: d.workspaceId, installationId: repo.installationId, repoFullName: d.repoFullName, prNumber: d.prNumber });
  },
  async escalated(d, round) {
    if (!d.repoFullName || d.prNumber == null) return;
    const out = await roundOutput(round);
    const reviewer = round?.reviewerTaskId
      ? await db.query.tasks.findFirst({ where: sqlWhere(eq(tasks.id, round.reviewerTaskId)), columns: { result: true } })
      : null;
    const overrideReason = ((reviewer?.result ?? {}) as { effectiveVerdictReason?: string }).effectiveVerdictReason ?? null;
    const message = overrideReason ?? out.escalationReason ?? out.summary ?? 'see the review';
    const prUrl = `https://github.com/${d.repoFullName}/pull/${d.prNumber}`;
    void notifyTeamOf({ workspaceId: d.workspaceId, prNumber: d.prNumber }, 'needsAttention', { title: `PR #${d.prNumber} escalated by reviewer`, message, url: prUrl, urlTitle: 'View PR' });
    const repo = await workspaceRepo(d.workspaceId);
    if (repo) {
      await appendPrActivity({ installationId: repo.installationId, repoFullName: d.repoFullName, prNumber: d.prNumber, entry: { kind: 'review_escalated', note: message }, workspaceId: d.workspaceId });
    }
  },
};

/** `Escalate` for family `review_fix`: the CAS-deduped legacy helper, and the PR's activity line. */
export const reviewEscalate: Escalate = {
  async exhausted(d, n) {
    if (n.family !== 'review_fix') throw new Error(`no escalation for family ${n.family}`);
    if (!d.repoFullName || d.prNumber == null) return 'skipped:no_pr';
    const { escalateReviewerExhaustion } = await import('@/lib/auto-merge');
    await escalateReviewerExhaustion(d.ownerTaskId, d.repoFullName, d.prNumber, n.headSha, d.maxRounds, n.note ?? null);
    const repo = await workspaceRepo(d.workspaceId);
    if (repo) {
      await appendPrActivity({
        installationId: repo.installationId, repoFullName: d.repoFullName, prNumber: d.prNumber,
        entry: { kind: 'review_escalated', detail: n.detail, note: n.note ?? null },
        workspaceId: d.workspaceId,
      });
    }
    return 'ok';
  },
};
