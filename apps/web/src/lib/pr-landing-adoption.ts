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
 * starts: the owner's end is forwarded and a review of the live head is owed.
 * A legacy reviewer's verdict counts only as the open adopts it (968aebfd: a
 * settled verdict read at exactly the live head and base), never on its own row.
 *
 * Three answers:
 *  - `kernel`: the PR has a kernel delivery now (it already had one, or this
 *    call opened it). The door lands through the kernel.
 *  - `legacy`: the kill switch is off for the workspace, or the PR's delivery
 *    was released to legacy (sticky, authority.ts). The door's legacy arm is
 *    the designed path for exactly these.
 *  - `gate`: a release PR (legacy release branch or trusted candidate,
 *    `classifyReleasePr`) or a dependency bot's PR. No delivery is opened; the
 *    door merges it through the release gate (`mergeOutsideKernel`), so the
 *    candidate status stays the release gate's and no kernel repair pushes to
 *    the branch.
 *  - `refused`: nothing could adopt it: a fork (whose branch cannot be
 *    bound), no owner task, a task that is a review or an attempt, a PR that
 *    could not be bound or read, or a control plane that did not answer. The
 *    door merges nothing and says why.
 *
 * Release doors (D7 to D10) never ask: a release PR's bookkeeping lives
 * outside the kernel and they keep the release gate (§4, owner decision).
 */
import { db } from '@buildd/core/db';
import type { SQL } from 'drizzle-orm';
import { kernelEnabled, resolveByPrSql } from '@/lib/workflow/authority';
import type { DoorCall } from '@/lib/workflow/kernel-client';
import { classifyReleasePr } from '@buildd/core/release-candidate';
import { isDependencyBotAuthor } from '@/lib/dependency-bot-pr';

type Exec = (q: SQL) => Promise<{ rows?: unknown[] }>;

const dbExec: Exec = (q) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;

export type MergeAdoption =
  | { kind: 'kernel'; deliveryId: string; adopted: boolean }
  | { kind: 'legacy'; reason: 'kernel_off' | 'released' }
  /**
   * A PR the kernel must not take: a release PR (the legacy release branch or a trusted frozen
   * candidate, `classifyReleasePr`) or a dependency bot's PR. No delivery is opened (its status
   * stays the release gate's, and no kernel repair ever pushes to its branch); the door merges it
   * through the release gate (`mergeOutsideKernel`: review gate at the head, GitHub's `sha` pin),
   * never on its legacy arm.
   */
  | { kind: 'gate'; why: 'release' | 'dependency_bot' }
  | { kind: 'refused'; reason: string; message: string };

/** What the door needs to know of the live PR to classify it. Null: unreadable. */
export interface AdoptionPrFacts {
  headRef: string | null;
  baseRef: string | null;
  headSha: string | null;
  author: string | null;
  headRepoFullName: string | null;
  baseRepoFullName: string | null;
  body: string | null;
}

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
  /** The workspace's kill switch and release config. Injected by tests. */
  workspace?: (workspaceId: string) => Promise<{ gitConfig: unknown; releaseConfig: unknown } | null>;
  /** The live PR (GitHub). Injected by tests. */
  readPr?: (installationId: number, repoFullName: string, prNumber: number) => Promise<AdoptionPrFacts | null>;
}

async function defaultWorkspace(workspaceId: string): Promise<{ gitConfig: unknown; releaseConfig: unknown } | null> {
  const { workspaces } = await import('@buildd/core/db/schema');
  const { eq } = await import('drizzle-orm');
  const { sqlWhere } = await import('@buildd/core/db/relational-sql');
  const ws = await db.query.workspaces.findFirst({ where: sqlWhere(eq(workspaces.id, workspaceId)), columns: { gitConfig: true, releaseConfig: true } });
  return ws ? { gitConfig: ws.gitConfig, releaseConfig: ws.releaseConfig } : null;
}

async function defaultReadPr(installationId: number, repoFullName: string, prNumber: number): Promise<AdoptionPrFacts | null> {
  const { githubApi } = await import('@/lib/github');
  const pr = await githubApi(installationId, `/repos/${repoFullName}/pulls/${prNumber}`) as Record<string, any> | null;
  if (!pr?.head) return null;
  return {
    headRef: pr.head?.ref ?? null, baseRef: pr.base?.ref ?? null, headSha: pr.head?.sha ?? null, author: pr.user?.login ?? null,
    headRepoFullName: pr.head?.repo?.full_name ?? null, baseRepoFullName: pr.base?.repo?.full_name ?? null, body: pr.body ?? null,
  };
}

/** What a refusal says to the door's caller, by `open_delivery`'s reason. */
function refusal(reason: string, prNumber: number): Extract<MergeAdoption, { kind: 'refused' }> {
  const why = reason === 'no_owner_task' ? 'no task owns it'
    : reason === 'no_task' ? 'its task is not in this workspace'
    : reason === 'review_task' ? 'its only task is a review'
    : reason === 'attempt_task' ? 'its task is a repair of another delivery'
    : reason === 'owner_bound_to_other_pr' ? 'its task already delivers another PR'
    : reason === 'adoption_unavailable' ? 'the workflow could not be reached to take it on'
    : reason === 'fork' ? 'it comes from a fork, whose branch buildd cannot push to or review as a delivery (merge it on GitHub)'
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

  // What the PR is, before anything is opened for it.
  let facts: AdoptionPrFacts | null;
  let ws: Awaited<ReturnType<typeof defaultWorkspace>>;
  try {
    ws = await (deps.workspace ?? defaultWorkspace)(p.workspaceId);
    if (!ws || !kernelEnabled(ws.gitConfig)) return { kind: 'legacy', reason: 'kernel_off' };
    facts = await (deps.readPr ?? defaultReadPr)(p.installationId, p.repoFullName, p.prNumber);
  } catch (err) {
    console.error(`[merge-adoption] ${p.repoFullName}#${p.prNumber}: could not read the PR or its workspace; nothing merges:`, err);
    return refusal('adoption_unavailable', p.prNumber);
  }
  if (!facts) return refusal('adoption_unavailable', p.prNumber);
  // A release PR's bookkeeping (the held release task, the release record, the candidate status) lives
  // outside the kernel, and a kernel repair must never push to a frozen candidate: the release gate merges it.
  const cls = classifyReleasePr(ws.releaseConfig as Parameters<typeof classifyReleasePr>[0], facts);
  if (cls.kind === 'legacy' || cls.kind === 'candidate') return { kind: 'gate', why: 'release' };
  // A dependency bot owns its branch (dependency-bot-pr.ts): no delivery, so no kernel repair pushes to it.
  if (isDependencyBotAuthor(facts.author ? { login: facts.author } : null)) return { kind: 'gate', why: 'dependency_bot' };
  // A fork's branch cannot be bound (pr_bound rejects it): say so, and open nothing to release.
  if (facts.headRepoFullName && facts.baseRepoFullName && facts.headRepoFullName.toLowerCase() !== facts.baseRepoFullName.toLowerCase()) {
    return refusal('fork', p.prNumber);
  }
  if (!p.taskId) return refusal('no_owner_task', p.prNumber);

  try {
    const ownerTaskId = await (deps.ownerOf ?? defaultOwnerOf)(p.taskId).catch(() => p.taskId!);
    const open = deps.open ?? (await import('@/lib/workflow/kernel-client')).openKernelDelivery;
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

/**
 * The merge of a PR adoption answered `gate` for (a release PR, a dependency bot's PR): the release
 * gate (`release/pinned-merge.ts`: a live read, the review gate at the head, GitHub's `sha` pin), in
 * the shape a door's legacy merge result has. Never the unpinned legacy merge.
 */
export async function mergeOutsideKernel(p: {
  workspaceId: string; installationId: number; repoFullName: string; prNumber: number; headSha: string;
  mergeMethod: 'merge' | 'squash' | 'rebase'; door: string; actorUserId?: string | null; taskId?: string | null;
}, deps: { merge?: typeof import('@/lib/release/pinned-merge').mergeReleasePrPinned } = {}): Promise<{ merged: boolean; message: string; indeterminate?: boolean; hold?: boolean }> {
  const merge = deps.merge ?? (await import('@/lib/release/pinned-merge')).mergeReleasePrPinned;
  const r = await merge({
    workspaceId: p.workspaceId, installationId: p.installationId, repoFullName: p.repoFullName, prNumber: p.prNumber,
    verifiedHeadSha: p.headSha, mergeMethod: p.mergeMethod, surface: p.door, actorUserId: p.actorUserId ?? null, taskId: p.taskId ?? null,
  });
  if (r.merged) return { merged: true, message: r.message };
  // `hold`: the release gate is waiting (a required check, the review, the kernel): a wait, not a failed merge.
  return { merged: false, message: r.message, ...(r.indeterminate ? { indeterminate: true } : {}), ...(r.hold ? { hold: true } : {}) };
}
