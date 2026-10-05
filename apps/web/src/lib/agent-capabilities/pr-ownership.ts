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
 *
 * A protected head (trunk, release branches, the repo's default branch) is
 * owned only as the worker's own branch: naming a release PR in a task does
 * not make it this task's deliverable.
 *
 * These shapes were measured, not guessed: over recent history they account
 * for every agent-recorded PR whose head differs from the worker's branch,
 * except the ones this rule exists to refuse.
 *
 * Applies to agent runs only (see `ownershipApplies`). People, organizers on
 * other accounts, and server-side adoption keep their current behaviour.
 */
import type { WorkerPrActor } from './worker-pr';

export type PrOwnershipBasis =
  | 'own_branch'
  | 'retry_subject'
  | 'task_names_pr'
  | 'stacked_base'
  | 'depends_on'
  | 'task_lineage';

export type PrOwnershipVerdict =
  | { owned: true; basis: PrOwnershipBasis }
  | { owned: false; reasonCode: 'protected_head' | 'head_not_owned'; error: string };

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
