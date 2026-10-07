/**
 * The route-facing seam of the workflow kernel (docs/specs/workflow-state-kernel.md
 * §13): the fix-loop hand-off. Routes call these functions at the points where
 * the legacy code used to decide; each one answers whether the kernel owned the
 * decision, and when it did the legacy write MUST NOT run (one authority per
 * delivery, §14).
 *
 * Every function here:
 *  - returns "not mine" fast for a task or PR with no kernel delivery, so a PR
 *    that was open at cutover finishes on the legacy path unchanged;
 *  - resolves the kill switch first (authority.ts), releasing the delivery to
 *    legacy when `gitConfig.workflowKernel` is false;
 *  - takes its own live GitHub read (R2) and carries it into the command;
 *  - drains the delivery's due effects before returning, so the common path
 *    never waits for a cron (§10.3).
 */
import { and, desc, eq, or, sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks, workers, workspaces } from '@buildd/core/db/schema';
import type { Command, LivePr } from './commands';
import { applyCommand, loadView, type CommandResult, type Exec } from './kernel';
import { ingestFact, type GithubFactReader } from './facts';
import { runEffects, type DrainSummary, type EffectHandlers } from './effects';
import { headCoverage, ledgerBudget } from './reducer';
import { kernelDeliveryById, kernelDeliveryForPr, kernelEnabled, releaseToLegacy, resolveOwnerDelivery } from './authority';
import { githubReader, workspaceRepo } from './github-facts';
import type { Verdict } from './types';

export type DeliveryRole = 'owner' | 'fix' | 'ci_fix' | 'conflict_fix' | 'review';

/** Attempt roles that repair a PR and must deliver a pushed head (§9). */
const REPAIR_ROLES: ReadonlySet<string> = new Set(['fix', 'ci_fix', 'conflict_fix']);
export const isRepairRole = (role: string | null | undefined): boolean => !!role && REPAIR_ROLES.has(role);

/** Reviewer runs a round may lose to infra before it escalates as review_unavailable (T27). */
export const REVIEW_CONTRACT_RETRIES = 2;

/** Injectable for tests; production uses the real db and GitHub. */
export interface SeamDeps {
  exec?: Exec;
  reader?: (installationId: number) => GithubFactReader;
  repoFor?: typeof workspaceRepo;
  drain?: (deliveryId: string) => Promise<DrainSummary | null>;
}

const readerFor = (deps: SeamDeps, installationId: number): GithubFactReader => (deps.reader ?? githubReader)(installationId);

/**
 * The effect handlers, filled in by the composition root: the review-loop
 * effects belong to the reviews module, which core never imports
 * (scripts/module-boundaries.test.ts). Lazy, so loading the seam does not load
 * every module.
 */
async function effectHandlers(): Promise<EffectHandlers> {
  return (await import('@/modules')).WORKFLOW_EFFECT_HANDLERS;
}

export async function drainDelivery(deliveryId: string, deps: SeamDeps = {}): Promise<DrainSummary | null> {
  if (deps.drain) return deps.drain(deliveryId);
  try {
    const kernelEffectHandlers = await effectHandlers();
    // Effects can enqueue follow-ups for the same delivery; a few passes settle it.
    let total: DrainSummary | null = null;
    for (let pass = 0; pass < 3; pass++) {
      const s = await runEffects({ handlers: kernelEffectHandlers, deliveryId, limit: 10, exec: deps.exec });
      total = total
        ? { claimed: total.claimed + s.claimed, done: total.done + s.done, skipped: total.skipped + s.skipped, failed: total.failed + s.failed, dead: [...total.dead, ...s.dead] }
        : s;
      if (s.claimed === 0) break;
    }
    return total;
  } catch (err) {
    // The effect rows are durable; the cron drain picks up whatever this missed.
    console.error(`[workflow] inline drain for delivery ${deliveryId} failed:`, err);
    return null;
  }
}

/** Cron floor tick: drain due effects across every delivery. */
export async function drainDueEffects(limit = 50): Promise<DrainSummary> {
  return runEffects({ handlers: await effectHandlers(), limit });
}

function ctxOf(task: { context?: unknown }): Record<string, unknown> {
  return task.context && typeof task.context === 'object' ? (task.context as Record<string, unknown>) : {};
}

async function liveProof(reader: GithubFactReader, repo: string, local: string | null, live: LivePr | null): Promise<{ liveContainsLocal: boolean } | undefined> {
  if (!local || !live || local === live.headSha || !reader.contains) return undefined;
  return { liveContainsLocal: await reader.contains(repo, local, live.headSha) };
}

// ── Opening a delivery ──────────────────────────────────────────────────────

export interface OpenInput {
  workspaceId: string;
  ownerTaskId: string;
  repoFullName: string;
  prNumber: number;
  installationId: number;
  source: string;
}

/**
 * Called exactly where the legacy code would dispatch a PR's FIRST review
 * (the PR `opened` policy after pre-flight, and create_pr's integration-branch
 * review). Opens the delivery (T1), binds the PR (T2) and records its head
 * (T3), all from a live read. Returns `owned: true` when the kernel now owns
 * the PR: the caller then dispatches nothing — the first round is queued when
 * the owner attempt ends (§6.5 row 1, §15 step 2).
 *
 * Idempotent: both doors may call it for the same PR.
 */
export async function openKernelDelivery(p: OpenInput, deps: SeamDeps = {}): Promise<{ owned: boolean; deliveryId?: string; reason?: string }> {
  const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, p.workspaceId), columns: { id: true, gitConfig: true } });
  if (!ws || !kernelEnabled(ws.gitConfig)) return { owned: false, reason: 'kernel_off' };

  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, p.ownerTaskId),
    columns: { id: true, status: true, category: true, deliveryId: true, deliveryRole: true },
  });
  if (!task) return { owned: false, reason: 'no_task' };
  if (task.category === 'review') return { owned: false, reason: 'review_task' };
  if (task.deliveryId && task.deliveryRole !== 'owner') return { owned: false, reason: 'attempt_task' };

  // Already owned (the other door got here first)?
  const byPr = await kernelDeliveryForPr(p.workspaceId, p.repoFullName, p.prNumber, deps.exec);
  if (byPr) return { owned: true, deliveryId: byPr };
  const existing = await resolveOwnerDelivery(p.workspaceId, p.ownerTaskId, deps.exec);
  if (existing && existing.authority === 'legacy') return { owned: false, reason: 'released' };

  const reader = readerFor(deps, p.installationId);
  const opened = await ingestFact({ kind: 'delivery_opened', workspaceId: p.workspaceId, source: p.source, ownerTaskId: p.ownerTaskId, requiresPr: true }, { exec: deps.exec });
  const view0 = await loadView({ workspaceId: p.workspaceId, ownerTaskId: p.ownerTaskId }, deps.exec);
  const deliveryId = view0.delivery?.id;
  if (!deliveryId) return { owned: false, reason: `open_${opened.result}` };

  let bound: Awaited<ReturnType<typeof ingestFact>>;
  try {
    bound = await ingestFact(
      { kind: 'pr_bound', workspaceId: p.workspaceId, source: p.source, repoFullName: p.repoFullName, prNumber: p.prNumber, ownerTaskId: p.ownerTaskId },
      { exec: deps.exec, github: reader },
    );
  } catch (err) {
    // A delivery that cannot say which PR it is must not decide anything.
    if (view0.delivery?.prNumber == null) await releaseToLegacy(deliveryId, 'pr_bound failed', deps.exec).catch(() => {});
    throw err;
  }
  if (bound.result === 'rejected') {
    if (bound.reason === 'pr_already_bound') return { owned: false, reason: 'owner_bound_to_other_pr' };
    // Could not bind (closed, fork, unreadable): the kernel cannot own this PR.
    await releaseToLegacy(deliveryId, `pr_bound rejected: ${bound.reason}`, deps.exec);
    return { owned: false, reason: `bind_${bound.reason}` };
  }
  await ingestFact(
    { kind: 'head_observed', workspaceId: p.workspaceId, source: p.source, repoFullName: p.repoFullName, prNumber: p.prNumber },
    { exec: deps.exec, github: reader },
  );

  await db.update(tasks)
    .set({ deliveryId, deliveryRole: 'owner' })
    .where(and(eq(tasks.id, p.ownerTaskId), sql`${tasks.deliveryId} IS NULL`));

  // The owner attempt may already have ended (the PR webhook can arrive after
  // the worker completed). An ended attempt with nobody to hand on would leave
  // the delivery in WORKING with no owner of the next move.
  const latest = await db.query.workers.findFirst({
    where: eq(workers.taskId, p.ownerTaskId),
    columns: { id: true, status: true, lastCommitSha: true, commitCount: true },
    orderBy: [desc(workers.createdAt)],
  });
  if (latest && (latest.status === 'completed' || latest.status === 'failed' || latest.status === 'error')
      && (task.status === 'completed' || task.status === 'failed')) {
    await attemptEnded({
      task: { id: p.ownerTaskId, workspaceId: p.workspaceId, deliveryId, deliveryRole: 'owner', context: null },
      workerId: latest.id,
      status: latest.status === 'completed' ? 'completed' : 'failed',
      localHeadSha: latest.lastCommitSha ?? null,
      commitCount: latest.commitCount ?? 0,
      source: `${p.source}:late_open`,
    }, deps);
  } else {
    await drainDelivery(deliveryId, deps);
  }
  return { owned: true, deliveryId };
}

// ── T4: an attempt ended ────────────────────────────────────────────────────

export interface AttemptTask {
  id: string;
  workspaceId: string;
  deliveryId: string | null;
  deliveryRole: string | null;
  context: unknown;
}

export async function attemptEnded(p: {
  task: AttemptTask;
  workerId: string;
  /** `lost`: the reaper ended it (no report, no local head known). */
  status: 'completed' | 'failed' | 'lost';
  localHeadSha: string | null;
  commitCount: number;
  source: string;
}, deps: SeamDeps = {}): Promise<{ handled: boolean; result?: CommandResult }> {
  const attemptKind = p.task.deliveryRole;
  if (!p.task.deliveryId || (attemptKind !== 'owner' && !isRepairRole(attemptKind) && attemptKind !== 'review')) return { handled: false };
  const deliveryId = await kernelDeliveryById(p.task.deliveryId, deps.exec);
  if (!deliveryId) return { handled: false };

  if (attemptKind === 'review') {
    // A completed reviewer is answered by its verdict (T6). One that ended
    // without a verdict fails its round (T27): re-queued at the same head and
    // round number, then review_unavailable. Never inferred as a verdict.
    if (p.status === 'completed') return { handled: true };
    const roundId = ctxOf(p.task).workflowRoundId as string | undefined;
    if (!roundId) return { handled: true };
    const result = await applyCommand(
      { type: 'ReviewRoundFailed', actor: p.source, roundId, reason: 'infra', maxContractRetries: REVIEW_CONTRACT_RETRIES },
      { ref: { deliveryId }, exec: deps.exec },
    );
    await drainDelivery(deliveryId, deps);
    return { handled: true, result };
  }

  const view = await loadView({ deliveryId }, deps.exec);
  const d = view.delivery;
  if (!d) return { handled: false };
  let live: LivePr | null = null;
  let proof: { liveContainsLocal: boolean } | undefined;
  if (d.repoFullName && d.prNumber != null) {
    const repo = await (deps.repoFor ?? workspaceRepo)(p.task.workspaceId);
    if (repo) {
      const reader = readerFor(deps, repo.installationId);
      live = await reader.readPr(d.repoFullName, d.prNumber);
      proof = await liveProof(reader, d.repoFullName, p.localHeadSha, live);
    }
  }
  const attemptId = isRepairRole(attemptKind) ? (ctxOf(p.task).workflowAttemptId as string | undefined) : undefined;
  const cmd: Command = {
    type: 'AttemptEnded',
    actor: p.source,
    workerId: p.workerId,
    ...(attemptKind === 'owner' ? { taskId: p.task.id } : { attemptId }),
    outcome: p.status === 'completed' ? 'success' : p.status,
    localHeadSha: p.localHeadSha,
    commitCount: p.commitCount,
    live,
    ...(proof ? { proof } : {}),
    // The kernel owns only deliveries whose policy dispatched a review (§14 Slice A).
    reviewRequired: true,
  };
  const result = await applyCommand(cmd, { ref: { deliveryId }, exec: deps.exec });
  if (result.result !== 'applied' && result.result !== 'duplicate') {
    console.log(`[workflow] AttemptEnded(${attemptKind}) for task ${p.task.id}: ${result.result} (${result.reason})`);
  }
  await drainDelivery(deliveryId, deps);
  return { handled: true, result };
}

// ── §9 completion gate ──────────────────────────────────────────────────────

export interface GateRefusal {
  code: 'delivery_not_advanced';
  error: string;
  hint: string;
  boundHeadSha: string | null;
  liveHeadSha: string;
  localHeadSha: string | null;
}

/**
 * A fix attempt may not report `completed` while the PR's GitHub head is still
 * the head the fix was bound to: its work is not on GitHub (§9). Fails open
 * when GitHub cannot be read (T4 then decides from what it can see).
 */
export async function fixCompletionGate(p: { task: AttemptTask; localHeadSha: string | null }, deps: SeamDeps = {}): Promise<GateRefusal | null> {
  if (!p.task.deliveryId || !isRepairRole(p.task.deliveryRole)) return null;
  const deliveryId = await kernelDeliveryById(p.task.deliveryId, deps.exec);
  if (!deliveryId) return null;
  const view = await loadView({ deliveryId }, deps.exec);
  const d = view.delivery;
  const attempt = view.attempts.find((a) => a.id === ctxOf(p.task).workflowAttemptId);
  if (!d || !attempt || !d.repoFullName || d.prNumber == null) return null;
  const repo = await (deps.repoFor ?? workspaceRepo)(p.task.workspaceId);
  if (!repo) return null;
  const live = await readerFor(deps, repo.installationId).readPr(d.repoFullName, d.prNumber);
  if (!live || live.state !== 'open' || live.merged) return null;
  if (live.headSha !== attempt.boundHeadSha) return null;
  return {
    code: 'delivery_not_advanced',
    error: `Your fix is not on GitHub: PR #${d.prNumber}'s head is still ${live.headSha.slice(0, 7)}, the commit ${p.task.deliveryRole === 'ci_fix' ? 'whose CI failed' : p.task.deliveryRole === 'conflict_fix' ? 'that conflicts with its base' : 'the review asked you to change'}.`
      + (p.localHeadSha && p.localHeadSha !== live.headSha ? ` Your local head is ${p.localHeadSha.slice(0, 7)}.` : ''),
    hint: 'Push your branch (git push), confirm with git ls-remote that the PR head moved, then complete again.',
    boundHeadSha: attempt.boundHeadSha,
    liveHeadSha: live.headSha,
    localHeadSha: p.localHeadSha,
  };
}

// ── T9: a fix attempt is claimed ────────────────────────────────────────────

export type ClaimDecision = { action: 'proceed' } | { action: 'cancel'; reason: string } | { action: 'defer'; reason: string };

/**
 * Claim-time revalidation (§10.5): a fix whose target was resolved while it
 * queued (merged, approved, head moved, round superseded) is skipped, never
 * started. Called after the claim's own CAS succeeded; on `cancel` the caller
 * cancels the task as skipped (not failed).
 */
export async function claimFix(task: AttemptTask, deps: SeamDeps = {}): Promise<ClaimDecision> {
  if (!task.deliveryId || !isRepairRole(task.deliveryRole)) return { action: 'proceed' };
  const deliveryId = await kernelDeliveryById(task.deliveryId, deps.exec);
  if (!deliveryId) return { action: 'proceed' };
  const attemptId = ctxOf(task).workflowAttemptId as string | undefined;
  if (!attemptId) return { action: 'proceed' };
  const view = await loadView({ deliveryId }, deps.exec);
  const d = view.delivery;
  if (!d?.repoFullName || d.prNumber == null) return { action: 'proceed' };
  const repo = await (deps.repoFor ?? workspaceRepo)(task.workspaceId);
  if (!repo) return { action: 'defer', reason: 'no_installation' };
  const live = await readerFor(deps, repo.installationId).readPr(d.repoFullName, d.prNumber);
  if (!live) return { action: 'defer', reason: 'live_read_failed' };
  const approved = d.state === 'APPROVED' || headCoverage(d, live.headSha) !== 'none';
  const reader = readerFor(deps, repo.installationId);
  // The CI family's own trigger fact: a re-run that went green while the fix queued.
  const ciGreen = task.deliveryRole === 'ci_fix' && reader.ciGreen ? (await reader.ciGreen(d.repoFullName, live.headSha)) === true : false;
  // The conflict family's own trigger fact: GitHub no longer reports the head as conflicting.
  const attempt = view.attempts.find((a) => a.id === attemptId);
  const conflictResolved = task.deliveryRole === 'conflict_fix' && attempt?.family === 'conflict' && isMergeableNow(live.mergeableState);
  const result = await applyCommand({ type: 'FixClaimed', actor: `claim:${task.id}`, attemptId, revalidation: { live, approved, ciGreen, conflictResolved } }, { ref: { deliveryId }, exec: deps.exec });
  await drainDelivery(deliveryId, deps);
  if (result.result === 'applied') {
    const skipped = result.decision.evidence.skipped;
    return typeof skipped === 'string' ? { action: 'cancel', reason: skipped } : { action: 'proceed' };
  }
  if (result.result === 'duplicate') return { action: 'proceed' };
  return { action: 'cancel', reason: result.reason };
}

/** Cancel a fix task the kernel skipped at claim (§10.5): cancelled, not failed. */
export async function cancelSkippedTask(taskId: string, reason: string): Promise<void> {
  await db.update(tasks)
    .set({
      status: 'cancelled',
      claimedBy: null,
      result: sql`COALESCE(${tasks.result}, '{}'::jsonb) || jsonb_build_object('skipped', true, 'summary', ${`Skipped at claim: ${reason}`}::text, 'skipReason', ${reason}::text)`,
      updatedAt: new Date(),
    })
    .where(and(eq(tasks.id, taskId), or(eq(tasks.status, 'pending'), eq(tasks.status, 'assigned'))));
}

// ── T6: a reviewer's verdict ────────────────────────────────────────────────

export function toKernelVerdict(v: string): Verdict {
  return v === 'approve' ? 'approve' : v === 'escalate' ? 'escalate' : 'request_changes';
}

/**
 * The verdict of a kernel review round. `handled: false` = not a kernel round
 * (legacy decides). When handled, the caller acts on an `applied` APPROVED
 * result only (landing is still the legacy door until Slice C); everything
 * else — posting the GitHub review, the fix dispatch, exhaustion and
 * escalation notices — is an effect the kernel already ran.
 */
export async function recordReviewVerdict(p: {
  reviewerTask: { id: string; deliveryId: string | null; context: unknown };
  verdict: string;
  effectiveVerdict: string;
  headSha: string;
  confidence: number | null;
}, deps: SeamDeps = {}): Promise<{ handled: false } | { handled: true; result: CommandResult; toState: string | null }> {
  const roundId = ctxOf(p.reviewerTask).workflowRoundId as string | undefined;
  if (!p.reviewerTask.deliveryId || !roundId) return { handled: false };
  const deliveryId = await kernelDeliveryById(p.reviewerTask.deliveryId, deps.exec);
  if (!deliveryId) return { handled: false };
  const result = await applyCommand({
    type: 'ReviewVerdictRecorded',
    actor: `reviewer:${p.reviewerTask.id}`,
    roundId,
    verdict: toKernelVerdict(p.verdict),
    effectiveVerdict: toKernelVerdict(p.effectiveVerdict),
    headBound: p.headSha,
    confidence: p.confidence,
  }, { ref: { deliveryId }, exec: deps.exec });
  await drainDelivery(deliveryId, deps);
  return { handled: true, result, toState: result.result === 'applied' ? result.decision.toState : null };
}

// ── T3: the PR head moved (webhook `synchronize`) ───────────────────────────

/**
 * `true` = the kernel owns this PR and handled the push; the legacy re-review
 * and carry-forward MUST NOT run. The webhook head is a hint (R2).
 */
export async function observeHead(p: {
  workspaceId: string;
  repoFullName: string;
  prNumber: number;
  installationId: number;
  hintedHeadSha: string | null;
  source: string;
  carryForward?: (live: LivePr) => Promise<'content_equivalent' | 'own_refresh' | null>;
}, deps: SeamDeps = {}): Promise<boolean> {
  const deliveryId = await kernelDeliveryForPr(p.workspaceId, p.repoFullName, p.prNumber, deps.exec);
  if (!deliveryId) return false;
  try {
    const res = await ingestFact({
      kind: 'head_observed', workspaceId: p.workspaceId, source: p.source, repoFullName: p.repoFullName, prNumber: p.prNumber,
      hintedHeadSha: p.hintedHeadSha, carryForward: p.carryForward,
    }, { exec: deps.exec, github: readerFor(deps, p.installationId) });
    if (res.result === 'rejected' || res.result === 'stale') {
      console.log(`[workflow] HeadObserved ${p.repoFullName}#${p.prNumber}: ${res.result} (${res.reason})`);
    }
  } catch (err) {
    // The delivery is the kernel's: a failed read is answered by the next fact
    // or the push_recovery/sweep path, never by the legacy re-dispatch.
    console.error(`[workflow] HeadObserved ${p.repoFullName}#${p.prNumber} failed:`, err);
  }
  await drainDelivery(deliveryId, deps);
  return true;
}

/** Webhook `closed` / `reopened`: T17 / T18 / T19 from a live read. Legacy keeps its post-merge work (Slice C). */
export async function observePrState(p: {
  workspaceId: string; repoFullName: string; prNumber: number; installationId: number; source: string;
}, deps: SeamDeps = {}): Promise<boolean> {
  const deliveryId = await kernelDeliveryForPr(p.workspaceId, p.repoFullName, p.prNumber, deps.exec);
  if (!deliveryId) return false;
  await ingestFact({ kind: 'pr_closed', workspaceId: p.workspaceId, source: p.source, repoFullName: p.repoFullName, prNumber: p.prNumber },
    { exec: deps.exec, github: readerFor(deps, p.installationId) });
  await drainDelivery(deliveryId, deps);
  return true;
}

// ── T5: a person or agent asks for a review ─────────────────────────────────

/**
 * The human/agent review doors (`request_pr_review`, the dashboard re-review)
 * for a kernel-owned PR. `handled: false` = legacy PR, the door runs as before.
 */
export async function requestReview(p: {
  workspaceId: string; repoFullName: string; prNumber: number; installationId: number; forced: boolean; actor: string;
}, deps: SeamDeps = {}): Promise<{ handled: false } | { handled: true; result: CommandResult }> {
  const deliveryId = await kernelDeliveryForPr(p.workspaceId, p.repoFullName, p.prNumber, deps.exec);
  if (!deliveryId) return { handled: false };
  const reader = readerFor(deps, p.installationId);
  const live = await reader.readPr(p.repoFullName, p.prNumber);
  if (!live) {
    return { handled: true, result: { result: 'rejected', reason: 'live_read_failed', current: { state: null, version: 0, head: null, round: 0 } } };
  }
  // Record a head the webhook has not delivered yet, so the request names the current head.
  await ingestFact({ kind: 'head_observed', workspaceId: p.workspaceId, source: `${p.actor}:review_request`, repoFullName: p.repoFullName, prNumber: p.prNumber },
    { exec: deps.exec, github: { readPr: async () => live, contains: reader.contains } });
  const result = await applyCommand(
    { type: 'ReviewRequested', actor: p.actor, headSha: live.headSha, live, forced: p.forced },
    { ref: { deliveryId }, exec: deps.exec },
  );
  await drainDelivery(deliveryId, deps);
  return { handled: true, result };
}

// ── §6.9: a repair attempt's own commits (provenance by SHA set) ───────────

/**
 * The runner's metric sync reported a local head for a repair attempt: record
 * it on the attempt's `reported_shas`, so a head that arrives later is
 * recognised as this attempt's push by SHA, not by who authored it. One
 * statement; a no-op for any task that is not an open kernel repair attempt.
 */
export async function recordLocalHead(taskId: string, sha: string, exec: Exec = (q) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>): Promise<void> {
  await exec(sql`-- workflow:record_local_head
UPDATE workflow_attempts wa
SET reported_shas = CASE WHEN ${sha}::text = ANY(wa.reported_shas) THEN wa.reported_shas ELSE array_append(wa.reported_shas, ${sha}::text) END,
    updated_at = now()
FROM tasks t
JOIN workflow_deliveries d ON d.id = t.delivery_id AND d.authority = 'kernel'
WHERE t.id = ${taskId}::uuid
  AND t.delivery_role IN ('fix', 'ci_fix', 'conflict_fix')
  AND wa.id = NULLIF(t.context->>'workflowAttemptId', '')::uuid
  AND wa.delivery_id = d.id
  AND wa.status IN ('queued', 'running')`);
}

// ── T10: CI failed on a kernel-owned PR ─────────────────────────────────────

export interface CiFailureSeen {
  handled: true;
  result: CommandResult;
  /** The CI fix task the dispatch effect filed, once drained. */
  attemptTaskId: string | null;
}

async function attemptTaskOf(deliveryId: string, result: CommandResult, exec?: Exec): Promise<string | null> {
  if (result.result !== 'applied') return null;
  const ins = result.decision.attempts.find((a) => a.op === 'insert') as { id: string } | undefined;
  if (!ins) return null;
  const view = await loadView({ deliveryId }, exec);
  return view.attempts.find((a) => a.id === ins.id)?.taskId ?? null;
}

/**
 * The `check_suite` webhook and the red-PR sweep for a kernel-owned PR: T10
 * from a live read. The head is recorded first (R2), so an old-SHA failure is
 * answered `stale(head_not_current)` and never overwrites a newer head.
 * `handled: false` = not the kernel's PR; the legacy retry runs as before.
 */
export async function observeCiFailure(p: {
  workspaceId: string; repoFullName: string; prNumber: number; installationId: number;
  headSha: string; signature: string; maxAttempts: number; source: string;
}, deps: SeamDeps = {}): Promise<{ handled: false } | CiFailureSeen> {
  const deliveryId = await kernelDeliveryForPr(p.workspaceId, p.repoFullName, p.prNumber, deps.exec);
  if (!deliveryId) return { handled: false };
  const reader = readerFor(deps, p.installationId);
  const live = await reader.readPr(p.repoFullName, p.prNumber);
  if (!live) return { handled: true, result: { result: 'rejected', reason: 'live_read_failed', current: { state: null, version: 0, head: null, round: 0 } }, attemptTaskId: null };
  await ingestFact({ kind: 'head_observed', workspaceId: p.workspaceId, source: `${p.source}:ci`, repoFullName: p.repoFullName, prNumber: p.prNumber },
    { exec: deps.exec, github: { ...reader, readPr: async () => live } });
  const result = await applyCommand(
    { type: 'CiFailedObserved', actor: p.source, headSha: p.headSha, signature: p.signature, maxAttempts: p.maxAttempts },
    { ref: { deliveryId }, exec: deps.exec },
  );
  await drainDelivery(deliveryId, deps);
  return { handled: true, result, attemptTaskId: await attemptTaskOf(deliveryId, result, deps.exec) };
}

/**
 * A person's "Fix CI" on a kernel-owned PR (§5.7 rule 5). Under the
 * configured cap it is an ordinary T10 attempt with trigger=human; past it, a
 * visible BudgetExtended transition by that person allocates exactly one more.
 * Never "iteration 0", never a fresh budget.
 */
export async function requestCiRetry(p: {
  workspaceId: string; repoFullName: string; prNumber: number; installationId: number;
  actor: string; maxAttempts: number; reason: string;
}, deps: SeamDeps = {}): Promise<{ handled: false } | (CiFailureSeen & { extended: boolean })> {
  const deliveryId = await kernelDeliveryForPr(p.workspaceId, p.repoFullName, p.prNumber, deps.exec);
  if (!deliveryId) return { handled: false };
  const reader = readerFor(deps, p.installationId);
  const live = await reader.readPr(p.repoFullName, p.prNumber);
  if (!live) return { handled: true, extended: false, attemptTaskId: null, result: { result: 'rejected', reason: 'live_read_failed', current: { state: null, version: 0, head: null, round: 0 } } };
  await ingestFact({ kind: 'head_observed', workspaceId: p.workspaceId, source: `${p.actor}:retry_ci`, repoFullName: p.repoFullName, prNumber: p.prNumber },
    { exec: deps.exec, github: { ...reader, readPr: async () => live } });
  const view = await loadView({ deliveryId }, deps.exec);
  const { spent, max } = ledgerBudget(view.attempts, 'ci', p.maxAttempts);
  let extended = false;
  let result: CommandResult | null = null;
  if (spent < max) {
    result = await applyCommand(
      { type: 'CiFailedObserved', actor: p.actor, headSha: live.headSha, signature: 'manual', maxAttempts: p.maxAttempts, trigger: 'human' },
      { ref: { deliveryId }, exec: deps.exec },
    );
  }
  if (!result || (result.result === 'rejected' && result.reason === 'budget_exhausted')) {
    extended = true;
    result = await applyCommand(
      { type: 'BudgetExtended', actor: p.actor, family: 'ci', headSha: live.headSha, signature: 'manual', maxAttempts: p.maxAttempts, reason: p.reason },
      { ref: { deliveryId }, exec: deps.exec },
    );
  }
  await drainDelivery(deliveryId, deps);
  return { handled: true, extended, result, attemptTaskId: await attemptTaskOf(deliveryId, result, deps.exec) };
}

// ── T12: the PR conflicts with, or is behind, its base ──────────────────────

/** GitHub says nothing conflicts and nothing is missing from the base (§10.5 for the conflict family). */
export function isMergeableNow(state: string | null | undefined): boolean {
  return state === 'clean' || state === 'unstable' || state === 'has_hooks' || state === 'blocked';
}

export interface ConflictSeen {
  handled: true;
  result: CommandResult;
  /** What GitHub said NOW: `dirty`, `behind`, `clean` (nothing to do) or `unknown` (the door's hint was used). */
  mergeable: 'dirty' | 'behind' | 'clean' | 'unknown';
  /** The delivery after the inline drain. */
  after: { state: string | null; stateReason: string | null; headSha: string | null } | null;
  /** The attempt the transition allocated, or the one already bound. */
  attempt: { id: string; family: string; mode: string; status: string; outcome: string | null; taskId: string | null } | null;
}

/**
 * Every door that used to decide a conflict retry (landing, the merge routes,
 * auto-merge, the dead-zone sweep, the migration-collision dispatch) for a
 * kernel-owned PR: T12 from a live read taken now (§6.7). Mechanical first:
 * `refresh_branch` for behind or dirty, `renumber_migration` for a collision,
 * and an agent attempt only when the mechanical one is refused. The mechanical
 * refresh is also the "is it really a conflict against today's base" recheck:
 * a conflict that GitHub's own merge of the base resolves never reaches an
 * agent. `handled: false` = not the kernel's PR; the legacy retry runs.
 */
export async function observeConflict(p: {
  workspaceId: string; repoFullName: string; prNumber: number; installationId: number;
  /** What the door saw (a merge refusal, a stored snapshot); used only when GitHub says `unknown`. */
  hint: 'dirty' | 'behind';
  migrationCollision?: Record<string, unknown> | null;
  isDependencyBot: boolean;
  maxAgentAttempts: number;
  /** A person asked: the agent budget is the configured cap on top of what is already spent. */
  humanInitiated?: boolean;
  source: string;
}, deps: SeamDeps = {}): Promise<{ handled: false } | ConflictSeen> {
  const deliveryId = await kernelDeliveryForPr(p.workspaceId, p.repoFullName, p.prNumber, deps.exec);
  if (!deliveryId) return { handled: false };
  const reader = readerFor(deps, p.installationId);
  const live = await reader.readPr(p.repoFullName, p.prNumber);
  const none = (reason: string, mergeable: ConflictSeen['mergeable'] = 'unknown'): ConflictSeen => ({
    handled: true, mergeable, after: null, attempt: null,
    result: { result: 'rejected', reason, current: { state: null, version: 0, head: null, round: 0 } },
  });
  if (!live) return none('live_read_failed');
  await ingestFact({ kind: 'head_observed', workspaceId: p.workspaceId, source: `${p.source}:conflict`, repoFullName: p.repoFullName, prNumber: p.prNumber },
    { exec: deps.exec, github: { ...reader, readPr: async () => live } });
  const state = live.mergeableState ?? null;
  const mergeable: ConflictSeen['mergeable'] = state === 'dirty' ? 'dirty' : state === 'behind' ? 'behind' : isMergeableNow(state) ? 'clean' : 'unknown';
  if (mergeable === 'clean' && !p.migrationCollision) return none('not_conflicting', 'clean');
  let maxAgent = p.maxAgentAttempts;
  if (p.humanInitiated) {
    const v0 = await loadView({ deliveryId }, deps.exec);
    maxAgent = ledgerBudget(v0.attempts, p.migrationCollision ? 'migration' : 'conflict', 0).spent + p.maxAgentAttempts;
  }
  const result = await applyCommand({
    type: 'ConflictObserved', actor: p.source, headSha: live.headSha,
    mergeable: mergeable === 'behind' || mergeable === 'dirty' ? mergeable : p.hint,
    migrationCollision: !!p.migrationCollision,
    detail: p.migrationCollision ? { migrationCollision: p.migrationCollision } : null,
    maxAgentAttempts: maxAgent,
    isDependencyBot: p.isDependencyBot,
  }, { ref: { deliveryId }, exec: deps.exec });
  await drainDelivery(deliveryId, deps);
  const view = await loadView({ deliveryId }, deps.exec);
  const d = view.delivery;
  const ins = result.result === 'applied'
    ? (result.decision.attempts.filter((a) => a.op === 'insert').at(-1) as { id: string } | undefined)
    : undefined;
  // The attempt the delivery is bound to after the drain (a refused mechanical row hands on to an
  // agent one), else the one this transition allocated.
  const a = view.attempts.find((x) => x.id === d?.boundAttemptId) ?? (ins ? view.attempts.find((x) => x.id === ins.id) : undefined);
  return {
    handled: true, result, mergeable,
    after: d ? { state: d.state, stateReason: d.stateReason, headSha: d.currentHeadSha } : null,
    attempt: a ? { id: a.id, family: a.family, mode: a.mode, status: a.status, outcome: a.outcome, taskId: a.taskId } : null,
  };
}
