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
 *    legacy when the `gitConfig.workflowKernel` switch is off;
 *  - takes its own live GitHub read (R2) and carries it into the command;
 *  - drains the delivery's due effects before returning, so the common path
 *    never waits for a cron (§10.3).
 */
import { and, desc, eq, or, sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks, workers, workspaces } from '@buildd/core/db/schema';
import type { Command, CurrentView, LivePr, VerdictFindings } from './commands';
import { applyCommand, loadView, type CommandResult, type Exec } from './kernel';
import { catchUpBase, ingestFact, readDeltaForApproval, type GithubFactReader } from './facts';
import { deltaApprovalSource, type DeltaReading } from '@buildd/workflow-kernel/delta-approval';
import { runEffects, type DrainSummary, type EffectHandlers } from './effects';
import { settleLanes } from './landing-lane';
import { withPrFactEffects } from './pr-fact-effects';
import { headCoverage, ledgerBudget } from './reducer';
import { kernelDeliveryById, kernelDeliveryForPr, kernelDeliveryInWorkspace, kernelEnabled, releaseToLegacy, resolveOwnerDelivery } from './authority';
import { githubReader, workspaceRepo } from './github-facts';
import { policyValue } from '@/lib/policy-overrides';
import { preflightMissOf } from './preflight-miss';
import { landThroughKernel as landThroughKernelImpl, type KernelLanding, type LandingInput } from './landing';
import { enqueueEffectSql, enqueueMissingEffects, existingEffectsSql } from './enqueue-missing';
import { floorCandidatesSql, floorCheckedSql, strandedMechanicalRepair, treadmillCycleCandidatesSql, type FloorCandidate, type TreadmillCycleCandidate } from './reconcile';

// The worker PATCH's reading of a terminal report (S30), exported here because routes reach the kernel only through the seam.
export { attemptEndFromPatch, taskRetryCoversAttemptEnd } from './hand-off';
import type { MigrationSafety } from '@/lib/migration-safety';
import type { KernelView, PolicyOutcome, Verdict } from './types';
import {
  UNKNOWN_CI_SIGNATURE, blockedOnResolvedSql, classifyCiFailure, openOrJoinIncidentSql, repairingCiOnBaseSql,
  resolveIncidentSql, trunkExplains, trunkRecovered, unresolvedIncidentsSql, type TrunkClassification,
} from './trunk';
import { sqlOrderBy, sqlWhere } from '@buildd/core/db/relational-sql';
import { drainOnControlPlane, hostsKernelHere } from './kernel-client';
import { recordPrStateObserved } from './render-observation';
import { isAttemptRow, ownerAttemptEndOf, projectOwnerEndSql } from './task-projection';
import { isTerminalWorkerStatus } from '@buildd/shared';
import { scheduleKernelHeal } from './kernel-heal';
import { diffTouchesFindings, isTaskId, openFindings, openRequiredFindings, pathsNamedIn } from '@buildd/workflow-kernel/findings';

const seamExec: Exec = (q) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;

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
  /** Wake the landing sweep for `workspaceId:prNumber` (the due queue). */
  markLandingDue?: (member: string) => Promise<void>;
}

const readerFor = (deps: SeamDeps, installationId: number): GithubFactReader => (deps.reader ?? githubReader)(installationId);

/**
 * The effect handlers: the kernel composed once from its ports and the
 * composition root's slots (kernel-ports.ts `workflowKernel`). The review-loop
 * effects belong to the reviews module, which core never imports
 * (scripts/module-boundaries.test.ts). Lazy, so loading the seam does not load
 * every module.
 */
async function effectHandlers(): Promise<EffectHandlers> {
  // The kernel's own projection onto the PR fact cache (stamp_pr_rows) is core,
  // not a module's: it is added here rather than at the composition root.
  const { workflowKernel } = await import('./kernel-ports');
  return withPrFactEffects((await workflowKernel()).handlers);
}

export async function drainDelivery(deliveryId: string, deps: SeamDeps = {}): Promise<DrainSummary | null> {
  if (deps.drain) return deps.drain(deliveryId);
  // workflow-kernel-library.md §3: in own mode the web host never drains an effect inline;
  // it asks the control plane to drain this delivery, and the control plane's floor is the backstop.
  if (!(await hostsKernelHere())) return drainOnControlPlane(deliveryId);
  try {
    const kernelEffectHandlers = await effectHandlers();
    // Effects can enqueue follow-ups for the same delivery; a few passes settle it.
    let total: DrainSummary | null = null;
    for (let pass = 0; pass < 3; pass++) {
      const s = await runEffects({ handlers: kernelEffectHandlers, deliveryId, limit: 10, exec: deps.exec });
      total = total
        ? { claimed: total.claimed + s.claimed, done: total.done + s.done, skipped: total.skipped + s.skipped, failed: total.failed + s.failed, lost: total.lost + s.lost, dead: [...total.dead, ...s.dead] }
        : s;
      if (s.claimed === 0) break;
    }
    // The landing lane: a delivery that just left the refresh window frees its lane, and the
    // oldest refresh parked behind it is made due and drained here, by this same drain.
    // Isolated: the lane row expires on its own, so a failed release costs the lease, not the drain.
    const woken = await settleLanes(deps.exec ?? seamExec, deliveryId).catch((err) => {
      console.error(`[workflow] landing lane release for delivery ${deliveryId} failed:`, err);
      return [] as string[];
    });
    for (const waiter of woken) if (waiter !== deliveryId) await drainDelivery(waiter, deps);
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
  /** A preflight finding for the PR's head, recorded as policy evidence before the owner hand-off (T28). */
  policy?: PolicyFinding;
}

export interface PolicyFinding { outcome: PolicyOutcome; reason: string; destructive: boolean }

/**
 * Pure: what a pre-flight escalation asks of the platform, as the policy
 * evidence the workflow kernel records (docs/specs/workflow-state-kernel.md
 * §6.3 T28).
 *
 *  - A PR that mixes safe EXPAND and CONTRACT migrations is agent work: split
 *    it, ship the additive half first. Nobody needs to decide anything.
 *  - Everything else the pre-flight escalated (destructive SQL, an
 *    uninspectable migration, a deny path, a human-tier workspace policy) is a
 *    person's decision, and `destructive` marks the migration cases that keep
 *    the explicit human approval rail.
 */
export function policyFindingFor(p: {
  reason: string;
  migrationSafety?: MigrationSafety;
}): PolicyFinding {
  const ms = p.migrationSafety;
  if (ms && !ms.safe && ms.mixedSplit === true) {
    return { outcome: 'agent_split', reason: p.reason, destructive: false };
  }
  return { outcome: 'human', reason: p.reason, destructive: !!ms && !ms.safe && !ms.collision };
}


/**
 * T28: import a preflight finding as policy evidence bound to the PR's LIVE head
 * (read now, never the webhook's). CAS through the kernel, effects through the
 * outbox; the same finding on the same head replays as a duplicate, and a head
 * that moved meanwhile makes it stale (no escalation). Null = not the kernel's PR.
 */
export async function recordPolicyEvidence(p: {
  workspaceId: string; repoFullName: string; prNumber: number; installationId: number; source: string; finding: PolicyFinding;
}, deps: SeamDeps = {}): Promise<CommandResult | null> {
  const deliveryId = await kernelDeliveryForPr(p.workspaceId, p.repoFullName, p.prNumber, deps.exec);
  if (!deliveryId) return null;
  const live = await readerFor(deps, p.installationId).readPr(p.repoFullName, p.prNumber);
  if (!live || live.state !== 'open') return null;
  const result = await applyCommand(
    { type: 'PolicyEvidenceRecorded', actor: p.source, evidence: { headSha: live.headSha, ...p.finding } },
    { ref: { deliveryId }, exec: deps.exec },
  );
  await drainDelivery(deliveryId, deps);
  return result;
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
  const ws = await db.query.workspaces.findFirst({ where: sqlWhere(eq(workspaces.id, p.workspaceId)), columns: { id: true, gitConfig: true } });
  if (!ws || !kernelEnabled(ws.gitConfig)) return { owned: false, reason: 'kernel_off' };

  // The owner task must be the workspace's own: a command names both, and they are checked together.
  const task = await db.query.tasks.findFirst({
    where: sqlWhere(and(eq(tasks.id, p.ownerTaskId), eq(tasks.workspaceId, p.workspaceId))),
    columns: { id: true, status: true, category: true, kind: true, deliveryId: true, deliveryRole: true },
  });
  if (!task) return { owned: false, reason: 'no_task' };
  if (task.category === 'review') return { owned: false, reason: 'review_task' };
  if (task.deliveryId && task.deliveryRole !== 'owner') return { owned: false, reason: 'attempt_task' };

  // Already owned (the other door got here first)?
  const byPr = await kernelDeliveryForPr(p.workspaceId, p.repoFullName, p.prNumber, deps.exec);
  if (byPr) {
    if (p.policy) await recordPolicyEvidence({ ...p, finding: p.policy }, deps);
    return { owned: true, deliveryId: byPr };
  }
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
  // Before the late hand-off below: an ended owner attempt reads this evidence when it picks
  // between a review round and a person.
  if (p.policy) await recordPolicyEvidence({ ...p, finding: p.policy }, { ...deps, drain: async () => null });

  // The owner attempt may already have ended (the PR webhook can arrive after
  // the worker completed, or the completion PATCH ran while this open did its
  // reads and saw no delivery yet). An ended attempt with nobody to hand on would
  // leave the delivery in WORKING with no owner of the next move. The task and
  // worker are re-read here, not taken from the read at the top (bb6a3a56).
  const sent = await forwardOwnerEnd({ workspaceId: p.workspaceId, ownerTaskId: p.ownerTaskId, deliveryId, source: `${p.source}:late_open` }, deps);
  if (!sent && task.kind === 'coordination') {
    // edc02148: a coordination owner keeps running after it opens its PR (it watches other PRs,
    // or this one land), so its hand-off (§6.5 row 1) can be hours away. Its PR is reviewed now
    // (T5 from WORKING), not when the coordination ends.
    const live = await reader.readPr(p.repoFullName, p.prNumber).catch(() => null);
    if (reviewOwedWhileOwnerRuns(task, live)) {
      await applyCommand(
        { type: 'ReviewRequested', actor: `${p.source}:coordination_owner`, headSha: live!.headSha, live: live!, forced: false },
        { ref: { deliveryId }, exec: deps.exec },
      );
    }
  }
  if (!sent) await drainDelivery(deliveryId, deps);
  return { owned: true, deliveryId };
}

/**
 * edc02148: whether a PR whose owner attempt is still running is reviewed now. Only a
 * coordination owner (its deliverable is action taken elsewhere; it stays assigned after it
 * opens the PR), only an open, non-draft PR. Exported for tests.
 */
export function reviewOwedWhileOwnerRuns(task: { kind?: string | null }, live: LivePr | null): boolean {
  return task.kind === 'coordination' && !!live && live.state === 'open' && !live.merged && !live.draft;
}

/**
 * AC-1 slice 3 (task-projection.ts `projectOwnerEndSql`): project an owner attempt's end onto its
 * task outside a transition. The seam runs it after every owner end; the worker PATCH runs it
 * after handing the end to the kernel, so a control plane that is down, or one too old to
 * project, still leaves the task settled. Moves only an open owner task. Answers the status
 * written, or null when nothing moved.
 */
export async function projectOwnerEnd(
  p: { deliveryId: string; taskId: string; workerId: string; status: 'completed' | 'failed' | 'lost' | 'unproven' },
  exec: Exec = seamExec,
): Promise<'completed' | 'failed' | null> {
  const fallback = p.status === 'completed' ? 'completed' : 'failed';
  const rows = ((await exec(projectOwnerEndSql({ deliveryId: p.deliveryId, taskId: p.taskId, workerId: p.workerId, fallback }))).rows ?? []) as Array<{ status?: string }>;
  const s = rows[0]?.status;
  return s === 'completed' || s === 'failed' ? s : null;
}

/**
 * AC-1 slice 3: an owner task still open whose latest worker ended (`ownerAttemptEndOf`, the
 * floor's own settle rule) gets that end projected, for a delivery that already moved past WORKING.
 * Answers the status written, or null.
 */
async function settleOwnerTask(p: { ownerTaskId: string; deliveryId: string }, deps: SeamDeps): Promise<'completed' | 'failed' | null> {
  const task = await db.query.tasks.findFirst({ where: sqlWhere(eq(tasks.id, p.ownerTaskId)), columns: { status: true, claimedAt: true } });
  if (!task || (task.status !== 'assigned' && task.status !== 'in_progress')) return null;
  const rows = await db.query.workers.findMany({
    where: sqlWhere(eq(workers.taskId, p.ownerTaskId)),
    columns: { id: true, runner: true, status: true, createdAt: true, updatedAt: true },
    orderBy: sqlOrderBy([desc(workers.createdAt), desc(workers.id)]),
  });
  // Only attempt rows: a placeholder (a second PR's sibling row) is no attempt and no end.
  const attempts = rows.filter(isAttemptRow);
  // A live attempt is still running the task: nothing to settle.
  if (attempts.some((r) => !isTerminalWorkerStatus(r.status))) return null;
  const latest = attempts[0];
  const end = latest ? ownerAttemptEndOf(task, latest) : null;
  if (!latest || !end) return null;
  return projectOwnerEnd({ deliveryId: p.deliveryId, taskId: p.ownerTaskId, workerId: latest.id, status: end }, deps.exec);
}

/**
 * bb6a3a56: the owner end the kernel is owed, rebuilt from the workers row.
 * Stamps `tasks.delivery_id` when it is missing (a crash between the open's
 * transitions and its stamp), then, when the owner's latest worker ended, sends
 * that worker's AttemptEnded. The end is the worker row's (AC-1 slice 2,
 * `ownerAttemptEndOf`), not `tasks.status`: a task left `assigned` because its
 * end never arrived still gets it re-sent once the worker row has settled. Safe to repeat: the reducer keys an
 * end by its worker (`end:<workerId>`), so one the kernel already has answers
 * `duplicate`. Answers whether an end was sent.
 */
async function forwardOwnerEnd(p: { workspaceId: string; ownerTaskId: string; deliveryId: string; source: string }, deps: SeamDeps): Promise<boolean> {
  await db.update(tasks)
    .set({ deliveryId: p.deliveryId, deliveryRole: 'owner' })
    .where(and(eq(tasks.id, p.ownerTaskId), sql`${tasks.deliveryId} IS NULL`));
  const task = await db.query.tasks.findFirst({ where: sqlWhere(eq(tasks.id, p.ownerTaskId)), columns: { status: true, claimedAt: true, deliveryId: true, deliveryRole: true } });
  if (!task || task.deliveryId !== p.deliveryId || task.deliveryRole !== 'owner') return false;
  const latest = await db.query.workers.findFirst({
    where: sqlWhere(eq(workers.taskId, p.ownerTaskId)),
    columns: { id: true, status: true, lastCommitSha: true, commitCount: true, createdAt: true, updatedAt: true },
    orderBy: sqlOrderBy([desc(workers.createdAt)]),
  });
  const end = latest ? ownerAttemptEndOf(task, latest) : null;
  if (!latest || !end) return false;
  await attemptEnded({
    task: { id: p.ownerTaskId, workspaceId: p.workspaceId, deliveryId: p.deliveryId, deliveryRole: 'owner', context: null },
    workerId: latest.id,
    status: end,
    localHeadSha: latest.lastCommitSha ?? null,
    commitCount: latest.commitCount ?? 0,
    source: p.source,
  }, deps);
  return true;
}

// ── §14: one authority per delivery ─────────────────────────────────────────

/**
 * The kernel delivery that owns PR `prNumber` of the workspace's repo, with the
 * state a person would be acting against; null = legacy-owned (or no repo).
 * A door that would file legacy review-family work (a fix task with no
 * delivery and no ledger row) checks this first and refuses on a kernel PR.
 */
export async function kernelDeliveryOfPr(p: { workspaceId: string; prNumber: number }, deps: SeamDeps = {}): Promise<{
  deliveryId: string; state: string | null; stateReason: string | null; version: number;
} | null> {
  const repo = await (deps.repoFor ?? workspaceRepo)(p.workspaceId);
  if (!repo) return null;
  const deliveryId = await kernelDeliveryForPr(p.workspaceId, repo.repoFullName, p.prNumber, deps.exec);
  if (!deliveryId) return null;
  const d = (await loadView({ deliveryId }, deps.exec)).delivery;
  return { deliveryId, state: d?.state ?? null, stateReason: d?.stateReason ?? null, version: d?.version ?? 0 };
}

// ── T23: a person applies an escalation's recommendation ────────────────────

export interface HumanApplyOutcome {
  result: CommandResult;
  /** The delivery as it stands after the inline drain (a stale answer's "current view", §7.2). */
  current: CurrentView & { stateReason: string | null };
  /** The review_fix ledger row this dispatch allocated (trigger=human), and its fix task. */
  attempt: { id: string; attemptNo: number; maxAttempts: number; taskId: string | null } | null;
}

/**
 * "Apply" / "Apply with corrections" on a kernel-owned PR's escalation (§6.3 T23): one
 * HumanResolve(apply_recommendation) at the version the person saw, recording them and the
 * bypass, then the kernel's own dispatch_fix: a review_fix ledger row with trigger=human,
 * §10.5 revalidation against a live read, and a fix task carrying their instructions.
 * `expectedVersion` absent = the version this call read before recording the live head, so
 * a push that lands mid-click still makes the click stale. Null = not the kernel's PR.
 */
export async function applyRecommendationThroughKernel(p: {
  workspaceId: string; prNumber: number; actor: string; expectedVersion?: number | null; instructions?: string | null;
}, deps: SeamDeps = {}): Promise<HumanApplyOutcome | null> {
  const repo = await (deps.repoFor ?? workspaceRepo)(p.workspaceId);
  if (!repo) return null;
  const deliveryId = await kernelDeliveryForPr(p.workspaceId, repo.repoFullName, p.prNumber, deps.exec);
  if (!deliveryId) return null;
  const seen = (await loadView({ deliveryId }, deps.exec)).delivery;
  const expectedVersion = p.expectedVersion ?? seen?.version ?? 0;
  const currentOf = async (): Promise<CurrentView & { stateReason: string | null }> => {
    const d = (await loadView({ deliveryId }, deps.exec)).delivery;
    return { state: d?.state ?? null, stateReason: d?.stateReason ?? null, version: d?.version ?? 0, head: d?.currentHeadSha ?? null, round: d?.currentRound ?? 0 };
  };
  const reader = readerFor(deps, repo.installationId);
  const live = await reader.readPr(repo.repoFullName, p.prNumber);
  if (!live) {
    const current = await currentOf();
    return { result: { result: 'rejected', reason: 'live_read_failed', current: { state: current.state, version: current.version, head: current.head, round: current.round } }, current, attempt: null };
  }
  await ingestFact({ kind: 'head_observed', workspaceId: p.workspaceId, source: `${p.actor}:apply_recommendation`, repoFullName: repo.repoFullName, prNumber: p.prNumber },
    { exec: deps.exec, github: { ...reader, readPr: async () => live } });
  const result = await applyCommand(
    { type: 'HumanResolve', actor: p.actor, choice: 'apply_recommendation', expectedVersion, instructions: p.instructions ?? undefined },
    { ref: { deliveryId }, exec: deps.exec },
  );
  if (result.result === 'applied') await drainDelivery(deliveryId, deps);
  const view = await loadView({ deliveryId }, deps.exec);
  const human = result.result === 'applied'
    ? view.attempts
      .filter((a) => a.family === 'review_fix' && a.trigger === 'human' && (a.status === 'queued' || a.status === 'running'))
      .sort((a, b) => b.attemptNo - a.attemptNo)[0]
    : undefined;
  return {
    result,
    current: await currentOf(),
    attempt: human ? { id: human.id, attemptNo: human.attemptNo, maxAttempts: human.maxAttempts, taskId: human.taskId } : null,
  };
}

// ── a90fc99b: the escalation gate's policy-merge rule ───────────────────────

/**
 * The policy-merge rule's verdict, executed: PolicyMergeApproved for exactly
 * `headSha`, then the inline drain. The delivery is APPROVED on the basis
 * `policy_rule`, and the landing doors land it under the workspace merge
 * policy with every rail evaluated again (a refusal is the landing hand-off
 * the gate then shows a person). Null = not the kernel's PR.
 */
export async function policyMergeThroughKernel(p: {
  workspaceId: string; prNumber: number; headSha: string; reason: string; rule?: string;
}, deps: SeamDeps = {}): Promise<CommandResult | null> {
  const repo = await (deps.repoFor ?? workspaceRepo)(p.workspaceId);
  if (!repo) return null;
  const deliveryId = await kernelDeliveryForPr(p.workspaceId, repo.repoFullName, p.prNumber, deps.exec);
  if (!deliveryId) return null;
  const result = await applyCommand(
    { type: 'PolicyMergeApproved', actor: `rule:${p.rule ?? 'escalation_gate'}`, headSha: p.headSha, reason: p.reason },
    { ref: { deliveryId }, exec: deps.exec },
  );
  if (result.result === 'applied') await drainDelivery(deliveryId, deps);
  return result;
}

// ── T4: an attempt ended ────────────────────────────────────────────────────

export interface AttemptTask {
  id: string;
  workspaceId: string;
  deliveryId: string | null;
  deliveryRole: string | null;
  context: unknown;
}

/**
 * Whether a reviewer task is a review round of a kernel-owned delivery (§6.3
 * T27): its contract failures are the kernel's to decide, never the legacy
 * prose fallback, same-task requeue or escalation. A delivery the kill switch
 * released is legacy again.
 */
export async function isKernelReviewRound(task: { deliveryId?: string | null; context?: unknown }, deps: SeamDeps = {}): Promise<boolean> {
  if (!task.deliveryId || !ctxOf(task).workflowRoundId) return false;
  return !!(await kernelDeliveryById(task.deliveryId, deps.exec));
}

export async function attemptEnded(p: {
  task: AttemptTask;
  workerId: string;
  /**
   * `lost`: the reaper ended it (no report, no local head known).
   * `unproven`: the runner's hand-off failed after work (§6.6, S30): the work
   * is not on GitHub, which is not the same as the work having failed.
   */
  status: 'completed' | 'failed' | 'lost' | 'unproven';
  localHeadSha: string | null;
  commitCount: number;
  source: string;
  /** The task's own retry is queued (its retry count, not a ledger): an owner end with nothing local stays WORKING. */
  taskRetryBudgetLeft?: boolean;
  /** 295486ba: the end is the task being cancelled; a CI repair nobody claimed then spends nothing. */
  cancelled?: boolean;
  /**
   * A reviewer that completed but broke its output contract (§6.6): `prose_verdict`
   * (a verdict written as prose, never applied) or `no_verdict`. Absent = infra.
   * `human_takeover`: a person interrupted the reviewer; never re-queued.
   */
  reviewFailure?: 'prose_verdict' | 'no_verdict' | 'infra' | 'human_takeover';
  /** §13.13 rule 4: a review fix's verified no-op claim (`noopEvidenceOf`). */
  noopEvidence?: { findingIds: string[]; evidence: string } | null;
}, deps: SeamDeps = {}): Promise<{ handled: boolean; result?: CommandResult }> {
  const attemptKind = p.task.deliveryRole;
  if (!p.task.deliveryId || (attemptKind !== 'owner' && !isRepairRole(attemptKind) && attemptKind !== 'review')) return { handled: false };
  const deliveryId = await kernelDeliveryById(p.task.deliveryId, deps.exec);
  if (!deliveryId) {
    // §14: the owner's end is where the kernel would have queued round 1. A delivery the kill
    // switch released before that has had no review from either authority: legacy files it now.
    if (attemptKind === 'owner') await handOffToLegacy(p.task.deliveryId, deps);
    return { handled: false };
  }

  if (attemptKind === 'review') {
    // A completed reviewer is answered by its verdict (T6). One that ended
    // without a verdict fails its round (T27): re-queued at the same head and
    // round number, then review_unavailable. Never inferred as a verdict.
    if (p.status === 'completed') return { handled: true };
    const roundId = ctxOf(p.task).workflowRoundId as string | undefined;
    if (!roundId) return { handled: true };
    const result = await applyCommand(
      { type: 'ReviewRoundFailed', actor: p.source, roundId, reason: p.reviewFailure ?? 'infra', maxContractRetries: REVIEW_CONTRACT_RETRIES, reviewerTaskId: p.task.id },
      { ref: { deliveryId }, exec: deps.exec },
    );
    await drainDelivery(deliveryId, deps);
    return { handled: true, result };
  }

  const view = await loadView({ deliveryId }, deps.exec);
  const d = view.delivery;
  if (!d) return { handled: false };
  let live: LivePr | null = null;
  let proof: { liveContainsLocal: boolean; contentDiffChanged?: boolean } | undefined;
  let ci: Extract<Command, { type: 'AttemptEnded' }>['ci'] = null;
  let trunk: TrunkClassification | null = null;
  if (d.repoFullName && d.prNumber != null) {
    const repo = await (deps.repoFor ?? workspaceRepo)(p.task.workspaceId);
    if (repo) {
      const reader = readerFor(deps, repo.installationId);
      live = await reader.readPr(d.repoFullName, d.prNumber);
      proof = await liveProof(reader, d.repoFullName, p.localHeadSha, live);
      // e9f1674b: a CI failure hint that arrived while the owner worked was refused (T10 does
      // not move WORKING). The owner's hand-off reads the head's checks now and acts on a red.
      if (attemptKind === 'owner' && d.state === 'WORKING' && live && live.state === 'open' && !live.merged && reader.checkRuns) {
        const liveChecks = await reader.checkRuns(d.repoFullName, live.headSha).catch(() => null);
        if (liveChecks) {
          // §6.10: classified as T10 would; a trunk-caused red is handed on and then T25's.
          const cls = liveChecks.failing.length > 0
            ? await classifyCiFailure({ workspaceId: p.task.workspaceId, repoFullName: d.repoFullName, baseRef: live.baseRef ?? d.baseRef, headSha: live.headSha, deliveryId, gitConfig: repo.gitConfig, reader, exec: deps.exec })
            : null;
          if (cls?.incident) trunk = cls;
          else {
            const configured = (repo.gitConfig as { maxCiRetries?: unknown } | null)?.maxCiRetries;
            ci = { liveChecks, signature: cls?.signature ?? UNKNOWN_CI_SIGNATURE, maxAttempts: typeof configured === 'number' ? configured : policyValue('maxCiRetries') };
          }
        }
      }
    }
  }
  const attemptId = isRepairRole(attemptKind) ? (ctxOf(p.task).workflowAttemptId as string | undefined) : undefined;
  // A CI repair that ended without a push (cancelled by a person, lost, failed) while the head it was
  // bound to reads green now (an infrastructure failure re-run green) is not a failed attempt to retry:
  // CI is fixed, so the repair ends and the delivery resumes (38442d17). Otherwise the ledger would queue
  // another fix task that, on a mission no runner serves, nobody claims.
  const ciAttempt = attemptId ? view.attempts.find((a) => a.id === attemptId) : undefined;
  if (p.status !== 'completed' && ciAttempt?.family === 'ci' && d.state === 'REPAIRING' && d.boundAttemptId === ciAttempt.id
    && live && live.state === 'open' && !live.merged && live.headSha === ciAttempt.boundHeadSha && d.currentHeadSha === live.headSha && d.repoFullName) {
    const repo = await (deps.repoFor ?? workspaceRepo)(p.task.workspaceId);
    const reader = repo ? readerFor(deps, repo.installationId) : null;
    const liveChecks = reader?.checkRuns ? await reader.checkRuns(d.repoFullName, live.headSha).catch(() => null) : null;
    if (reader?.ciGreen && liveChecks && (await reader.ciGreen(d.repoFullName, live.headSha).catch(() => null)) === true) {
      const green = await applyCommand({ type: 'CiGreenObserved', actor: `${p.source}:ci_green`, headSha: live.headSha, liveChecks, allPassing: true }, { ref: { deliveryId }, exec: deps.exec });
      if (green.result === 'applied') {
        await drainDelivery(deliveryId, deps);
        return { handled: true, result: green };
      }
    }
  }
  // §5: what the repair changed since the head it was bound to, read only when an open finding names a path.
  let changedPaths: string[] | null = null;
  const boundHead = attemptId ? view.attempts.find((a) => a.id === attemptId)?.boundHeadSha ?? null : null;
  if (boundHead && live && live.headSha !== boundHead && d.repoFullName && openFindings(view).some((f) => f.status === 'open' && f.path)) {
    const repo = await (deps.repoFor ?? workspaceRepo)(p.task.workspaceId);
    const reader = repo ? readerFor(deps, repo.installationId) : null;
    changedPaths = reader?.changedPaths ? await reader.changedPaths(d.repoFullName, boundHead, live.headSha).catch(() => null) : null;
  }
  // 1bd26ae7: a repair that pushed from somewhere the runner cannot see (an interactive session, another
  // checkout) reports no local head. Its proof is §9's "L unknown" rule: the PR head moved off the head the
  // repair was bound to. The re-review that follows decides whether it fixed anything.
  // A fix that rebased and force-pushed does not descend from the bound head, so ancestry is no test of
  // "the attempt's push": the head moved and is the PR head now, whichever order the push and the
  // completion arrived in.
  const reported = attemptId ? view.attempts.find((a) => a.id === attemptId)?.reportedShas.length ?? 0 : 0;
  // Only an end with nothing local to lose (AC-10): an unproven end that reported commits is not proof.
  if ((p.status === 'completed' || p.commitCount === 0) && !p.localHeadSha && !proof && reported === 0 && boundHead && live && live.state === 'open' && !live.merged && live.headSha !== boundHead && d.repoFullName) {
    proof = { liveContainsLocal: false, contentDiffChanged: true };
  }
  // 58c8961e: a repair's head on an approved delivery may be reviewed as a delta of the approval.
  let delta: DeltaReading | null = null;
  if (attemptKind !== 'owner' && live && live.state === 'open' && !live.merged && d.repoFullName && deltaApprovalSource(view)) {
    const repo = await (deps.repoFor ?? workspaceRepo)(p.task.workspaceId);
    const reader = repo ? readerFor(deps, repo.installationId) : undefined;
    delta = await readDeltaForApproval(view, d.repoFullName, live, reader);
  }
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
    ...(p.taskRetryBudgetLeft ? { taskRetryBudgetLeft: true } : {}),
    ...(p.cancelled ? { cancelled: true } : {}),
    // The kernel owns only deliveries whose policy dispatched a review (§14 Slice A).
    reviewRequired: true,
    ...(ci ? { ci } : {}),
    ...(changedPaths ? { changedPaths } : {}),
    ...(delta ? { delta } : {}),
    ...(p.noopEvidence && attemptKind === 'fix' ? { noopEvidence: p.noopEvidence } : {}),
  };
  const result = await applyCommand(cmd, { ref: { deliveryId }, exec: deps.exec });
  if (result.result !== 'applied' && result.result !== 'duplicate') {
    console.log(`[workflow] AttemptEnded(${attemptKind}) for task ${p.task.id}: ${result.result} (${result.reason})`);
  }
  // AC-1 slice 3: an applied owner end set the task in its own statement (`t_attempt`). One that
  // applied nothing (a duplicate, a stale end) still projects, from the ledger's recorded end, so
  // the task never strands open. A no-op once the task is settled; a requeue (the task's own
  // retry is queued) is no end to project.
  if (attemptKind === 'owner' && !p.taskRetryBudgetLeft) {
    await projectOwnerEnd({ deliveryId, taskId: p.task.id, workerId: p.workerId, status: p.status }, deps.exec);
  }
  if (trunk?.incident && live && result.result === 'applied' && TRUNK_SOURCE_STATES.has(result.decision.toState)) {
    await applyCommand(
      { type: 'TrunkRedObserved', actor: p.source, incidentId: trunk.incident.id, signature: trunk.signature, headSha: live.headSha, thresholdMet: true },
      { ref: { deliveryId }, exec: deps.exec },
    );
    if (trunk.incident.opened) {
      await joinRepairingDeliveries({ incident: trunk.incident, workspaceId: p.task.workspaceId, repoFullName: d.repoFullName!, baseRef: live.baseRef ?? d.baseRef ?? '', excludeDeliveryId: deliveryId }, deps);
    }
  }
  await drainDelivery(deliveryId, deps);
  // An end that leaves the delivery APPROVED (a verdict kept while the owner worked, now applied)
  // is the moment landing becomes possible: the landing door deferred while the delivery was WORKING
  // and nothing else wakes it, so ask the landing sweep to look at this PR now.
  if (result.result === 'applied' && result.decision.toState === 'APPROVED' && d.prNumber != null) {
    await (deps.markLandingDue ?? markLandingDue)(`${p.task.workspaceId}:${d.prNumber}`).catch((err) => console.warn('[workflow] could not mark landing due:', err));
  }
  return { handled: true, result };
}

async function markLandingDue(member: string): Promise<void> {
  const [{ markDue }, { PR_LANDING_DUE_QUEUE }] = await Promise.all([import('@/lib/redis'), import('@/lib/landing-due-queue')]);
  await markDue(PR_LANDING_DUE_QUEUE, member, Date.now());
}

// ── §14: switch-off hands a never-reviewed delivery to legacy ──────────────

/**
 * A delivery the kill switch released before its first round was queued is
 * legacy's, and legacy files a PR's first review only when the PR opens, a
 * moment that has passed. The package's `handOffToLegacyOn` decides (released,
 * never reviewed, switch still off, PR open, once per owner task) and the
 * reviews module's `HandOff` port files legacy's first review. The switch is
 * read as this workspace's repo row has it (`deps.repoFor`). Never throws:
 * answers what it did.
 */
export async function handOffToLegacy(deliveryId: string, deps: SeamDeps = {}): Promise<string> {
  try {
    const [{ builddKernelPorts }, { policyFromGitConfig }, { handOffToLegacyOn }, m] = await Promise.all([
      import('./kernel-ports'), import('./kernel-policy'), import('@buildd/workflow-kernel/handlers/hand-off'), import('@/modules'),
    ]);
    const repoFor = deps.repoFor ?? workspaceRepo;
    const ports = builddKernelPorts(m.workflowKernelHooks({ exec: deps.exec, repoFor }), {
      exec: deps.exec,
      githubFor: async (ws) => { const repo = await repoFor(ws); return repo ? readerFor(deps, repo.installationId) : null; },
      policy: { forWorkspace: async (ws) => policyFromGitConfig((await repoFor(ws))?.gitConfig ?? null) },
    });
    return await handOffToLegacyOn(ports, deliveryId, (msg, err) => console.error(msg, err));
  } catch (err) {
    console.error(`[workflow] legacy hand-off of delivery ${deliveryId} failed:`, err);
    return 'error';
  }
}

// ── §9 completion gate ──────────────────────────────────────────────────────

export interface GateRefusal {
  code: 'delivery_not_advanced' | 'repair_still_conflicted' | 'repair_still_colliding' | 'repair_unrelated_diff';
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
/**
 * §13.13 rule 4: a review fix's claim that the findings' condition is already
 * absent at the head, read off its completion output (`structuredOutput.noopEvidence`:
 * `{ findingIds, evidence }`). Malformed or empty = no claim.
 */
export function noopEvidenceOf(output: unknown): { findingIds: string[]; evidence: string } | null {
  const o = (output && typeof output === 'object' ? (output as Record<string, unknown>).noopEvidence : null) as Record<string, unknown> | null | undefined;
  if (!o || typeof o !== 'object') return null;
  const ids = Array.isArray(o.findingIds) ? o.findingIds.filter((x): x is string => typeof x === 'string' && !!x.trim()) : [];
  const evidence = typeof o.evidence === 'string' ? o.evidence.trim() : '';
  return ids.length && evidence ? { findingIds: ids, evidence } : null;
}

/**
 * §13.13 rule 4: a review fix's explicit claim that its push fixes the findings it names
 * somewhere the completion check does not look (another package, generated code), read off
 * `structuredOutput.fixedElsewhere`: `{ findingIds, files, reason }`. All three are required.
 * Never a resolution: the re-review at the new head verifies it like any fix.
 */
export function fixedElsewhereOf(output: unknown): { findingIds: string[]; files: string[]; reason: string } | null {
  const o = (output && typeof output === 'object' ? (output as Record<string, unknown>).fixedElsewhere : null) as Record<string, unknown> | null | undefined;
  if (!o || typeof o !== 'object') return null;
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()) : []);
  const findingIds = strs(o.findingIds);
  const files = strs(o.files);
  const reason = typeof o.reason === 'string' ? o.reason.trim() : '';
  return findingIds.length && files.length && reason ? { findingIds, files, reason } : null;
}

export async function fixCompletionGate(p: {
  task: AttemptTask; localHeadSha: string | null;
  noopEvidence?: { findingIds: string[]; evidence: string } | null;
  fixedElsewhere?: { findingIds: string[]; files: string[]; reason: string } | null;
}, deps: SeamDeps = {}): Promise<GateRefusal | null> {
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
  if (p.task.deliveryRole === 'conflict_fix') {
    // One evidence rule with legacy conflict retries (§13.11 rule 2): a moved
    // head that is still dirty is refused, an unmoved head GitHub shows clean
    // is allowed. The collision itself is not re-inspected here (null).
    const { repairCompletionVerdict } = await import('@/lib/repair-completion');
    const v = repairCompletionVerdict({
      kind: attempt.family === 'migration' ? 'migration' : 'conflict',
      prNumber: d.prNumber, boundHeadSha: attempt.boundHeadSha ?? null, live, collisionPresent: null, localHeadSha: p.localHeadSha,
    });
    if (v.ok) return null;
    if (v.code !== 'repair_not_advanced') {
      return { code: v.code, error: v.error, hint: v.hint, boundHeadSha: attempt.boundHeadSha, liveHeadSha: live.headSha, localHeadSha: p.localHeadSha };
    }
  } else if (live.headSha !== attempt.boundHeadSha) {
    // §13.13 rule 4: a review fix's push has to be able to answer the findings. Refused only when it
    // plainly cannot (diffTouchesFindings: every open finding has a path and nothing near any of them,
    // nor any path the reviewer's feedback names, changed). A person's fix (T23) is theirs to judge,
    // and an explicit `fixedElsewhere` claim naming open findings, the files and why passes to the
    // re-review, which verifies it like any fix.
    const ctx = ctxOf(p.task);
    const human = ctx.trigger === 'human';
    const claim = p.fixedElsewhere && openFindings(view).some((f) => p.fixedElsewhere!.findingIds.includes(f.id)) ? p.fixedElsewhere : null;
    if (p.task.deliveryRole === 'fix' && !human && !claim && attempt.boundHeadSha) {
      const reader = readerFor(deps, repo.installationId);
      const changed = reader.changedPaths ? await reader.changedPaths(d.repoFullName, attempt.boundHeadSha, live.headSha).catch(() => null) : null;
      const feedback = (ctx.failureContext as { summary?: unknown } | undefined)?.summary;
      if (diffTouchesFindings(view, changed, pathsNamedIn(typeof feedback === 'string' ? feedback : null)) === false) {
        const named = openRequiredFindings(view).filter((f) => f.path).map((f) => f.path!);
        return {
          code: 'repair_unrelated_diff',
          error: `Your push to PR #${d.prNumber} changes nothing near the files the open review findings name (${[...new Set(named)].slice(0, 5).join(', ')}), nor anything the review's feedback names.`,
          hint: 'Fix the findings and push. If the fix belongs somewhere else, complete with structuredOutput.fixedElsewhere { findingIds, files, reason } naming the findings, the files you changed and why; the re-review verifies it.',
          boundHeadSha: attempt.boundHeadSha, liveHeadSha: live.headSha, localHeadSha: p.localHeadSha,
        };
      }
    }
    return null;
  } else if (p.task.deliveryRole === 'fix' && p.noopEvidence && openFindings(view).some((f) => p.noopEvidence!.findingIds.includes(f.id))) {
    // A verified no-op claim: nothing to push. Completing is allowed; a review at this head verifies it.
    return null;
  } else if (p.task.deliveryRole === 'ci_fix' && (await readerFor(deps, repo.installationId).ciGreen?.(d.repoFullName, live.headSha)) === true) {
    // The failure was not in the code (e.g. a PR-body check fixed by editing the
    // body): CI on the unchanged head is green now, so there is nothing to push.
    return null;
  }
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
  // Only the task's own workspace's delivery: the command's input names the workspace it was checked for.
  const deliveryId = await kernelDeliveryById(task.deliveryId, deps.exec, task.workspaceId);
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
  /** The workspace the verdict is for: a delivery of any other is not this round's (AC-9's reach check judged this one). */
  workspaceId?: string;
  reviewerTask: { id: string; deliveryId: string | null; context: unknown };
  verdict: string;
  effectiveVerdict: string;
  headSha: string;
  confidence: number | null;
  /** What the reviewer said about findings (§5): its structured output, read defensively. */
  output?: unknown;
}, deps: SeamDeps = {}): Promise<{ handled: false } | { handled: true; result: CommandResult; toState: string | null }> {
  const roundId = ctxOf(p.reviewerTask).workflowRoundId as string | undefined;
  if (!p.reviewerTask.deliveryId || !roundId) return { handled: false };
  // Fail closed: a delivery of another workspace throws, never `handled: false`, which the PATCH reads
  // as a release to legacy and would answer with a GitHub review and possibly a merge.
  const deliveryId = p.workspaceId
    ? await kernelDeliveryInWorkspace(p.reviewerTask.deliveryId, p.workspaceId, deps.exec)
    : await kernelDeliveryById(p.reviewerTask.deliveryId, deps.exec);
  if (!deliveryId) return { handled: false };
  const result = await applyCommand({
    type: 'ReviewVerdictRecorded',
    actor: `reviewer:${p.reviewerTask.id}`,
    roundId,
    verdict: toKernelVerdict(p.verdict),
    effectiveVerdict: toKernelVerdict(p.effectiveVerdict),
    headBound: p.headSha,
    confidence: p.confidence,
    ...(await resolveDeferralTasks(verdictFindingsOf(p.output), deliveryId, deps.exec ?? seamExec)),
  }, { ref: { deliveryId }, exec: deps.exec });
  await drainDelivery(deliveryId, deps);
  return { handled: true, result, toState: result.result === 'applied' ? result.decision.toState : null };
}

/**
 * 00d288fd: a reviewer that ran outside the kernel's rounds (filed by a door
 * before the delivery opened) judged a PR the kernel owns. Its verdict at the
 * current head is the kernel's to keep: recorded as a decided round while the
 * owner still works, and applied when the owner ends, so the same head is not
 * reviewed a second time. A verdict for another head is stale and does nothing.
 */
export async function adoptReviewVerdict(p: {
  /** The workspace the verdict is for: a delivery of any other is not adopted. */
  workspaceId?: string;
  deliveryId: string;
  reviewerTaskId: string;
  verdict: string;
  effectiveVerdict: string;
  headSha: string;
  confidence: number | null;
  output?: unknown;
}, deps: SeamDeps = {}): Promise<CommandResult | null> {
  const deliveryId = p.workspaceId
    ? await kernelDeliveryInWorkspace(p.deliveryId, p.workspaceId, deps.exec)
    : await kernelDeliveryById(p.deliveryId, deps.exec);
  if (!deliveryId) return null;
  const result = await applyCommand({
    type: 'ReviewVerdictAdopted',
    actor: `reviewer:${p.reviewerTaskId}`,
    reviewerTaskId: p.reviewerTaskId,
    verdict: toKernelVerdict(p.verdict),
    effectiveVerdict: toKernelVerdict(p.effectiveVerdict),
    headBound: p.headSha,
    confidence: p.confidence,
    ...(await resolveDeferralTasks(verdictFindingsOf(p.output), deliveryId, deps.exec ?? seamExec)),
  }, { ref: { deliveryId }, exec: deps.exec });
  await drainDelivery(deliveryId, deps);
  return result;
}

/**
 * A deferral names its task the way agents cite tasks: often by its short id. The kernel
 * takes only a full id of a task in the delivery's own workspace, so every id is resolved
 * here: a full one must be such a task, a short one must prefix exactly one. Anything else
 * (no task, a task of another workspace, a prefix shared by several) is marked unresolved:
 * the kernel then refuses that deferral and the finding stays open, recorded as unresolved.
 */
export async function resolveDeferralTasks(v: VerdictFindings, deliveryId: string, exec: Exec): Promise<VerdictFindings> {
  if (!v.deferredFindings?.length) return v;
  const deferredFindings = await Promise.all(v.deferredFindings.map(async (d) => {
    const id = d.taskId?.trim().toLowerCase();
    if (!id) return d;
    const unresolved = { ...d, taskId: `unresolved:${id.slice(0, 36)}` };
    if (!/^[0-9a-f-]{8,36}$/.test(id)) return unresolved;
    const match = isTaskId(id) ? sql`t.id = ${id}::uuid` : sql`t.id::text LIKE ${`${id}%`}`;
    const rows = ((await exec(sql`-- workflow:resolve_deferral_task
SELECT t.id FROM tasks t JOIN workflow_deliveries d ON d.workspace_id = t.workspace_id
WHERE d.id = ${deliveryId}::uuid AND ${match}
LIMIT 2`)).rows ?? []) as Array<{ id: string }>;
    return rows.length === 1 ? { ...d, taskId: String(rows[0]!.id) } : unresolved;
  }));
  return { ...v, deferredFindings };
}

/**
 * The §5 half of a reviewer's structured output, as the kernel reads it. An
 * output with no `resolvedFindings` key leaves it absent (an older reviewer:
 * its approval of an unscoped round verifies every open finding); malformed
 * entries are dropped, never guessed at.
 */
export function verdictFindingsOf(output: unknown): VerdictFindings {
  const o = (output && typeof output === 'object' ? output : {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const out: VerdictFindings = {};
  if (Array.isArray(o.findings)) {
    out.findings = o.findings.flatMap((f) => {
      const r = (f && typeof f === 'object' ? f : {}) as Record<string, unknown>;
      const title = str(r.title);
      if (!title) return [];
      return [{
        ...(str(r.id) ? { id: str(r.id) } : {}),
        path: str(r.path), line: typeof r.line === 'number' && Number.isFinite(r.line) ? Math.trunc(r.line) : null, title,
        ...(r.required === false ? { required: false } : {}),
      }];
    });
  }
  if (Array.isArray(o.resolvedFindings)) out.resolvedFindings = o.resolvedFindings.map(str).filter((x): x is string => !!x);
  if (Array.isArray(o.deferredFindings)) {
    out.deferredFindings = o.deferredFindings.flatMap((f) => {
      const r = (f && typeof f === 'object' ? f : {}) as Record<string, unknown>;
      const id = str(r.id); const reason = str(r.reason);
      return id && reason ? [{ id, reason, taskId: str(r.taskId) }] : [];
    });
  }
  return out;
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
}, deps: SeamDeps = {}): Promise<boolean> {
  const deliveryId = await kernelDeliveryForPr(p.workspaceId, p.repoFullName, p.prNumber, deps.exec);
  if (!deliveryId) return false;
  try {
    const res = await ingestFact({
      kind: 'head_observed', workspaceId: p.workspaceId, source: p.source, repoFullName: p.repoFullName, prNumber: p.prNumber,
      hintedHeadSha: p.hintedHeadSha,
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

// ── T29: the PR's base changed (webhook `edited` with `changes.base`) ────────

/** Webhook `edited` with `changes.base`: T29 from a live read. `false` = not the kernel's PR. */
export async function observeBase(p: {
  workspaceId: string; repoFullName: string; prNumber: number; installationId: number; hintedFromBase: string | null; source: string;
}, deps: SeamDeps = {}): Promise<boolean> {
  const deliveryId = await kernelDeliveryForPr(p.workspaceId, p.repoFullName, p.prNumber, deps.exec);
  if (!deliveryId) return false;
  const reader = readerFor(deps, p.installationId);
  try {
    const live = await reader.readPr(p.repoFullName, p.prNumber);
    if (live) await catchUpBase({ ...p, deliveryId, live }, reader, deps.exec);
  } catch (err) {
    console.error(`[workflow] BaseChanged ${p.repoFullName}#${p.prNumber} failed:`, err);
  }
  await drainDelivery(deliveryId, deps);
  return true;
}

// AC-3 (workflow-kernel-library.md §1): a page render, MCP read or explain records at most a fact.
export { deliveryOwnedWorkers, recordPrStateObserved } from './render-observation';

/**
 * A kernel-owned PR whose close or merge the kernel could not take in (S4a): its own live read
 * of GitHub failed, so no transition ran. A fast heal is scheduled (kernel-heal.ts); the caller
 * must not take a legacy path for the PR (the kernel still owns it) and must not report success.
 */
export class KernelObservationFailed extends Error {
  constructor(readonly deliveryId: string, readonly reason: string) {
    super(`kernel could not observe the PR of delivery ${deliveryId}: ${reason}`);
    this.name = 'KernelObservationFailed';
  }
}

/**
 * Webhook `closed` / `reopened`: T17 / T18 / T19 from a live read. Legacy keeps its post-merge work (Slice C).
 * False: the kernel does not own the PR (legacy decides). True: the fact reached the reducer.
 * Throws `KernelObservationFailed` when the kernel owns the PR but its live read failed: the
 * caller's own observation (`pull`, GitHub's pull object, when it has one) is recorded as an
 * unapplied fact and a fast heal is scheduled, so the merge lands in minutes, not on the floor.
 */
export async function observePrState(p: {
  workspaceId: string; repoFullName: string; prNumber: number; installationId: number; source: string; pull?: unknown;
}, deps: SeamDeps = {}): Promise<boolean> {
  const deliveryId = await kernelDeliveryForPr(p.workspaceId, p.repoFullName, p.prNumber, deps.exec);
  if (!deliveryId) return false;
  const r = await ingestFact({ kind: 'pr_closed', workspaceId: p.workspaceId, source: p.source, repoFullName: p.repoFullName, prNumber: p.prNumber },
    { exec: deps.exec, github: readerFor(deps, p.installationId) });
  if (r.result === 'rejected' && r.factId === null) {
    if (p.pull) {
      await recordPrStateObserved({ workspaceId: p.workspaceId, repoFullName: p.repoFullName, prNumber: p.prNumber, pull: p.pull, source: p.source }, deps.exec)
        .catch((err) => console.error(`[workflow] could not record the observed close of ${p.repoFullName}#${p.prNumber}:`, err));
    }
    await scheduleKernelHeal(deliveryId);
    throw new KernelObservationFailed(deliveryId, r.reason);
  }
  await drainDelivery(deliveryId, deps);
  return true;
}

// ── T20 / T21: how a closed PR is resolved (Slice D) ────────────────────────

export type { CommandResult };

export type ResolutionOutcome = { handled: false } | { handled: true; deliveryId: string; result: CommandResult };

const RESOLVED_OR_CLOSED = new Set(['CLOSED_UNMERGED', 'SUPERSEDED', 'ABANDONED', 'MERGED']);

/**
 * A resolution needs the delivery to know the PR closed. If the close webhook
 * was lost, read GitHub now and record it (R2) before deciding, so an edge is
 * never refused for a fact the platform merely missed.
 */
async function catchUpClose(deliveryId: string, p: { workspaceId: string; repoFullName: string; prNumber: number; installationId: number; source: string }, deps: SeamDeps): Promise<void> {
  const d = (await loadView({ deliveryId }, deps.exec)).delivery;
  if (!d || RESOLVED_OR_CLOSED.has(d.state)) return;
  await ingestFact({ kind: 'pr_closed', workspaceId: p.workspaceId, source: p.source, repoFullName: p.repoFullName, prNumber: p.prNumber },
    { exec: deps.exec, github: readerFor(deps, p.installationId) });
}

/**
 * T20 for a kernel-owned PR: `record_pr_supersession`, the supersede route,
 * the mission card's Confirm and the automatic detector. The route authorised
 * the actor (§17.1) and read the target merged; the kernel decides whether
 * the PR may take the edge (closed unmerged, no edge yet). The worker columns
 * are written by the `project_supersession` effect, never by the caller.
 * `handled: false` = legacy PR, the caller's own write runs.
 */
export async function recordSupersession(p: {
  workspaceId: string; repoFullName: string; prNumber: number; installationId: number; actor: string; reason: string;
  target: { repoFullName: string; prNumber: number; url: string | null };
}, deps: SeamDeps = {}): Promise<ResolutionOutcome> {
  const deliveryId = await kernelDeliveryForPr(p.workspaceId, p.repoFullName, p.prNumber, deps.exec);
  if (!deliveryId) return { handled: false };
  await catchUpClose(deliveryId, { ...p, source: 'supersede:catch_up' }, deps);
  const result = await applyCommand({
    type: 'SupersessionRecorded', actor: p.actor, reason: p.reason, authorised: true,
    target: { repoFullName: p.target.repoFullName, prNumber: p.target.prNumber, merged: true, url: p.target.url },
  }, { ref: { deliveryId }, exec: deps.exec });
  await drainDelivery(deliveryId, deps);
  return { handled: true, deliveryId, result };
}

/** T21 for a kernel-owned PR: a person declares the closed PR's work dropped. */
export async function abandonDelivery(p: {
  workspaceId: string; repoFullName: string; prNumber: number; installationId: number; actor: string; reason: string;
}, deps: SeamDeps = {}): Promise<ResolutionOutcome> {
  const deliveryId = await kernelDeliveryForPr(p.workspaceId, p.repoFullName, p.prNumber, deps.exec);
  if (!deliveryId) return { handled: false };
  await catchUpClose(deliveryId, { ...p, source: 'abandon:catch_up' }, deps);
  const result = await applyCommand({ type: 'Abandon', actor: p.actor, reason: p.reason }, { ref: { deliveryId }, exec: deps.exec });
  await drainDelivery(deliveryId, deps);
  return { handled: true, deliveryId, result };
}

// ── T5: a person or agent asks for a review ─────────────────────────────────

/**
 * The human/agent review doors (`request_pr_review`, the dashboard re-review)
 * for a kernel-owned PR. `handled: false` = legacy PR, the door runs as before.
 */
export async function requestReview(p: {
  workspaceId: string; repoFullName: string; prNumber: number; installationId: number; forced: boolean; actor: string;
}, deps: SeamDeps = {}): Promise<{ handled: false } | { handled: true; result: CommandResult; reviewTaskId: string | null }> {
  const deliveryId = await kernelDeliveryForPr(p.workspaceId, p.repoFullName, p.prNumber, deps.exec);
  if (!deliveryId) return { handled: false };
  const reader = readerFor(deps, p.installationId);
  const live = await reader.readPr(p.repoFullName, p.prNumber);
  if (!live) {
    return { handled: true, result: { result: 'rejected', reason: 'live_read_failed', current: { state: null, version: 0, head: null, round: 0 } }, reviewTaskId: null };
  }
  // Record a head the webhook has not delivered yet, so the request names the current head
  // (with the reader's §8.3 evidence, so an approval that still holds is carried, not re-reviewed).
  await ingestFact({ kind: 'head_observed', workspaceId: p.workspaceId, source: `${p.actor}:review_request`, repoFullName: p.repoFullName, prNumber: p.prNumber },
    { exec: deps.exec, github: { ...reader, readPr: async () => live } });
  const result = await applyCommand(
    { type: 'ReviewRequested', actor: p.actor, headSha: live.headSha, live, forced: p.forced },
    { ref: { deliveryId }, exec: deps.exec },
  );
  if (result.result === 'rejected' && result.reason === 'review_in_flight' && !(await roundReviewerAt(deliveryId, live.headSha, deps.exec))) {
    // 1bd26ae7: an open round with no reviewer is not a review in flight. When every dispatch it had
    // finished without filing one, the dispatch is owed again (the floor's rule, run now for the asker).
    await reenqueueOwedEffects(deliveryId, await loadView({ deliveryId }, deps.exec), deps.exec ?? seamExec, 'review request');
  }
  await drainDelivery(deliveryId, deps);
  return { handled: true, result, reviewTaskId: await roundReviewerAt(deliveryId, live.headSha, deps.exec) };
}

/**
 * §8.1: the reviewer that answers for the live head is the one on this
 * delivery's latest round at that head, never the newest reviewer row of the
 * PR number (that row may be another head's, or another delivery's).
 */
async function roundReviewerAt(deliveryId: string, headSha: string, exec?: Exec): Promise<string | null> {
  const view = await loadView({ deliveryId }, exec).catch(() => null);
  const atHead = (view?.rounds ?? []).filter((r) => r.headSha === headSha && r.reviewerTaskId);
  return atHead.sort((a, b) => b.round - a.round)[0]?.reviewerTaskId ?? null;
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
 * §6.10 tier 3 (S31): the failing check a configured preflight covers, or
 * null. Best-effort: an unreadable check list or workspace is never a miss.
 */
async function preflightMissFor(
  reader: GithubFactReader,
  p: { workspaceId: string; repoFullName: string; headSha: string },
  deps: SeamDeps,
): Promise<string | null> {
  if (!reader.failingChecks) return null;
  try {
    const failing = await reader.failingChecks(p.repoFullName, p.headSha);
    if (!failing?.length) return null;
    const repo = await (deps.repoFor ?? workspaceRepo)(p.workspaceId);
    const preflight = (repo?.gitConfig as { preflight?: { ciChecks?: unknown } | null } | null)?.preflight;
    return preflightMissOf(failing, preflight?.ciChecks);
  } catch {
    return null;
  }
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
  // The incident a red head joins is its base's: the base GitHub holds now, recorded first.
  await catchUpBase({ workspaceId: p.workspaceId, repoFullName: p.repoFullName, prNumber: p.prNumber, source: `${p.source}:ci`, deliveryId, live }, reader, deps.exec);

  // §6.3 T10: the hint is a pointer; whether CI is red on the head is read now.
  // Nothing failing (re-run green, or re-running) and the reducer refuses it.
  const liveChecks = live.headSha === p.headSha && reader.checkRuns
    ? await reader.checkRuns(p.repoFullName, p.headSha).catch(() => null)
    : null;
  const notRed = !!liveChecks && liveChecks.failing.length === 0;

  // §6.10: classify the failure by its signature, and route a trunk-caused one
  // to its incident (T25) instead of a per-PR attempt. Only for a head the
  // delivery is acting on, in a state a CI failure moves.
  const view = await loadView({ deliveryId }, deps.exec);
  const d = view.delivery;
  let signature = p.signature;
  let incident: TrunkClassification['incident'] = null;
  const ciState = !!d && (TRUNK_SOURCE_STATES.has(d.state) || (d.state === 'REPAIRING' && d.stateReason === 'ci'));
  if (d && ciState && !notRed && d.currentHeadSha === p.headSha && live.headSha === p.headSha) {
    const repo = await (deps.repoFor ?? workspaceRepo)(p.workspaceId);
    const cls = await classifyCiFailure({
      workspaceId: p.workspaceId, repoFullName: p.repoFullName, baseRef: live.baseRef ?? d.baseRef, headSha: p.headSha,
      deliveryId, gitConfig: repo?.gitConfig ?? null, reader, exec: deps.exec,
    });
    if (cls.signature !== UNKNOWN_CI_SIGNATURE) signature = cls.signature;
    incident = cls.incident;
  }
  const preflightMiss = await preflightMissFor(reader, p, deps);
  const result = await applyCommand(
    { type: 'CiFailedObserved', actor: p.source, headSha: p.headSha, signature, maxAttempts: p.maxAttempts, openTrunkIncidentId: incident?.id ?? null, ...(preflightMiss ? { preflightMiss } : {}), ...(liveChecks ? { liveChecks } : {}) },
    { ref: { deliveryId }, exec: deps.exec },
  );
  if (preflightMiss) console.log(`[workflow] preflight_miss on ${p.repoFullName}#${p.prNumber} @ ${p.headSha}: ${preflightMiss}`);
  // 38442d17: the hint was red but the head reads green now (a re-run passed): a CI repair bound to it ends.
  // Not failing is not passing (a cancelled or stale run): only GitHub's every-suite-passed allow-list ends it.
  if (notRed && liveChecks?.complete && d?.state === 'REPAIRING' && d.stateReason === 'ci' && d.currentHeadSha === p.headSha
    && reader.ciGreen && (await reader.ciGreen(p.repoFullName, p.headSha).catch(() => null)) === true) {
    await applyCommand({ type: 'CiGreenObserved', actor: `${p.source}:ci_green`, headSha: p.headSha, liveChecks, allPassing: true }, { ref: { deliveryId }, exec: deps.exec });
  } else if (result.result !== 'applied' && liveChecks && live.headSha === p.headSha) {
    // 6900a317: T10 did not act (a fix still in flight, a state CI does not move, a re-run
    // already green): the head's reading is still recorded, so it never reads "Checking".
    await recordCiReading({ deliveryId, headSha: p.headSha, liveChecks, source: p.source, reader, repoFullName: p.repoFullName }, deps);
  }
  await drainDelivery(deliveryId, deps);
  if (incident?.opened && d) await joinRepairingDeliveries({ incident, workspaceId: p.workspaceId, repoFullName: p.repoFullName, baseRef: live.baseRef ?? d.baseRef ?? '', excludeDeliveryId: deliveryId }, deps);
  return { handled: true, result, attemptTaskId: await attemptTaskOf(deliveryId, result, deps.exec) };
}

/**
 * 6900a317: record the head's CI reading (CiObserved) from a live read. Red when a current
 * run fails (superseded re-runs are already dropped by the reader), so a failure outranks
 * runs still going; green only when every run completed, none fails and every suite passed;
 * running (nothing failing, not finished) withdraws a red on this head that a re-run replaced.
 * An unreadable suite read records nothing.
 */
async function recordCiReading(p: {
  deliveryId: string; headSha: string; liveChecks: { complete: boolean; failing: string[] }; source: string;
  reader: GithubFactReader; repoFullName: string;
}, deps: SeamDeps): Promise<CommandResult | null> {
  const ref = { ref: { deliveryId: p.deliveryId }, exec: deps.exec };
  if (p.liveChecks.failing.length > 0) {
    return applyCommand({ type: 'CiObserved', actor: `${p.source}:ci_reading`, headSha: p.headSha, verdict: 'red', liveChecks: p.liveChecks }, ref);
  }
  if (!p.liveChecks.complete) {
    return applyCommand({ type: 'CiObserved', actor: `${p.source}:ci_reading`, headSha: p.headSha, verdict: 'running', liveChecks: p.liveChecks }, ref);
  }
  if (!p.reader.ciGreen) return null;
  const allPassing = (await p.reader.ciGreen(p.repoFullName, p.headSha).catch(() => null)) === true;
  if (!allPassing) return null;
  return applyCommand({ type: 'CiObserved', actor: `${p.source}:ci_reading`, headSha: p.headSha, verdict: 'green', liveChecks: p.liveChecks, allPassing }, ref);
}

const TRUNK_SOURCE_STATES: ReadonlySet<string> = new Set(['AWAITING_REVIEW', 'APPROVED', 'LANDING']);

/**
 * 38442d17: CI went green on a kernel-owned PR's head (the `check_suite`
 * success webhook, or a red-PR sweep that read it green). Read live (R2): only
 * a head whose check runs all completed with none failing AND whose every check
 * suite passed (GitHub's passing allow-list) ends a CI repair bound to it.
 * `handled: false` = not the kernel's PR.
 */
export async function observeCiGreen(p: {
  workspaceId: string; repoFullName: string; prNumber: number; installationId: number; headSha: string; source: string;
}, deps: SeamDeps = {}): Promise<{ handled: false } | { handled: true; result: CommandResult | null }> {
  const deliveryId = await kernelDeliveryForPr(p.workspaceId, p.repoFullName, p.prNumber, deps.exec);
  if (!deliveryId) return { handled: false };
  const d = (await loadView({ deliveryId }, deps.exec)).delivery;
  // A green for another head (a late or out-of-order webhook) says nothing about this one.
  if (!d || d.currentHeadSha !== p.headSha) return { handled: true, result: null };
  const reader = readerFor(deps, p.installationId);
  const liveChecks = reader.checkRuns ? await reader.checkRuns(p.repoFullName, p.headSha).catch(() => null) : null;
  if (!liveChecks) return { handled: true, result: null };
  // 6900a317: outside a CI repair the green is a reading on the head, recorded without moving the delivery.
  if (d.state !== 'REPAIRING' || d.stateReason !== 'ci') {
    const result = await recordCiReading({ deliveryId, headSha: p.headSha, liveChecks, source: p.source, reader, repoFullName: p.repoFullName }, deps);
    if (result) await drainDelivery(deliveryId, deps);
    return { handled: true, result };
  }
  // The check runs say nothing failed; only GitHub's passing allow-list (every suite completed
  // and passed) says everything passed. A cancelled or stale run is not green.
  const allPassing = reader.ciGreen ? (await reader.ciGreen(p.repoFullName, p.headSha).catch(() => null)) === true : false;
  if (!allPassing) return { handled: true, result: null };
  const result = await applyCommand({ type: 'CiGreenObserved', actor: p.source, headSha: p.headSha, liveChecks, allPassing }, { ref: { deliveryId }, exec: deps.exec });
  await drainDelivery(deliveryId, deps);
  return { handled: true, result };
}

/**
 * A newly opened incident also takes the deliveries already repairing the same
 * failure on this base: their queued per-PR CI attempts are skipped (§6.10).
 */
async function joinRepairingDeliveries(p: {
  incident: NonNullable<TrunkClassification['incident']>; workspaceId: string; repoFullName: string; baseRef: string; excludeDeliveryId: string;
}, deps: SeamDeps): Promise<void> {
  const exec = deps.exec ?? seamExec;
  const rows = ((await exec(repairingCiOnBaseSql({ workspaceId: p.workspaceId, repoFullName: p.repoFullName, baseRef: p.baseRef, excludeDeliveryId: p.excludeDeliveryId }))).rows ?? []) as Array<{ id: string; current_head_sha: string | null; trigger_reason: string | null }>;
  for (const r of rows) {
    if (!r.current_head_sha || !r.trigger_reason || !trunkExplains(r.trigger_reason, p.incident.signature)) continue;
    if (!(await kernelDeliveryById(String(r.id), deps.exec))) continue;
    await exec(openOrJoinIncidentSql({ workspaceId: p.workspaceId, repoFullName: p.repoFullName, baseRef: p.baseRef, signature: p.incident.signature, deliveryId: String(r.id) }));
    await applyCommand(
      { type: 'TrunkRedObserved', actor: 'kernel:trunk_breaker', incidentId: p.incident.id, signature: p.incident.signature, headSha: r.current_head_sha, thresholdMet: true },
      { ref: { deliveryId: String(r.id) }, exec: deps.exec },
    );
    await drainDelivery(String(r.id), deps);
  }
}

// ── T26: the base branch recovered (recovery sweep, §6.10) ──────────────────

export interface TrunkSweepSummary { checked: number; resolved: number; recovered: number; stillRed: number; errors: number }

/**
 * Re-read the base head of every unresolved trunk incident. Once the base no
 * longer fails the incident's checks (and every run on it completed), the
 * incident resolves and each delivery blocked on it re-enters its resume state
 * (T26), with a mechanical refresh when its head predates the fix. A
 * delivery left blocked on an already-resolved incident (an interrupted pass)
 * is recovered too. Runs on the pr-reconcile floor tick.
 */
export async function reconcileTrunkIncidents(deps: SeamDeps = {}, limit = 25): Promise<TrunkSweepSummary> {
  const exec = deps.exec ?? seamExec;
  const s: TrunkSweepSummary = { checked: 0, resolved: 0, recovered: 0, stillRed: 0, errors: 0 };
  const incidents = ((await exec(unresolvedIncidentsSql(limit))).rows ?? []) as Array<{ id: string; workspace_id: string; repo_full_name: string; base_ref: string; signature: string }>;
  for (const inc of incidents) {
    s.checked++;
    try {
      const repo = await (deps.repoFor ?? workspaceRepo)(String(inc.workspace_id));
      if (!repo) continue;
      const reader = readerFor(deps, repo.installationId);
      const head = reader.branchHead ? await reader.branchHead(inc.repo_full_name, inc.base_ref) : null;
      const runs = head && reader.checkRuns ? await reader.checkRuns(inc.repo_full_name, head) : null;
      // Unknown or still running is never read as recovered.
      if (!runs || !runs.complete || !trunkRecovered(inc.signature, runs.failing)) { s.stillRed++; continue; }
      const won = ((await exec(resolveIncidentSql(String(inc.id)))).rows ?? []).length > 0;
      if (won) s.resolved++;
    } catch (err) {
      s.errors++;
      console.error(`[workflow] trunk incident ${inc.id} recheck failed:`, err);
    }
  }
  const blocked = ((await exec(blockedOnResolvedSql(limit * 8))).rows ?? []) as Array<{ id: string; workspace_id: string; repo_full_name: string | null; current_head_sha: string | null; trunk_incident_id: string; base_ref: string }>;
  for (const b of blocked) {
    try {
      // The kill switch: resolving releases a switched-off delivery, and a released one is legacy's.
      if (!(await kernelDeliveryById(String(b.id), deps.exec))) continue;
      const repo = await (deps.repoFor ?? workspaceRepo)(String(b.workspace_id));
      let predates = false;
      if (repo && b.repo_full_name && b.current_head_sha) {
        const reader = readerFor(deps, repo.installationId);
        const baseHead = reader.branchHead ? await reader.branchHead(b.repo_full_name, b.base_ref) : null;
        predates = !!baseHead && !!reader.contains && !(await reader.contains(b.repo_full_name, baseHead, b.current_head_sha));
      }
      const r = await applyCommand(
        { type: 'TrunkRecovered', actor: 'sweep:trunk', incidentId: String(b.trunk_incident_id), baseStillRed: false, headPredatesFix: predates },
        { ref: { deliveryId: String(b.id) }, exec: deps.exec },
      );
      if (r.result === 'applied') s.recovered++;
      await drainDelivery(String(b.id), deps);
    } catch (err) {
      s.errors++;
      console.error(`[workflow] trunk recovery of delivery ${b.id} failed:`, err);
    }
  }
  return s;
}

export interface FloorSummary {
  /** Kernel-owned deliveries the pass read GitHub for. */
  checked: number;
  /** Facts the live read produced that the reducer applied (a head, a merge, a close, a reopen). */
  imported: number;
  /** Owed effects that were missing and were re-enqueued under their own dedupe key. */
  enqueued: number;
  errors: number;
}

/**
 * §11's reconciliation floor for kernel deliveries: for each open delivery
 * (stalest first, capped) read the PR and import what GitHub says, then
 * re-enqueue any effect its state owes and lacks. Only the two permitted
 * operations: a fact through `ingestFact` (source `sweep:kernel-floor`) and an
 * effect insert under the effect's own dedupe key. A missed `synchronize`
 * (or a push to a draft PR, which the webhook path skips) or a missed
 * `closed` is repaired on the next pass instead of stranding the delivery.
 */
export async function reconcileKernelDeliveries(
  deps: SeamDeps = {},
  o: { limit?: number; minQuietMs?: number; only?: string[] } = {},
): Promise<FloorSummary> {
  const exec = deps.exec ?? seamExec;
  const s: FloorSummary = { checked: 0, imported: 0, enqueued: 0, errors: 0 };
  const rows = ((await exec(floorCandidatesSql({ limit: o.limit ?? 100, minQuietMs: o.minQuietMs ?? 10 * 60_000, only: o.only ?? null }))).rows ?? []) as FloorCandidate[];
  const source = 'sweep:kernel-floor';
  for (const row of rows) {
    const workspaceId = String(row.workspace_id);
    const repoFullName = String(row.repo_full_name);
    const prNumber = Number(row.pr_number);
    try {
      // The kill switch: a delivery released to legacy is legacy's to reconcile.
      const deliveryId = await kernelDeliveryForPr(workspaceId, repoFullName, prNumber, deps.exec);
      if (!deliveryId) continue;
      const repo = await (deps.repoFor ?? workspaceRepo)(workspaceId);
      if (!repo) continue;
      s.checked++;
      const reader = readerFor(deps, repo.installationId);
      const live = await reader.readPr(repoFullName, prNumber);
      if (!live) { s.errors++; continue; }
      // One read per delivery: the fact funnel acts on this same live read (R2).
      const once: GithubFactReader = { ...reader, readPr: async () => live };
      const base = { workspaceId, source, repoFullName, prNumber };
      const closedNow = live.merged || live.state !== 'open';
      const fact = closedNow
        ? (row.state === 'CLOSED_UNMERGED' && !live.merged ? null : { kind: 'pr_closed' as const, ...base })
        : row.state === 'CLOSED_UNMERGED'
          ? { kind: 'pr_closed' as const, ...base } // reopened: the live read makes it T19
          : live.headSha !== row.current_head_sha ? { kind: 'head_observed' as const, ...base, hintedHeadSha: null } : null;
      if (fact) {
        const r = await ingestFact(fact, { exec: deps.exec, github: once });
        if (r.result === 'applied') s.imported++;
      }
      if (!closedNow && row.state !== 'CLOSED_UNMERGED' && await catchUpBase({ ...base, deliveryId, live }, once, deps.exec)) s.imported++;
      let enqueued = 0;
      let view = await loadView({ deliveryId }, deps.exec);
      // bb6a3a56: WORKING with the owner already ended means the kernel never got that end
      // (a completion that raced the PR open, a crash before tasks.delivery_id, a command that
      // lost the version race twice). Re-send it from the workers row; a held end is a duplicate.
      if (view.delivery?.state === 'WORKING') {
        const ended = await forwardOwnerEnd({ workspaceId, ownerTaskId: view.delivery.ownerTaskId, deliveryId, source }, deps);
        if (ended) {
          view = await loadView({ deliveryId }, deps.exec);
          if (view.delivery?.state !== 'WORKING') s.imported++;
        }
      } else if (view.delivery) {
        // AC-1 slice 3: past WORKING the kernel has the end, but the task may not: an older control
        // plane applied it without projecting and the route's own projection failed. Settle it.
        await settleOwnerTask({ ownerTaskId: view.delivery.ownerTaskId, deliveryId }, deps);
      }
      // 75c04d5d: a mechanical refresh pinned to a head the delivery already left. The head read
      // above is a duplicate (the delivery holds it), so nothing else ever ends the row.
      const stranded = strandedMechanicalRepair(view);
      if (stranded) {
        const r = await applyCommand({ type: 'RepairNotNeeded', actor: source, attemptId: stranded, reason: 'head_moved', live }, { ref: { deliveryId }, exec: deps.exec });
        if (r.result === 'applied') {
          s.imported++;
          view = await loadView({ deliveryId }, deps.exec);
        }
      }
      if (view.delivery) {
        const n = await reenqueueOwedEffects(deliveryId, view, exec, `floor ${repoFullName}#${prNumber}`);
        enqueued += n;
        s.enqueued += n;
      }
      if (fact || enqueued) await drainDelivery(deliveryId, deps);
    } catch (err) {
      s.errors++;
      console.error(`[workflow] floor reconcile of ${repoFullName}#${prNumber} failed:`, err);
    } finally {
      // S4a: this delivery had its turn (read, skipped or failed); the next pass starts with ones
      // checked longer ago, so a row that keeps failing never starves the rest of the queue.
      await exec(floorCheckedSql([String(row.id)])).catch((err) => console.warn(`[workflow] floor_checked_at for ${row.id} failed:`, err));
    }
  }
  return s;
}

/**
 * §11 operation 2 for one delivery: insert each effect its state owes and its
 * outbox does not hold (`enqueueMissingEffects`, keyed by the reducer's own
 * dedupe keys, so nothing is ever owed twice). Answers how many it inserted.
 */
async function reenqueueOwedEffects(deliveryId: string, view: KernelView, exec: Exec, label: string): Promise<number> {
  if (!view.delivery) return 0;
  const held = ((await exec(existingEffectsSql(deliveryId))).rows ?? []) as Array<{ dedupe_key: string; status?: string }>;
  const existing = new Set(held.map((e) => String(e.dedupe_key)));
  const status = new Map(held.map((e) => [String(e.dedupe_key), String(e.status ?? '')]));
  let n = 0;
  for (const e of enqueueMissingEffects(view, existing, status)) {
    const ins = ((await exec(enqueueEffectSql(deliveryId, view.delivery.version, e))).rows ?? []).length;
    if (ins > 0) {
      n++;
      console.log(`[workflow] ${label} re-enqueued ${e.kind} (${e.dedupeKey})`);
    }
  }
  return n;
}

export interface TreadmillCycleSummary {
  /** Treadmill escalations past the cooldown that the pass looked at. */
  checked: number;
  /** Returned to APPROVED with a fresh refresh budget; the landing sweep picks them up. */
  restarted: number;
  /** Refused by the reducer (cycles used up, head not approved, moved since the read): stays with a person. */
  refused: number;
  errors: number;
}

/**
 * S15 cycles, the kernel's half of the landing cooldown: a delivery the
 * behind-refresh treadmill escalated gets a fresh refresh budget once
 * `cooldownMs` has passed since that escalation, up to `MAX_TREADMILL_CYCLES`
 * cycles (the reducer's bound). Only the treadmill cause qualifies (the SQL
 * pins the transition that produced the current version); a merge refusal or a
 * failed refresh stays with a person. The restart is pinned to that version, so
 * a person's move in between wins.
 */
export async function restartTreadmillCycles(
  o: { cooldownMs: number; limit?: number },
  deps: SeamDeps & {
    apply?: typeof applyCommand;
    owned?: (workspaceId: string, repoFullName: string, prNumber: number) => Promise<string | null>;
    drain?: (deliveryId: string) => Promise<unknown>;
  } = {},
): Promise<TreadmillCycleSummary> {
  const exec = deps.exec ?? seamExec;
  const apply = deps.apply ?? applyCommand;
  const owned = deps.owned ?? ((w, r, n) => kernelDeliveryForPr(w, r, n, deps.exec));
  const drain = deps.drain ?? ((id: string) => drainDelivery(id, deps));
  const s: TreadmillCycleSummary = { checked: 0, restarted: 0, refused: 0, errors: 0 };
  const rows = ((await exec(treadmillCycleCandidatesSql({ limit: o.limit ?? 20, cooldownMs: o.cooldownMs }))).rows ?? []) as TreadmillCycleCandidate[];
  for (const row of rows) {
    const deliveryId = String(row.id);
    try {
      // The kill switch: a delivery released to legacy is legacy's.
      if ((await owned(String(row.workspace_id), String(row.repo_full_name), Number(row.pr_number))) !== deliveryId) continue;
      s.checked++;
      const result = await apply(
        { type: 'TreadmillCycleRestarted', actor: 'sweep:treadmill-cycle', expectedVersion: Number(row.version) },
        { ref: { deliveryId }, exec: deps.exec },
      );
      if (result.result === 'applied') {
        s.restarted++;
        console.log(`[workflow] treadmill cycle restarted for ${row.repo_full_name}#${row.pr_number}`);
        await drain(deliveryId);
      } else {
        s.refused++;
        console.log(`[workflow] treadmill cycle not restarted for ${row.repo_full_name}#${row.pr_number}: ${result.result} (${'reason' in result ? result.reason : 'no reason'})`);
      }
    } catch (err) {
      s.errors++;
      console.error(`[workflow] treadmill cycle restart of ${row.repo_full_name}#${row.pr_number} failed:`, err);
    }
  }
  return s;
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

/**
 * T12's reading of a live PR. GitHub reports `mergeable_state: behind` only
 * under branch protection that requires an up-to-date branch; without it a PR
 * many commits behind its base reads `clean`. So a door that saw the PR behind
 * (landing's freshness rail, a merge refused as out of date) is answered by
 * ancestry, not by that state: the base tip missing from the head is `behind`.
 * `baseContained` null = not read; false = the base tip is not in the head.
 */
export function conflictReading(
  state: string | null | undefined,
  hint: 'dirty' | 'behind',
  baseContained: boolean | null,
): ConflictSeen['mergeable'] {
  if (state === 'dirty') return 'dirty';
  if (state === 'behind') return 'behind';
  if (!isMergeableNow(state)) return 'unknown';
  return hint === 'behind' && baseContained === false ? 'behind' : 'clean';
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
  /** S15: the ordinary commit bound for a platform-refreshed head (`treadmillMaxBaseCommits`). */
  maxBaseCommits?: number;
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
  // Only a behind-hinted door on a mergeable PR pays for the ancestry read.
  const baseTip = p.hint === 'behind' && isMergeableNow(state) && live.baseRef && reader.branchHead && reader.contains
    ? await reader.branchHead(p.repoFullName, live.baseRef)
    : null;
  const baseContained = baseTip ? await reader.contains!(p.repoFullName, baseTip, live.headSha) : null;
  const mergeable = conflictReading(state, p.hint, baseContained);
  if (mergeable === 'clean' && !p.migrationCollision) return none('not_conflicting', 'clean');
  // S15: a behind PR carries the base delta as a fact, so T12 can apply the disjoint-delta rule
  // (land instead of refreshing again, or say precisely why not). Read only for behind.
  const behindRead = mergeable === 'behind' || (mergeable === 'unknown' && p.hint === 'behind');
  const read = behindRead && !p.migrationCollision && live.baseRef && reader.baseDelta
    ? (await reader.baseDelta(p.repoFullName, p.prNumber, live.headSha, live.baseRef)) ?? { baseCommits: null, baseFiles: null, prFiles: null }
    : null;
  const baseDelta = read ? { ...read, requiresUpToDate: state === 'behind' } : null;
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
    ...(baseDelta ? { baseDelta, ...(p.maxBaseCommits !== undefined ? { maxBaseCommits: p.maxBaseCommits } : {}) } : {}),
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

// ── T15/T16: the merge doors (Slice C) ──────────────────────────────────────

export type { KernelLanding, LandingInput, LandingOutcome } from './landing';
export { staleLandingVersion, kernelLandingView, listApprovedKernelPrs, notKernelOwnedPr } from './landing';

/**
 * The merge of a kernel-owned PR, for every merge door (§14 Slice C): the door
 * keeps its rails and calls this where it used to call GitHub. Null = not the
 * kernel's PR, and the door merges as before. When it answers, the door does
 * no post-merge work of its own: the kernel's effects did it.
 */
export async function landThroughKernel(p: LandingInput, deps: SeamDeps = {}): Promise<KernelLanding | null> {
  return landThroughKernelImpl(p, {
    exec: deps.exec,
    reader: deps.reader,
    drain: (deliveryId) => drainDelivery(deliveryId, deps),
  });
}

// ── §6: mission deliveries and epochs ───────────────────────────────────────

/**
 * The mission epoch door (docs/specs/workflow-kernel-library.md §6), one
 * operation per action. Reached through kernel-client's `mission_epoch` op,
 * so it runs on the host that owns the kernel. `workspaceId` is the
 * mission's repo workspace: the one the principal is re-checked against.
 */
export type MissionEpochInput =
  | { action: 'merged'; workspaceId: string; missionId: string; prNumber: number; repoFullName: string; headRef: string | null; mergeCommitSha: string | null; mergedHeadSha: string | null; mergedAt: string; actor: string }
  | { action: 'ensure_writable'; workspaceId: string; missionId: string; reason: string; actor: string }
  | { action: 'bind_pr'; workspaceId: string; missionId: string; prNumber: number; repoFullName: string; ownerTaskId: string | null; headRef: string | null; actor: string }
  | { action: 'reconcile'; workspaceId: string; missionId: string }
  | { action: 'pr_moved'; workspaceId: string; missionId: string; branch: string; prNumber: number; actor: string };

export type MissionEpochAnswer =
  | { action: 'merged'; result: string; reason: string; steps: string[] }
  | { action: 'ensure_writable'; branch: string | null; rotated: boolean; ready: boolean; reason: string }
  | { action: 'bind_pr'; result: string; reason: string }
  | { action: 'reconcile'; steps: string[] }
  | { action: 'pr_moved'; result: string; reason: string };

export async function missionEpochCommand(p: MissionEpochInput): Promise<MissionEpochAnswer> {
  const epochs = await import('./delivery-epochs');
  const stepsOf = (r: { steps: Array<{ step: string; epoch: number; outcome: string }> }) => r.steps.map((s) => `${s.step}#${s.epoch}:${s.outcome}`);
  switch (p.action) {
    case 'merged': {
      const r = await epochs.epochMerged({
        missionId: p.missionId, prNumber: p.prNumber, repoFullName: p.repoFullName, headRef: p.headRef,
        mergeCommitSha: p.mergeCommitSha, mergedHeadSha: p.mergedHeadSha, mergedAt: p.mergedAt, actor: p.actor,
      });
      return { action: 'merged', result: r.result, reason: r.reason, steps: stepsOf(r.reconcile) };
    }
    case 'ensure_writable':
      return { action: 'ensure_writable', ...(await epochs.ensureWritableEpoch({ missionId: p.missionId, reason: p.reason, actor: p.actor })) };
    case 'bind_pr':
      return { action: 'bind_pr', ...(await epochs.bindEpochPr(p)) };
    case 'reconcile':
      return { action: 'reconcile', steps: stepsOf(await epochs.reconcileMissionEpochs(p.missionId)) };
    case 'pr_moved': {
      const r = await epochs.applyMissionEpochCommand(p.missionId, { type: 'PrMovedOff', actor: p.actor, at: new Date().toISOString(), branch: p.branch, prNumber: p.prNumber });
      return { action: 'pr_moved', result: r.result, reason: r.reason };
    }
  }
}

/**
 * §6 scope amendments: the scope decision for a task added to a mission,
 * recorded once (workflow/scope-amendments.ts). `workspaceId` is the task's.
 */
export async function missionScopeCommand(p: { workspaceId: string; taskId: string; actor: string }) {
  const { decideTaskScope } = await import('./scope-amendments');
  return decideTaskScope({ taskId: p.taskId, actor: p.actor });
}
