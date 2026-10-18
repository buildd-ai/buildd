/**
 * A PR with no delivery is adopted before a buildd door merges it
 * (docs/specs/workflow-kernel-library.md §4, AC-13; #4686).
 *
 * Every worker merge door (D2/D3 `landPr`, D4 `tryAutoMergeWorkerPr`, D5
 * `merge_pr`, D6 the dashboard merge) asks this before it decides whether the
 * kernel owns the PR. A PR the kernel has never seen gets its delivery opened
 * (`open_delivery`, the same op `create_pr` and the PR webhook use) with the
 * door's task as the owner, so the door then lands it through the kernel's
 * gate like any other kernel PR. The adopted delivery starts where a late open
 * starts: the owner's end is forwarded and a review of the live head is owed,
 * so a legacy reviewer's approval never carries it past T15.
 *
 * Three answers:
 *  - `kernel`: the PR has a kernel delivery now (it already had one, or this
 *    call opened it). The door lands through the kernel.
 *  - `legacy`: the kill switch is off for the workspace, or the PR's delivery
 *    was released to legacy (sticky, authority.ts). The door's legacy arm is
 *    the designed path for exactly these.
 *  - `refused`: nothing could adopt it (no owner task, the task is a review or
 *    an attempt, the PR could not be bound, the control plane did not answer).
 *    The door merges nothing and says why.
 *
 * Release doors (D7 to D10) never ask: a release PR's bookkeeping lives
 * outside the kernel and they keep the release gate (§4, owner decision).
 */
import { db } from '@buildd/core/db';
import type { Exec } from './kernel';
import { resolveByPrSql } from './authority';
import type { DoorCall } from './kernel-client';

const dbExec: Exec = (q) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;

export type MergeAdoption =
  | { kind: 'kernel'; deliveryId: string; adopted: boolean }
  | { kind: 'legacy'; reason: 'kernel_off' | 'released' }
  | { kind: 'refused'; reason: string; message: string };

export interface MergeAdoptionInput {
  workspaceId: string;
  installationId: number;
  repoFullName: string;
  prNumber: number;
  /** The task the door's worker ran for this PR; an attempt is walked to its owner. Null: nothing to own the delivery. */
  taskId: string | null;
  /** Which door asked, for the delivery's open source (`<door>:adopt`). */
  door: string;
}

export interface MergeAdoptionDeps {
  exec?: Exec;
  /** The kernel's `open_delivery` op (kernel-client). Injected by tests. */
  open?: (p: { workspaceId: string; ownerTaskId: string; repoFullName: string; prNumber: number; installationId: number; source: string }, c: DoorCall) => Promise<{ owned: boolean; deliveryId?: string; reason?: string }>;
  /** The task the delivery is owed to: an attempt's owner (mission-pr.ts `deliveryOwnerTask`). Injected by tests. */
  ownerOf?: (taskId: string) => Promise<string>;
}

/** What a refusal says to the door's caller, by `open_delivery`'s reason. */
function refusal(reason: string, prNumber: number): Extract<MergeAdoption, { kind: 'refused' }> {
  const why = reason === 'no_owner_task' ? 'no task owns it'
    : reason === 'no_task' ? 'its task is not in this workspace'
    : reason === 'review_task' ? 'its only task is a review'
    : reason === 'attempt_task' ? 'its task is a repair of another delivery'
    : reason === 'owner_bound_to_other_pr' ? 'its task already delivers another PR'
    : reason === 'adoption_unavailable' ? 'the workflow could not be reached to take it on'
    : reason.startsWith('bind_') ? `the PR could not be bound (${reason.slice(5)})`
    : `the workflow could not take it on (${reason})`;
  return {
    kind: 'refused',
    reason: `adoption_failed:${reason}`,
    message: `PR #${prNumber} has no review record in buildd and ${why}, so nothing was merged. Request a review of it first.`,
  };
}

/** The PR's delivery as the one resolver reads it: kernel, legacy (released), or none. */
async function prAuthority(p: MergeAdoptionInput, exec: Exec): Promise<{ deliveryId: string; authority: 'kernel' | 'legacy' } | null> {
  const row = ((await exec(resolveByPrSql(p.workspaceId, p.repoFullName, p.prNumber))).rows ?? [])[0] as { delivery_id: string; authority: string } | undefined;
  return row ? { deliveryId: String(row.delivery_id), authority: row.authority === 'legacy' ? 'legacy' : 'kernel' } : null;
}

async function defaultOwnerOf(taskId: string): Promise<string> {
  const { tasks } = await import('@buildd/core/db/schema');
  const { eq } = await import('drizzle-orm');
  const { sqlWhere } = await import('@buildd/core/db/relational-sql');
  const { deliveryOwnerTask } = await import('@/lib/mission-pr');
  const task = await db.query.tasks.findFirst({ where: sqlWhere(eq(tasks.id, taskId)), columns: { id: true, title: true, taskClass: true, missionId: true, context: true } });
  if (!task) return taskId;
  const owner = await deliveryOwnerTask(task as Parameters<typeof deliveryOwnerTask>[0]).catch(() => task);
  return (owner as { id?: string | null }).id ?? taskId;
}

/**
 * Before a worker merge door decides who owns the PR: adopt a PR the kernel has never seen.
 * Never throws: an unreachable control plane is a refusal (nothing merges), never the legacy arm.
 */
export async function adoptBeforeMerge(p: MergeAdoptionInput, call: DoorCall, deps: MergeAdoptionDeps = {}): Promise<MergeAdoption> {
  const exec = deps.exec ?? dbExec;
  let existing: Awaited<ReturnType<typeof prAuthority>>;
  try {
    existing = await prAuthority(p, exec);
  } catch (err) {
    console.error(`[merge-adoption] ${p.repoFullName}#${p.prNumber}: could not read the PR's delivery; nothing merges:`, err);
    return refusal('adoption_unavailable', p.prNumber);
  }
  if (existing?.authority === 'kernel') return { kind: 'kernel', deliveryId: existing.deliveryId, adopted: false };
  if (existing?.authority === 'legacy') return { kind: 'legacy', reason: 'released' };
  if (!p.taskId) return refusal('no_owner_task', p.prNumber);

  try {
    const ownerTaskId = await (deps.ownerOf ?? defaultOwnerOf)(p.taskId).catch(() => p.taskId!);
    const open = deps.open ?? (await import('./kernel-client')).openKernelDelivery;
    const r = await open({
      workspaceId: p.workspaceId, ownerTaskId, repoFullName: p.repoFullName, prNumber: p.prNumber,
      installationId: p.installationId, source: `${p.door}:adopt`,
    }, call);
    if (r.owned && r.deliveryId) {
      console.log(`[merge-adoption] ${p.repoFullName}#${p.prNumber}: adopted by ${p.door} (delivery ${r.deliveryId}); it lands through the kernel's gate`);
      return { kind: 'kernel', deliveryId: r.deliveryId, adopted: true };
    }
    if (r.reason === 'kernel_off') return { kind: 'legacy', reason: 'kernel_off' };
    // `released`: the owner's own delivery is legacy but bound to no PR, so this PR still has none.
    return refusal(r.reason ?? 'not_owned', p.prNumber);
  } catch (err) {
    console.error(`[merge-adoption] ${p.repoFullName}#${p.prNumber}: open_delivery failed; nothing merges:`, err);
    return refusal('adoption_unavailable', p.prNumber);
  }
}
