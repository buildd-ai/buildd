/**
 * Effect handlers for the fix-loop seam (docs/specs/workflow-state-kernel.md
 * §10.2), owned by the reviews module: they create reviewer and fix tasks,
 * post GitHub reviews and raise review escalations. Core reaches them only
 * through the composition root (`workflowEffectHandlers()` in
 * apps/web/src/modules.ts), never by import. Each one is idempotent: the outbox delivers at least once, so every
 * handler re-reads the delivery and acts only on what is still owed.
 *
 * Effects owned by later slices (trunk repair) are acknowledged
 * `skipped:legacy_owns`: the legacy code still runs them, and a transition
 * that names them must not make the outbox retry forever.
 */
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { prWorkerWhere } from './pr-worker-where';
import { randomUUID } from 'node:crypto';
import { db } from '@buildd/core/db';
import { missionNotes, missions, tasks, workers, workspaces } from '@buildd/core/db/schema';
import { githubApi, postPrReview } from '@/lib/github';
import { notifyTeamOf } from '@/lib/notify';
import { appendPrActivity, taskActivityUrl } from '@/lib/pr-activity-comment';
import { announceTaskCreated, wakeTask } from '@/lib/dispatch-authority';
import { resolvePolicy, RESOLVE_POLICY_MISSION_COLUMNS } from '@/lib/merge-policy';
import { listWorkspaceRoles } from '@/lib/pr-review-request';
import { pickReviewerRole } from '@/lib/pr-review-status';
import { conformanceManifest } from '@/lib/path-declaration';
import { formatAttemptTitle, reviewerTitle } from '@/lib/task-title';
import { attemptIdentityFrom } from '@/lib/attempt-identity';
import { lineageStamp } from '@/lib/attempt-lineage';
import { isDependencyBotPrContext } from '@/lib/dependency-bot-pr';
import { schedulePrScopeReconcile } from '@/lib/pr-scope-reconcile-trigger';
import type { EffectKind } from './commands';
import type { ClaimedEffect, EffectHandler, EffectHandlers } from './effects';
import { insertFollowupEffectSql } from './effects';
import { applyCommand, loadView, type Exec } from './kernel';
import { ingestFact } from './facts';
import { collectComposition, isCompositionPr } from './review-composition';
import { githubReader, workspaceRepo } from './github-facts';
import type { KernelView, RoundSnapshot } from './types';

const dbExec: Exec = (q) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;

type Output = { verdict?: string; confidence?: number; summary?: string; feedback?: string | null; escalationReason?: string | null };

/** The reviewer's structured output for a round (the raw fact the verdict came from). */
async function roundOutput(round: RoundSnapshot | undefined): Promise<Output> {
  if (!round?.reviewerTaskId) return {};
  const t = await db.query.tasks.findFirst({ where: eq(tasks.id, round.reviewerTaskId), columns: { result: true } });
  const result = (t?.result ?? {}) as Record<string, unknown>;
  const out = result.structuredOutput;
  return out && typeof out === 'object' ? (out as Output) : {};
}

async function prWorker(workspaceId: string, repoFullName: string, prNumber: number) {
  return db.query.workers.findFirst({
    where: prWorkerWhere(workspaceId, repoFullName, prNumber),
    columns: { id: true, branch: true, prUrl: true, prBaseRef: true, lastCommitSha: true },
    orderBy: [desc(workers.createdAt)],
  });
}

async function viewFor(e: ClaimedEffect): Promise<KernelView> {
  return loadView({ deliveryId: e.deliveryId }, dbExec);
}

const legacyOwns: EffectHandler = async () => ({ outcome: 'skipped:legacy_owns' });

/** Pending reviewer/fix tasks of this delivery that a newer decision made pointless. */
async function cancelPendingAttemptTasks(deliveryId: string, role: 'review' | 'fix' | 'ci_fix' | 'conflict_fix', keepTaskId: string | null, reason: string): Promise<number> {
  const rows = await db.update(tasks)
    .set({
      status: 'cancelled',
      result: sql`COALESCE(${tasks.result}, '{}'::jsonb) || jsonb_build_object('skipped', true, 'skipReason', ${reason}::text, 'summary', ${`Superseded before it started: ${reason}`}::text)`,
      updatedAt: new Date(),
    })
    .where(and(
      eq(tasks.deliveryId, deliveryId),
      eq(tasks.deliveryRole, role),
      eq(tasks.status, 'pending'),
      ...(keepTaskId ? [ne(tasks.id, keepTaskId)] : []),
    ))
    .returning({ id: tasks.id });
  return rows.length;
}

// ── dispatch_review: one reviewer task per round ────────────────────────────

/** The novel-delta scope a composition delta round carries, for the reviewer prompt. */
function compositionScopeOf(round: RoundSnapshot): { novelDeltaPaths: string[] } | undefined {
  const sc = round.scope;
  if (!sc?.composition || !Array.isArray(sc.novelDeltaPaths)) return undefined;
  return { novelDeltaPaths: (sc.novelDeltaPaths as unknown[]).map(String) };
}

/**
 * Attest a composed PR's head before its review is dispatched (§5.9). Returns
 * the effect outcome when the attestation took the round (no reviewer for it
 * now), or null to fall through to the normal full review: an ordinary PR, an
 * unverifiable composition, or a rejected one all review in full.
 */
async function tryCompositionAttestation(p: {
  d: NonNullable<KernelView['delivery']>;
  round: RoundSnapshot;
  mission: { workingBranch?: string | null } | null | undefined;
  workspace: { releaseConfig?: unknown };
  repo: { installationId: number };
}): Promise<string | null> {
  const { d, round } = p;
  if (!d.repoFullName || d.prNumber == null || round.headSha !== d.currentHeadSha) return null;
  try {
    const pull = (await githubApi(p.repo.installationId, `/repos/${d.repoFullName}/pulls/${d.prNumber}`)) as { head?: { ref?: string; sha?: string }; base?: { ref?: string } } | null;
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
    if (!isCompositionPr({ headRef, baseRef, missionWorkingBranch: p.mission?.workingBranch ?? null, releaseConfig: (p.workspace.releaseConfig ?? null) as never })) return null;
    const built = await collectComposition({
      api: githubApi, exec: dbExec, installationId: p.repo.installationId, workspaceId: d.workspaceId,
      repoFullName: d.repoFullName, prNumber: d.prNumber, baseRef, headRef, aggregateHeadSha: round.headSha,
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

const dispatchReview: EffectHandler = async (e) => {
  const view = await viewFor(e);
  const d = view.delivery;
  const roundId = String(e.payload.roundId ?? '');
  const round = view.rounds.find((r) => r.id === roundId);
  if (!d || !round || (round.status !== 'queued' && round.status !== 'reviewing')) return { outcome: 'skipped:round_closed' };
  if (round.reviewerTaskId) return { outcome: 'skipped:already_dispatched' };
  if (!d.repoFullName || d.prNumber == null) return { outcome: 'skipped:no_pr' };

  const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, d.workspaceId) });
  const owner = await db.query.tasks.findFirst({
    where: eq(tasks.id, d.ownerTaskId),
    columns: { id: true, title: true, description: true, backend: true, missionId: true, pathManifest: true, pathDeclaration: true },
  });
  const repo = await workspaceRepo(d.workspaceId);
  const prw = await prWorker(d.workspaceId, d.repoFullName, d.prNumber);
  if (!workspace || !owner || !repo) return { outcome: 'skipped:missing_context' };

  const mission = owner.missionId
    ? await db.query.missions.findFirst({ where: eq(missions.id, owner.missionId), columns: RESOLVE_POLICY_MISSION_COLUMNS })
    : null;
  // §5.9: a composed PR (mission integration PR, release PR) whose commits are
  // all already-reviewed changes needs no second full review. Runs once per
  // round that is not itself the composition's delta round.
  if (!round.scope?.composition) {
    const composed = await tryCompositionAttestation({ d, round, mission, workspace, repo });
    if (composed) return { outcome: composed };
  }

  const policy = resolvePolicy(workspace as never, mission as never, null, { baseRef: d.baseRef });
  const roles = await listWorkspaceRoles(workspace.id, workspace.teamId);
  const picked = pickReviewerRole({ requested: null, policyRole: policy.agentReview?.reviewerRole ?? null, available: roles });
  if (!picked.role) {
    // No role can run the review: the round cannot be served (T27 → review_unavailable).
    await applyCommand({ type: 'ReviewRoundFailed', actor: 'kernel', roundId, reason: 'infra', maxContractRetries: 0 }, { ref: { deliveryId: d.id }, exec: dbExec });
    return { outcome: 'skipped:no_reviewer_role' };
  }

  // A delta round reviews the change since the last decided verdict.
  let priorVerdict: import('@/lib/reviewer').PriorVerdict | undefined;
  if (round.kind === 'delta') {
    const prior = view.rounds.filter((r) => r.status === 'decided' && r.round < round.round).sort((a, b) => b.round - a.round)[0];
    if (prior && prior.headSha !== round.headSha) {
      const out = await roundOutput(prior);
      if (out.verdict === 'request-changes' || out.verdict === 'escalate' || out.verdict === 'approve') {
        priorVerdict = {
          headSha: prior.headSha, verdict: out.verdict as never, confidence: out.confidence ?? 0,
          summary: out.summary ?? '', feedback: out.feedback ?? null, escalationReason: out.escalationReason ?? null,
        };
      }
    }
  }

  const { createReviewerTask } = await import('@/lib/reviewer');
  const prUrl = prw?.prUrl ?? `https://github.com/${d.repoFullName}/pull/${d.prNumber}`;
  const created = await createReviewerTask({
    workspaceId: d.workspaceId,
    originalTaskId: owner.id,
    originalTask: {
      title: owner.title, description: owner.description, backend: owner.backend, missionId: owner.missionId ?? null,
      pathManifest: conformanceManifest(owner as never),
      // Display only: the round budget is the delivery's, not this context.
      iteration: round.round - 1, maxIterations: d.maxRounds,
    },
    worker: { branch: prw?.branch ?? '' },
    prNumber: d.prNumber,
    prUrl,
    headSha: round.headSha,
    reviewerRole: picked.role,
    confidenceThreshold: policy.agentReview?.maxConfidenceThreshold,
    installationId: repo.installationId,
    repoFullName: d.repoFullName,
    policyConfig: (workspace.gitConfig as { policyConfig?: never } | null)?.policyConfig ?? undefined,
    baseRef: d.baseRef,
    priorVerdict,
    compositionScope: compositionScopeOf(round),
    workflowRound: { deliveryId: d.id, roundId: round.id, round: round.round },
  });
  if (!created) return { outcome: 'skipped:dispatch_refused' };

  if (created.deduplicated) {
    // Another door's live reviewer already covers this head: adopt it as the round's.
    await db.update(tasks)
      .set({
        deliveryId: d.id, deliveryRole: 'review',
        context: sql`COALESCE(${tasks.context}, '{}'::jsonb) || jsonb_build_object('workflowRoundId', ${round.id}::text)`,
      })
      .where(and(eq(tasks.id, created.id), sql`${tasks.deliveryId} IS NULL`));
  }
  await dbExec(sql`-- workflow:link_round_reviewer
UPDATE workflow_review_rounds SET reviewer_task_id = ${created.id}::uuid, updated_at = now()
WHERE id = ${round.id}::uuid AND reviewer_task_id IS NULL`);
  await cancelPendingAttemptTasks(d.id, 'review', created.id, `round ${round.round} superseded it`);

  if (!created.deduplicated) {
    await announceTaskCreated({
      id: created.id, title: reviewerTitle(d.prNumber, owner.title), description: null, workspaceId: d.workspaceId,
      missionId: owner.missionId ?? null, backend: owner.backend, roleSlug: picked.role,
    } as never, workspace as never);
    await wakeTask(created.id, 'task.created');
    await appendPrActivity({ installationId: repo.installationId, repoFullName: d.repoFullName, prNumber: d.prNumber, entry: { kind: 'review_queued' }, workspaceId: d.workspaceId });
  }
  return { outcome: created.deduplicated ? 'ok:adopted_live_reviewer' : 'ok' };
};

// ── dispatch_fix: T8 then the fix task ──────────────────────────────────────

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

const dispatchFix: EffectHandler = async (e) => {
  let view = await viewFor(e);
  const d = view.delivery;
  if (!d || d.state !== 'CHANGES_REQUESTED') return { outcome: 'skipped:state_moved' };
  if (!d.repoFullName || d.prNumber == null) return { outcome: 'skipped:no_pr' };
  const roundId = (e.payload.roundId as string | null) ?? view.rounds.find((r) => r.round === d.currentRound)?.id ?? null;
  const round = view.rounds.find((r) => r.id === roundId);
  if (!round) return { outcome: 'skipped:no_round' };
  const repo = await workspaceRepo(d.workspaceId);
  if (!repo) throw new Error('no GitHub installation for the workspace');

  // T23: a person's apply/request-changes on an escalation (§5.7 rule 5, trigger=human).
  const human = e.payload.trigger === 'human';
  const humanInstructions = typeof e.payload.humanInstructions === 'string' && e.payload.humanInstructions.trim()
    ? e.payload.humanInstructions.trim() : null;
  const humanActor = typeof e.payload.actor === 'string' ? e.payload.actor : null;
  const openFix = () => view.attempts.find((a) => a.family === 'review_fix' && a.triggerReason === round.id && (a.status === 'queued' || a.status === 'running'));
  let attempt = openFix();
  if (!attempt) {
    const live = await githubReader(repo.installationId).readPr(d.repoFullName, d.prNumber);
    if (!live) throw new Error('live PR read failed');
    const newerApprove = view.rounds.some((r) => r.round > round.round && r.status === 'decided' && r.effectiveVerdict === 'approve');
    const res = await applyCommand({
      type: 'FixDispatched', actor: 'kernel', roundId: round.id, taskId: randomUUID(), maxAttempts: d.maxRounds,
      ...(human ? { trigger: 'human' as const } : {}),
      revalidation: { live, newerApprove },
    }, { ref: { deliveryId: d.id }, exec: dbExec });
    if (res.result === 'rejected' || res.result === 'stale') return { outcome: `skipped:${res.reason}` };
    // A spent fix ledger escalates in T8 itself (67d34094): no task to file.
    if (res.result === 'applied' && res.decision?.toState === 'ESCALATED') return { outcome: 'ok:escalated_budget_exhausted' };
    view = await loadView({ deliveryId: d.id }, dbExec);
    attempt = openFix();
    if (!attempt) return { outcome: 'skipped:no_open_attempt' };
  }
  const taskId = attempt.taskId;
  if (!taskId) return { outcome: 'skipped:attempt_has_no_task' };
  const existing = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId), columns: { id: true } });
  if (existing) return { outcome: 'ok:task_exists' };

  const owner = await db.query.tasks.findFirst({
    where: eq(tasks.id, d.ownerTaskId),
    columns: {
      id: true, title: true, description: true, missionId: true, pathManifest: true, backend: true, roleSlug: true,
      kind: true, complexity: true, missionPhaseIndex: true, missionPhaseLabel: true, context: true,
    },
  });
  if (!owner) return { outcome: 'skipped:no_owner' };
  const out = await roundOutput(round);
  const reviewerFeedback = out.feedback ?? (human ? out.escalationReason : null) ?? out.summary ?? null;
  const feedback = humanInstructions ?? reviewerFeedback ?? 'Reviewer requested changes';
  if (isDependencyBotPrContext(owner.context)) {
    await appendPrActivity({ installationId: repo.installationId, repoFullName: d.repoFullName, prNumber: d.prNumber, entry: { kind: 'review_escalated', detail: 'dependency-bot PR · no fix pushed', note: feedback }, workspaceId: d.workspaceId });
    return { outcome: 'skipped:dependency_bot' };
  }
  const prw = await prWorker(d.workspaceId, d.repoFullName, d.prNumber);
  const branch = prw?.branch ?? '';
  const lastCommitSha = prw?.lastCommitSha ?? null;
  // The (workspace, PR, head) dedupe index allows one row per head; a second
  // attempt on the same head (the first one failed) is deduped by the ledger.
  const firstAtHead = view.attempts.filter((a) => a.family === 'review_fix' && a.boundHeadSha === attempt!.boundHeadSha).length <= 1;
  const prUrl = prw?.prUrl ?? `https://github.com/${d.repoFullName}/pull/${d.prNumber}`;

  const [fixTask] = await db.insert(tasks).values({
    id: taskId,
    workspaceId: d.workspaceId,
    title: formatAttemptTitle('builder', owner.title, { reason: 'after review', iteration: attempt.attemptNo }),
    description: human ? humanFixDescription(owner.description, humanInstructions, reviewerFeedback) : owner.description,
    missionId: owner.missionId,
    parentTaskId: owner.id,
    taskClass: 'attempt',
    ...attemptIdentityFrom(owner),
    reviewerRetryPrNumber: d.prNumber,
    reviewerRetryHeadSha: firstAtHead ? attempt.boundHeadSha : null,
    deliveryId: d.id,
    deliveryRole: 'fix',
    context: {
      // Display only (attempt N of M): the budget is the ledger row.
      iteration: attempt.attemptNo,
      maxIterations: attempt.maxAttempts,
      baseBranch: prw?.prBaseRef ?? d.baseRef ?? branch,
      resumeBranch: branch,
      ...(lastCommitSha ? { lastCommitSha } : {}),
      failureContext: { summary: feedback, errorType: human ? 'reviewer_escalation_applied' : 'reviewer_request_changes', ...(lastCommitSha ? { commitSha: lastCommitSha } : {}) },
      ...(human ? { trigger: 'human', appliedBy: humanActor, humanInstructions, recommendation: reviewerFeedback } : {}),
      prNumber: d.prNumber,
      prUrl,
      workerBranch: branch,
      headSha: attempt.boundHeadSha,
      workflowAttemptId: attempt.id,
      workflowRoundId: round.id,
      ...lineageStamp(owner as never, [d.prNumber]),
    },
    pathManifest: owner.pathManifest,
    release: 'false',
    priority: 8,
    status: 'pending',
    creationSource: human ? 'dashboard' : 'webhook',
  } as never).onConflictDoNothing().returning();
  if (!fixTask) return { outcome: 'ok:task_exists' };

  const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, d.workspaceId) });
  if (workspace) await announceTaskCreated(fixTask as never, workspace as never);
  await wakeTask(fixTask.id, 'review.fix_requested');
  schedulePrScopeReconcile({ workspaceId: d.workspaceId, installationId: repo.installationId, repoFullName: d.repoFullName, prNumber: d.prNumber, expectedHeadSha: attempt.boundHeadSha ?? undefined } as never);
  await appendPrActivity({
    installationId: repo.installationId, repoFullName: d.repoFullName, prNumber: d.prNumber,
    entry: { kind: 'review_changes_requested', iteration: attempt.attemptNo, maxIterations: attempt.maxAttempts, note: feedback, taskUrl: taskActivityUrl(fixTask.id), taskTitle: fixTask.title },
    workspaceId: d.workspaceId,
  });
  return { outcome: 'ok' };
};

// ── post_review: the GitHub review, at the round's own commit ───────────────

/**
 * The GitHub review body. A composition delta round (§5.9, S33) reviewed only
 * the release-only paths, so its approval says so: it is not a reviewer
 * verdict on the whole release.
 */
export function postReviewBody(
  event: 'APPROVE' | 'REQUEST_CHANGES',
  out: { confidence?: number | null; summary?: string | null; feedback?: string | null },
  scope: unknown,
): string {
  if (event !== 'APPROVE') return `Changes requested by buildd reviewer: ${out.feedback ?? out.summary ?? ''}`;
  const sc = scope as { compositionDelta?: unknown; paths?: unknown } | null | undefined;
  if (sc?.compositionDelta === true) {
    const paths = Array.isArray(sc.paths) ? sc.paths.map(String) : [];
    const list = paths.length ? `\n\n${paths.map((p) => `- \`${p}\``).join('\n')}` : '';
    const text = `Release-only changes approved by buildd reviewer (confidence ${(out.confidence ?? 0).toFixed(2)}). `
      + `This review covers only the ${paths.length} new ${paths.length === 1 ? 'path' : 'paths'} the release adds; `
      + `every other change was reviewed at its own head and is not re-reviewed here.${list}\n\n${out.summary ?? ''}`;
    return text.trimEnd();
  }
  return `Approved by buildd reviewer (confidence ${(out.confidence ?? 0).toFixed(2)}): ${out.summary ?? ''}`;
}

const postReview: EffectHandler = async (e) => {
  const view = await viewFor(e);
  const d = view.delivery;
  const round = view.rounds.find((r) => r.id === e.payload.roundId);
  if (!d?.repoFullName || d.prNumber == null || !round) return { outcome: 'skipped:no_round' };
  const repo = await workspaceRepo(d.workspaceId);
  if (!repo) return { outcome: 'skipped:no_installation' };
  const out = await roundOutput(round);
  const event = e.payload.event === 'APPROVE' ? 'APPROVE' : 'REQUEST_CHANGES';
  const res = await postPrReview({
    installationId: repo.installationId, repoFullName: d.repoFullName, prNumber: d.prNumber,
    // §8.4: commit_id is the round's head, never whatever the PR shows now.
    headSha: String(e.payload.commitId ?? round.headSha),
    event,
    body: postReviewBody(event, out, e.payload.scope),
  }).catch((err) => ({ posted: false as const, reason: err instanceof Error ? err.message : 'unknown error' }));
  if (!res.posted && res.reason !== 'a matching review already exists for this commit') {
    const owner = await db.query.tasks.findFirst({ where: eq(tasks.id, d.ownerTaskId), columns: { missionId: true } });
    if (owner?.missionId) {
      await db.insert(missionNotes).values({
        missionId: owner.missionId, taskId: d.ownerTaskId, authorType: 'system', type: 'warning',
        title: `Reviewer verdict could not be posted to GitHub for PR #${d.prNumber}`,
        body: `buildd recorded a ${event === 'APPROVE' ? 'approve' : 'request-changes'} verdict, but posting it to GitHub as a review failed: ${res.reason ?? 'unknown error'}`,
        status: 'open',
      });
    }
    return { outcome: `failed_post:${res.reason ?? 'unknown'}` };
  }
  return { outcome: 'ok' };
};

// ── Escalations ─────────────────────────────────────────────────────────────

const escalateExhaustion: EffectHandler = async (e) => {
  if (e.payload.family !== 'review_fix') return { outcome: 'skipped:legacy_owns' };
  const view = await viewFor(e);
  const d = view.delivery;
  if (!d?.repoFullName || d.prNumber == null || !d.currentHeadSha) return { outcome: 'skipped:no_pr' };
  const out = await roundOutput(view.rounds.find((r) => r.round === d.currentRound));
  const { escalateReviewerExhaustion } = await import('@/lib/auto-merge');
  await escalateReviewerExhaustion(d.ownerTaskId, d.repoFullName, d.prNumber, d.currentHeadSha, d.maxRounds, out.feedback ?? null);
  const repo = await workspaceRepo(d.workspaceId);
  if (repo) {
    // A fix ledger spent before the rounds were (T8, 67d34094) says so; otherwise the rounds ran out.
    const detail = e.payload.max != null ? `after ${Number(e.payload.attempts)} fix attempts` : `after ${d.currentRound} review rounds`;
    await appendPrActivity({
      installationId: repo.installationId, repoFullName: d.repoFullName, prNumber: d.prNumber,
      entry: { kind: 'review_escalated', detail, note: out.feedback ?? null },
      workspaceId: d.workspaceId,
    });
  }
  return { outcome: 'ok' };
};

const missionNote: EffectHandler = async (e) => {
  if (e.payload.reason !== 'review_escalated') return { outcome: 'skipped:legacy_owns' };
  const view = await viewFor(e);
  const d = view.delivery;
  if (!d?.repoFullName || d.prNumber == null) return { outcome: 'skipped:no_pr' };
  const round = view.rounds.find((r) => r.id === e.payload.roundId);
  const out = await roundOutput(round);
  const reviewer = round?.reviewerTaskId
    ? await db.query.tasks.findFirst({ where: eq(tasks.id, round.reviewerTaskId), columns: { result: true } })
    : null;
  const overrideReason = ((reviewer?.result ?? {}) as { effectiveVerdictReason?: string }).effectiveVerdictReason ?? null;
  const message = overrideReason ?? out.escalationReason ?? out.summary ?? 'see the review';
  const prUrl = `https://github.com/${d.repoFullName}/pull/${d.prNumber}`;
  void notifyTeamOf({ workspaceId: d.workspaceId }, 'needsAttention', { title: `PR #${d.prNumber} escalated by reviewer`, message, url: prUrl, urlTitle: 'View PR' });
  const repo = await workspaceRepo(d.workspaceId);
  if (repo) {
    await appendPrActivity({ installationId: repo.installationId, repoFullName: d.repoFullName, prNumber: d.prNumber, entry: { kind: 'review_escalated', note: message }, workspaceId: d.workspaceId });
  }
  return { outcome: 'ok' };
};

const DEAD_EFFECT_COPY: Record<string, string> = {
  merge_call: 'the merge call kept failing',
  verify_merge: 'reading back the merge kept failing',
  dispatch_fix: 'filing the fix task kept failing',
  dispatch_review: 'filing the review task kept failing',
  post_review: 'posting the review to GitHub kept failing',
};

const notify: EffectHandler = async (e) => {
  if (e.payload.event !== 'push_undeliverable' && e.payload.event !== 'effect_dead') return { outcome: 'skipped:no_channel' };
  const view = await viewFor(e);
  const d = view.delivery;
  if (!d?.repoFullName || d.prNumber == null) return { outcome: 'skipped:no_pr' };
  if (e.payload.event === 'effect_dead') {
    // §10.3: a critical effect went dead and the delivery escalated (67d34094).
    const what = DEAD_EFFECT_COPY[String(e.payload.effectKind)] ?? `the ${String(e.payload.effectKind)} step kept failing`;
    void notifyTeamOf({ workspaceId: d.workspaceId }, 'needsAttention', {
      title: `PR #${d.prNumber} needs a person: ${what}`,
      message: `buildd retried ${what.replace(' kept failing', '')} until it gave up, so nothing will move this PR on its own. Check the PR and land or re-run it.`,
      url: `https://github.com/${d.repoFullName}/pull/${d.prNumber}`,
      urlTitle: 'View PR',
    });
    return { outcome: 'ok' };
  }
  const local = (e.payload.localHeadSha as string | null) ?? null;
  void notifyTeamOf({ workspaceId: d.workspaceId }, 'needsAttention', {
    title: `PR #${d.prNumber}: a fix never reached GitHub`,
    message: `The fix attempt ended but the PR head is still ${d.currentHeadSha?.slice(0, 7) ?? 'unchanged'}${local ? `; its local commit was ${local.slice(0, 7)}` : ''}. Push the branch or re-run the fix.`,
    url: `https://github.com/${d.repoFullName}/pull/${d.prNumber}`,
    urlTitle: 'View PR',
  });
  return { outcome: 'ok' };
};

// ── Cancellations ───────────────────────────────────────────────────────────

const cancelOpenAttempts: EffectHandler = async (e) => {
  const reason = e.payload.reason;
  const view = await viewFor(e);
  const d = view.delivery;
  if (!d?.repoFullName || d.prNumber == null) return { outcome: 'skipped:no_pr' };
  if (reason === 'head_moved') {
    const families = Array.isArray(e.payload.families) ? (e.payload.families as string[]) : ['review_fix'];
    const role = families.includes('ci') ? 'ci_fix' : families.includes('conflict') || families.includes('migration') ? 'conflict_fix' : 'fix';
    const n = await cancelPendingAttemptTasks(d.id, role, null, 'the PR head moved before the fix started');
    return { outcome: `ok:cancelled_${n}` };
  }
  if (reason === 'approved') {
    const repo = await workspaceRepo(d.workspaceId);
    if (!repo) return { outcome: 'skipped:no_installation' };
    const { supersedeFixTaskOnApproval } = await import('@/lib/reviewer');
    await supersedeFixTaskOnApproval({ originalTaskId: d.ownerTaskId, workspaceId: d.workspaceId, installationId: repo.installationId, repoFullName: d.repoFullName, prNumber: d.prNumber });
    await cancelPendingAttemptTasks(d.id, 'fix', null, 'the PR was approved');
    return { outcome: 'ok' };
  }
  // Merge / close / trunk cancellations: the legacy supersession rules still run them.
  return { outcome: 'skipped:legacy_owns' };
};

// ── push_recovery (§9): bounded re-reads, then a person ─────────────────────

const pushRecovery: EffectHandler = async (e) => {
  const view = await viewFor(e);
  const d = view.delivery;
  if (!d || d.state !== 'AWAITING_PUSH') return { outcome: 'skipped:state_moved' };
  if (!d.repoFullName || d.prNumber == null) return { outcome: 'skipped:no_pr' };
  const repo = await workspaceRepo(d.workspaceId);
  if (!repo) throw new Error('no GitHub installation for the workspace');
  const reader = githubReader(repo.installationId);
  const live = await reader.readPr(d.repoFullName, d.prNumber);
  if (live && live.headSha !== d.currentHeadSha) {
    // A head arrived that the webhook did not deliver: T3 decides whether it is proof.
    await ingestFact({ kind: 'head_observed', workspaceId: d.workspaceId, source: 'effect:push_recovery', repoFullName: d.repoFullName, prNumber: d.prNumber }, { exec: dbExec, github: reader });
    return { outcome: 'ok:head_observed' };
  }
  const tryNo = Number(e.payload.try ?? 1);
  const maxTries = Number(e.payload.maxTries ?? 3);
  const local = (e.payload.localHeadSha as string | null) ?? null;
  if (tryNo < maxTries) {
    const { PUSH_RECOVERY_BACKOFF_MS } = await import('./reducer');
    await dbExec(insertFollowupEffectSql({
      deliveryId: d.id, transitionId: e.transitionId, kind: 'push_recovery',
      dedupeKey: `push_recovery:${d.id}:${local ?? 'none'}:${tryNo + 1}`,
      payload: { ...e.payload, try: tryNo + 1 },
      delayMs: PUSH_RECOVERY_BACKOFF_MS[Math.min(tryNo, PUSH_RECOVERY_BACKOFF_MS.length - 1)],
    }));
    return { outcome: `ok:retry_${tryNo + 1}` };
  }
  await applyCommand({ type: 'PushRecoveryExhausted', actor: 'effect:push_recovery', localHeadSha: local }, { ref: { deliveryId: d.id }, exec: dbExec });
  return { outcome: 'ok:exhausted' };
};

// The landing and post-merge effects are pr-landing-effects.ts's; the supersession
// scan, its projection and the mission wake (T18/T20/T21) are supersession-effects.ts's.
// Nothing emits these two yet.
const LEGACY_OWNED: EffectKind[] = ['release_attribution', 'gate_event'];

export const reviewEffectHandlers: EffectHandlers = {
  dispatch_review: dispatchReview,
  dispatch_fix: dispatchFix,
  post_review: postReview,
  escalate_exhaustion: escalateExhaustion,
  mission_note: missionNote,
  notify,
  cancel_open_attempts: cancelOpenAttempts,
  push_recovery: pushRecovery,
  // §12.1: the comment is regenerated from transitions. Loaded lazily so this
  // module does not pull the activity renderer into every importer.
  render_activity: async (e) => (await import('./pr-activity-effects')).renderActivity(e),
  ...Object.fromEntries(LEGACY_OWNED.map((k) => [k, legacyOwns])),
};

// Exported for tests.
export const __handlers = { dispatchReview, dispatchFix, postReview, escalateExhaustion, missionNote, notify, cancelOpenAttempts, pushRecovery };
