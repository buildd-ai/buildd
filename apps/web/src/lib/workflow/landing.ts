/**
 * Landing through the kernel (docs/specs/workflow-state-kernel.md §6.3 T15/T16,
 * §14 Slice C). Every merge door — `landPr`, `tryAutoMergeWorkerPr`, the
 * dashboard merge route and `merge_pr` — keeps its own rails (CI, deny paths,
 * size, migration inspector, freshness, surface order, review gate, mission-PR
 * gate) and, for a kernel-owned PR, hands the merge itself to the kernel here
 * instead of calling GitHub:
 *
 *   LandingRequested (T15) → `merge_call` effect (the pinned PUT /merge)
 *     → MergeCallResult (T16) → `verify_merge` (a live read) → PrMerged (T17)
 *     → post-merge effects (fact cache, task completion, dependents, mission
 *       wake, release attribution, mission-branch deletion).
 *
 * The effects are drained inline, so a door still answers "merged" in the same
 * request; a crash anywhere after T15 committed leaves durable effect rows the
 * cron drain finishes. A door never stamps `mergedAt` or runs post-merge work
 * itself for a kernel-owned PR.
 *
 * A person's action carries the delivery `version` they saw (§7.2): a stale
 * one is answered `stale` with the current view (HTTP 409) and applies nothing.
 */
import { sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import type { CurrentView, LivePr } from './commands';
import { applyCommand, loadView, type CommandResult, type Exec } from './kernel';
import { ingestFact, type GithubFactReader } from './facts';
import { kernelDeliveryForPr } from './authority';
import { githubReader } from './github-facts';
import type { DrainSummary } from './effects';

const dbExec: Exec = (q) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;

export interface LandingDeps {
  exec?: Exec;
  reader?: (installationId: number) => GithubFactReader;
  /** Drains one delivery's due effects (seam.ts `drainDelivery`); injected so tests run the real handlers. */
  drain: (deliveryId: string) => Promise<DrainSummary | null>;
}

export interface LandingInput {
  workspaceId: string;
  installationId: number;
  repoFullName: string;
  prNumber: number;
  /** The live head the door's rails evaluated; the merge is pinned to it. */
  headSha: string;
  /** Which door asked (recorded on the transition; never changes the decision). */
  door: string;
  /** `human:<user>`, `agent:<worker>` or `system:<door>`. */
  actor: string;
  mergeMethod?: 'merge' | 'squash' | 'rebase';
  /** A person merging past a review verdict; recorded in the transition's `bypass`. */
  override?: { reason: string } | null;
  /** The delivery version the caller saw (human and agent callers, §7.2). */
  expectedVersion?: number;
}

export type LandingOutcome =
  /** GitHub accepted the merge, or the live read shows the PR merged. */
  | 'merged'
  /** The merge call's answer was lost; the kernel verifies with a live read before anything re-calls it. */
  | 'landing'
  /** GitHub refused because the branch is behind; a mechanical refresh was queued (REPAIRING(behind)). */
  | 'behind'
  /** GitHub refused with a conflict; the conflict repair was queued (REPAIRING(conflict)). */
  | 'conflict'
  /** GitHub refused for another reason; a person owns it (ESCALATED(landing_needs_human)). */
  | 'refused'
  /** Nothing landed and nothing is owed (the head moved under the call); landing may be asked again. */
  | 'not_merged'
  /** The caller's version or head is behind the delivery: nothing applied. */
  | 'stale'
  /** The kernel refused the landing (state, coverage, rails); nothing applied. */
  | 'rejected';

export interface KernelLanding {
  merged: boolean;
  outcome: LandingOutcome;
  /** Kernel reason (`version_moved`, `state_not_allowed`, …) or GitHub's message. */
  reason: string;
  /** Human-readable, for a door's response. */
  message: string;
  /** True only for `landing`: GitHub's answer was lost and the live read is still pending. */
  indeterminate?: boolean;
  mergeCommitSha: string | null;
  /** The delivery as it stands after the request (the S20 409 body). */
  current: CurrentView;
  result: CommandResult | null;
}

const NOT_LOADED: CurrentView = { state: null, version: 0, head: null, round: 0 };

/** The delivery a person's merge would act on: its version, for the S20 check before any rail runs. */
export async function kernelLandingView(workspaceId: string, repoFullName: string, prNumber: number, exec: Exec = dbExec): Promise<{ deliveryId: string; current: CurrentView } | null> {
  const deliveryId = await kernelDeliveryForPr(workspaceId, repoFullName, prNumber, exec);
  if (!deliveryId) return null;
  const d = (await loadView({ deliveryId }, exec)).delivery;
  if (!d) return null;
  return { deliveryId, current: { state: d.state, version: d.version, head: d.currentHeadSha, round: d.currentRound } };
}

/**
 * §7.2 for a version-carrying human action, checked before any rail runs (a
 * stale screen must not trigger a refresh or a fix dispatch either). Null =
 * nothing to refuse: no kernel delivery, no version supplied, or it matches.
 */
export async function staleLandingVersion(p: { workspaceId: string; repoFullName: string; prNumber: number; expectedVersion?: number | null }, exec: Exec = dbExec): Promise<CurrentView | null> {
  if (p.expectedVersion == null) return null;
  const v = await kernelLandingView(p.workspaceId, p.repoFullName, p.prNumber, exec);
  if (!v) return null;
  return v.current.version === p.expectedVersion ? null : v.current;
}

/** The newest MergeCallResult for the delivery, for the door's message. */
async function lastMergeResult(deliveryId: string, exec: Exec): Promise<{ outcome: string | null; detail: string | null } | null> {
  const row = ((await exec(sql`-- workflow:last_merge_result
SELECT evidence->>'outcome' AS outcome, evidence->>'detail' AS detail FROM workflow_transitions
WHERE delivery_id = ${deliveryId}::uuid AND command = 'MergeCallResult'
ORDER BY to_version DESC LIMIT 1`)).rows ?? [])[0] as { outcome: string | null; detail: string | null } | undefined;
  return row ?? null;
}

function current(view: Awaited<ReturnType<typeof loadView>>): CurrentView {
  const d = view.delivery;
  return d ? { state: d.state, version: d.version, head: d.currentHeadSha, round: d.currentRound } : NOT_LOADED;
}

/**
 * The merge of a kernel-owned PR. Returns null when the kernel does not own
 * the PR (no delivery, released, or the kill switch is off): the door merges
 * on its legacy path, unchanged.
 */
export async function landThroughKernel(p: LandingInput, deps: LandingDeps): Promise<KernelLanding | null> {
  const exec = deps.exec ?? dbExec;
  const deliveryId = await kernelDeliveryForPr(p.workspaceId, p.repoFullName, p.prNumber, exec);
  if (!deliveryId) return null;
  const reader = (deps.reader ?? githubReader)(p.installationId);
  const live = await reader.readPr(p.repoFullName, p.prNumber);
  const pinned: GithubFactReader = { ...reader, readPr: async () => live };

  const settle = async (): Promise<void> => {
    // merge_call → verify_merge → PrMerged → post-merge effects: each pass picks up what the last one queued.
    for (let i = 0; i < 3; i++) {
      const s = await deps.drain(deliveryId);
      if (!s || s.claimed === 0) break;
    }
  };

  if (!live) {
    const view = await loadView({ deliveryId }, exec);
    return { merged: false, outcome: 'rejected', reason: 'live_read_failed', message: 'Could not read the PR from GitHub; nothing was merged. Retry.', mergeCommitSha: null, current: current(view), result: null };
  }
  if (live.merged) {
    // Already merged (a person on GitHub, or a door that lost the race): the fact, not a second merge.
    await ingestFact({ kind: 'pr_closed', workspaceId: p.workspaceId, source: `${p.door}:already_merged`, repoFullName: p.repoFullName, prNumber: p.prNumber }, { exec, github: pinned });
    await settle();
    const view = await loadView({ deliveryId }, exec);
    return { merged: true, outcome: 'merged', reason: 'already_merged', message: 'Pull request was already merged', mergeCommitSha: live.mergeCommitSha ?? null, current: current(view), result: null };
  }

  // A head the webhook has not delivered yet is recorded first (R2), so the
  // landing names the head GitHub holds now.
  if (live.headSha !== p.headSha) {
    const view = await loadView({ deliveryId }, exec);
    await ingestFact({ kind: 'head_observed', workspaceId: p.workspaceId, source: `${p.door}:landing`, repoFullName: p.repoFullName, prNumber: p.prNumber }, { exec, github: pinned });
    await settle();
    return {
      merged: false, outcome: 'stale', reason: 'head_moved',
      message: `The PR head moved to ${live.headSha.slice(0, 7)} after it was checked; nothing was merged.`,
      mergeCommitSha: null, current: current(await loadView({ deliveryId }, exec)), result: { result: 'stale', reason: 'head_moved', current: current(view) },
    };
  }
  await ingestFact({ kind: 'head_observed', workspaceId: p.workspaceId, source: `${p.door}:landing`, repoFullName: p.repoFullName, prNumber: p.prNumber }, { exec, github: pinned });

  const result = await applyCommand({
    type: 'LandingRequested',
    actor: p.actor,
    door: p.door,
    headSha: p.headSha,
    live: live as LivePr,
    // The door's rails already passed (they stay where they were, §17.2); a
    // red-CI or deny-path refusal never reaches this call.
    rails: { passed: true },
    ...(p.override ? { override: p.override } : {}),
    ...(p.mergeMethod ? { mergeMethod: p.mergeMethod } : {}),
    ...(p.expectedVersion !== undefined ? { expectedVersion: p.expectedVersion } : {}),
  }, { ref: { deliveryId }, exec });

  if (result.result === 'stale' || result.result === 'rejected') {
    const message = result.result === 'stale'
      ? `This PR changed since you looked at it (${result.reason}); nothing was merged. Reload and try again.`
      : `The workflow refused to land this PR (${result.reason}${'missing' in result && result.missing?.length ? `: ${result.missing.join(', ')}` : ''}); nothing was merged.`;
    return { merged: false, outcome: result.result, reason: result.reason, message, mergeCommitSha: null, current: result.current, result };
  }

  await settle();
  const view = await loadView({ deliveryId }, exec);
  const d = view.delivery!;
  const last = await lastMergeResult(deliveryId, exec);
  const detail = last?.detail ?? '';
  const base = { mergeCommitSha: d.mergeCommitSha, current: current(view), result };
  if (d.state === 'MERGED') return { ...base, merged: true, outcome: 'merged', reason: 'merged', message: detail || 'Pull request merged' };
  if (last?.outcome === 'merged') {
    // GitHub accepted the merge; the live read that records it is still to come.
    return { ...base, merged: true, outcome: 'merged', reason: 'merge_accepted', message: detail || 'Pull request merged' };
  }
  if (d.state === 'LANDING') {
    return { ...base, merged: false, outcome: 'landing', indeterminate: true, reason: last?.outcome ?? 'merge_pending', message: detail || 'The merge was requested; its result is being verified.' };
  }
  if (d.state === 'REPAIRING' && (d.stateReason === 'behind' || d.stateReason === 'conflict' || d.stateReason === 'migration')) {
    const outcome = d.stateReason === 'behind' ? 'behind' : 'conflict';
    return { ...base, merged: false, outcome, reason: d.stateReason, message: detail || (outcome === 'behind' ? 'The branch is behind its base; it is being updated.' : 'The PR has merge conflicts; a fix is queued.') };
  }
  if (last?.outcome === 'not_merged') return { ...base, merged: false, outcome: 'not_merged', reason: 'not_merged', message: detail || 'Nothing was merged.' };
  return { ...base, merged: false, outcome: 'refused', reason: d.stateReason ?? last?.outcome ?? 'refused', message: detail || 'GitHub refused the merge; a person needs to look at it.' };
}
