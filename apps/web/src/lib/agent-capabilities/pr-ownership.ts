/**
 * Does this task own the PR an agent run is recording on its worker?
 *
 * A worker's prUrl/prNumber is what buildd treats as the task's deliverable:
 * it satisfies pr_required, feeds mission completion, and on the
 * `branch_merge` release strategy it is the PR the release executor merges.
 * So an agent run may record a PR only when its head is one the task owns.
 *
 * Owned, in order (cheapest first; the async lineage walk runs last):
 *   own_branch      head is the worker's own branch
 *   retry_subject   the task is a retry attempt bound to this PR number
 *   task_names_pr   the task's title, description or context names #N
 *   stacked_base    head is the task's context.baseBranch / headBranch
 *                   (stacked phases and a mission's shared working branch)
 *   depends_on      head carries the short id of a task this one depends on
 *   task_lineage    head carries the short id of this task or a retry
 *                   ancestor (an earlier worker's branch on the same work)
 *   interactive_head a verified interactive/local MCP session's own pushed
 *                   branch (workers.runner === INTERACTIVE_RUNNER, see
 *                   interactive-session.ts), when no OTHER worker already
 *                   holds that exact name live or with a PR of its own
 *   cut_from_assigned_base the worker was assigned the mission integration
 *                   branch (context.baseBranch) itself, so it pushed to a task
 *                   branch cut from it; owned when that head carries no other
 *                   task's short id and no other worker holds it (same holder
 *                   rule as interactive_head)
 *
 * A protected head (trunk, release branches, the repo's default branch) is
 * owned only as the worker's own branch: naming a release PR in a task does
 * not make it this task's deliverable.
 *
 * These shapes were measured, not guessed: over recent history they account
 * for every agent-recorded PR whose head differs from the worker's branch,
 * except the ones this rule exists to refuse. `interactive_head` is the one
 * deliberate addition rather than a measured shape: claim_task always hands
 * an interactive session the generated buildd/<id8>-<slug> name, but the
 * person may have pushed somewhere else entirely, and refusing that (when
 * nobody else is using the name) only ever produced a gh-pr-create workaround
 * — see knowledge-base reports on the create_pr branch-mismatch friction
 * cluster this closes.
 *
 * Applies to agent runs only (see `ownershipApplies`). People, organizers on
 * other accounts, and server-side adoption keep their current behaviour.
 */
import type { WorkerPrActor } from './worker-pr';
import { isLiveWorkerStatus } from './principal';

export type PrOwnershipBasis =
  | 'own_branch'
  | 'retry_subject'
  | 'task_names_pr'
  | 'stacked_base'
  | 'depends_on'
  | 'task_lineage'
  | 'interactive_head'
  | 'cut_from_assigned_base';

export type PrOwnershipVerdict =
  | { owned: true; basis: PrOwnershipBasis }
  | { owned: false; reasonCode: 'protected_head' | 'head_not_owned' | 'head_claimed'; error: string };

/**
 * Another worker (any task, same workspace) already recorded with
 * `workers.branch` equal to the head an interactive session wants to claim.
 * DB-fetched by the caller with one branch-equality query — kept out of this
 * module so the ownership rule itself stays pure and DB-free.
 */
export interface InteractiveHeadHolder {
  workerId: string;
  taskId: string | null;
  /** `workers.status` */
  status: string;
  /** Whether that worker already has its own PR recorded (`workers.prUrl`). */
  hasPr: boolean;
}

export interface PrOwnershipTask {
  id: string;
  title?: string | null;
  description?: string | null;
  context?: unknown;
  dependsOn?: unknown;
  reviewerRetryPrNumber?: number | null;
  ciRetryPrNumber?: number | null;
  conflictRetryPrNumber?: number | null;
}

export interface PrOwnershipInput {
  head: string;
  prNumber: number | null;
  workerBranch: string | null;
  task: PrOwnershipTask | null;
  protectedBranches: readonly string[];
  /**
   * True for a cryptographically verified interactive/local MCP session
   * (`workers.runner === INTERACTIVE_RUNNER`, see interactive-session.ts) —
   * never for an unverified claim or a background runner. Lets `create_pr`
   * accept a head this worker actually pushed, even when it differs from
   * the branch `claim_task` generated, as long as nobody else already holds
   * that exact name (see `otherHeadHolders`).
   */
  interactiveWorker?: boolean;
  /**
   * Other workers already recorded on `head` — only consulted for
   * `interactive_head` and `cut_from_assigned_base`, when no cheaper basis
   * matched (see `needsHeadHolders`). Fetch with one
   * branch-equality query in the same workspace; omit otherwise.
   */
  otherHeadHolders?: readonly InteractiveHeadHolder[];
}

/**
 * Whether the caller must fetch `otherHeadHolders` for this worker: an
 * interactive session, or a worker assigned its task's mission base itself.
 */
export function needsHeadHolders(interactiveWorker: boolean, workerBranch: string | null, task: PrOwnershipTask | null): boolean {
  if (interactiveWorker) return true;
  const ctx = task?.context && typeof task.context === 'object' ? task.context as Record<string, unknown> : {};
  return !!workerBranch && ctx.baseBranch === workerBranch;
}

/** Ids of this task and its retry ancestors, nearest first. Injected so the pure part stays pure. */
export type LoadTaskLineage = (taskId: string) => Promise<string[]>;

/** True when `branch` carries the task id's 8-char short form as a whole token (every naming strategy embeds it). */
export function branchCarriesTaskId(branch: string, taskId: string): boolean {
  const id8 = taskId.slice(0, 8).toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(id8)) return false;
  return new RegExp(`(?:^|[/_-])${id8}(?:[/_-]|$)`).test(branch.toLowerCase());
}

/**
 * The task names this PR: in its title, description or context, or as the
 * PR its retry attempt is bound to. "Fix review on #42", "land PR #42".
 */
export function taskNamesPr(task: PrOwnershipTask | null | undefined, prNumber: number): boolean {
  if (!task) return false;
  const subject = task.reviewerRetryPrNumber ?? task.ciRetryPrNumber ?? task.conflictRetryPrNumber ?? null;
  return subject === prNumber || namesPr(task, prNumber);
}

function namesPr(task: PrOwnershipTask, prNumber: number): boolean {
  const text = `${task.title ?? ''}\n${task.description ?? ''}`;
  if (new RegExp(`(?:#|/pull/)${prNumber}(?!\\d)`).test(text)) return true;
  const ctx = task.context;
  return !!ctx && typeof ctx === 'object' && Object.values(ctx as Record<string, unknown>).some(v => v === prNumber);
}

/** The other worker, if any, that makes `head` unavailable for an interactive session to claim as its own. */
function claimingHolder(
  holders: readonly InteractiveHeadHolder[],
  selfTaskId: string,
): InteractiveHeadHolder | null {
  return holders.find(h => isLiveWorkerStatus(h.status) || (h.hasPr && h.taskId !== selfTaskId)) ?? null;
}

/** True when `branch` carries any 8-hex token, the short-id shape every naming strategy embeds. */
function carriesAnyTaskId(branch: string): boolean {
  return /(?:^|[/_-])[0-9a-f]{8}(?:[/_-]|$)/.test(branch.toLowerCase());
}

function headClaimed(head: string, holder: InteractiveHeadHolder): PrOwnershipVerdict {
  return {
    owned: false,
    reasonCode: 'head_claimed',
    error: `Refusing to record a PR whose head '${head}' is already in use by another worker${holder.taskId ? ` (task ${holder.taskId.slice(0, 8)})` : ''}. Push to a branch name nobody else is using, or use the branch claim_task assigned this worker.`,
  };
}

function refuse(reasonCode: 'protected_head' | 'head_not_owned', head: string): PrOwnershipVerdict {
  return {
    owned: false,
    reasonCode,
    error: reasonCode === 'protected_head'
      ? `Refusing to record a PR whose head is the protected branch '${head}' on this task's worker. Open the PR from the task's own branch.`
      : `Refusing to record a PR whose head '${head}' is not this task's branch, a retry or dependency of it, or a PR the task names. Open the PR from the task's own branch.`,
  };
}

export async function verifyPrOwnership(input: PrOwnershipInput, loadLineage: LoadTaskLineage): Promise<PrOwnershipVerdict> {
  const { head, prNumber, workerBranch, task } = input;
  if (workerBranch && head === workerBranch) return { owned: true, basis: 'own_branch' };
  if (input.protectedBranches.includes(head)) return refuse('protected_head', head);
  if (!task) return refuse('head_not_owned', head);

  if (prNumber != null) {
    const subject = task.reviewerRetryPrNumber ?? task.ciRetryPrNumber ?? task.conflictRetryPrNumber ?? null;
    if (subject === prNumber) return { owned: true, basis: 'retry_subject' };
    if (namesPr(task, prNumber)) return { owned: true, basis: 'task_names_pr' };
  }

  const ctx = (task.context && typeof task.context === 'object') ? task.context as Record<string, unknown> : {};
  if (ctx.baseBranch === head || ctx.headBranch === head) return { owned: true, basis: 'stacked_base' };

  const deps = Array.isArray(task.dependsOn) ? task.dependsOn.filter((d): d is string => typeof d === 'string') : [];
  if (deps.some(d => branchCarriesTaskId(head, d))) return { owned: true, basis: 'depends_on' };

  const lineage = await loadLineage(task.id);
  if ([task.id, ...lineage].some(id => branchCarriesTaskId(head, id))) return { owned: true, basis: 'task_lineage' };

  // The worker was assigned the mission integration branch itself as its own
  // branch (workers.branch === context.baseBranch), so its real work lives on a
  // task branch cut from it. That head is owned only when it is not visibly
  // someone else's: it carries no other task's short id (this task's own ids
  // matched above) and no other worker holds it live or with a PR of its own.
  if (workerBranch && ctx.baseBranch === workerBranch) {
    const holder = claimingHolder(input.otherHeadHolders ?? [], task.id);
    if (!holder && !carriesAnyTaskId(head)) return { owned: true, basis: 'cut_from_assigned_base' };
    if (holder) return headClaimed(head, holder);
    return refuse('head_not_owned', head);
  }

  if (input.interactiveWorker) {
    const holder = claimingHolder(input.otherHeadHolders ?? [], task.id);
    if (!holder) return { owned: true, basis: 'interactive_head' };
    return headClaimed(head, holder);
  }

  return refuse('head_not_owned', head);
}

/**
 * Ownership binds agent runs acting for themselves. A person's OAuth session
 * resolves to the team's shared account, which can be the account that claimed
 * the worker, so a session user is exempt even when classified `agent_run`.
 */
export function ownershipApplies(actor: WorkerPrActor, caller: object): boolean {
  // Only OAuth sessions carry it, so it is absent from the API-key account type.
  return actor.kind === 'agent_run' && !(caller as { sessionUserId?: string | null }).sessionUserId;
}
