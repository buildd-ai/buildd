/**
 * The causal chains `explain` returns — pure, so they can be asserted without a
 * database.
 *
 * A chain reads cause → effect and ends on the observed state. Every link
 * carries hard references (`ExplainRefs`) and names the row it was read from.
 * There is no model in this file and no prose generation: if a link cannot
 * point at a row, it is not emitted.
 *
 * ## Where the edges come from
 *
 * There is no causal-graph store and none is wanted. The edges are already
 * first-class columns — `tasks.parentTaskId`, `tasks.dependsOn`,
 * `tasks.missionId`, `tasks.pathManifest`, `workers.branch` / `prNumber` /
 * `prBaseRef` / `mergedAt` / `observedTouches`. These builders traverse those
 * authoritative rows. The KnowledgeStore entity graph is a retrieval-expansion
 * index for `recall` and is never a source here.
 */
import type { CausalLink, ExplainRefs, TouchSource } from './explain-types';
import { orderChain } from './explain-types';
import { intersectPaths } from '@buildd/core/path-overlap';
import type { MissionStateView, WaitingOnDescriptor } from './mission-state-view';
import { suggestionRef } from './mission-state-view';
import type { SupersessionSuggestion } from '@buildd/core/pr-shipped';
import { ENTITLEMENT_BLOCK_CONTEXT_KEY, parseEntitlementBlock } from '@buildd/shared';

const repoOf = (url: string | null | undefined) => url?.match(/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/)?.[1] ?? null;

export type { TouchSource } from './explain-types';

type Link = Omit<CausalLink, 'order'>;

function link(claim: string, derivedFrom: CausalLink['derivedFrom'], refs: ExplainRefs = {}): Link {
  return { claim, derivedFrom, refs };
}

// ─── Mission / task chain ─────────────────────────────────────────────────────

export interface BecauseSubjectRefs {
  missionId?: string | null;
  taskId?: string | null;
  workspaceId?: string | null;
}

/** Row-level detail the chain needs to name what the view only counted. */
export interface StateBecauseExtras {
  /**
   * Open deliverable rows, for naming which tasks are holding.
   *
   * `live` is per-task: true when a worker in a live status is on this row.
   * The mission-level `activeAgents` count cannot answer it — a running
   * mission has open rows both with and without a worker, and "no live
   * worker" is only true of the latter. Omitted = unknown; see
   * `openTaskLinks`.
   */
  openTasks?: Array<{
    id: string;
    title: string | null;
    status: string;
    live?: boolean;
    missingBrowser?: boolean;
    /**
     * Unmet dependencies of a pending row. Such a row cannot be claimed, so it
     * is described as waiting on them (and ref'd to the first), never as
     * orphaned — and it never leads the chain.
     */
    waitingOn?: Array<{ id: string; title: string | null }>;
  }>;
  /** Failed rows with the signature their failure was bucketed under. */
  failedTasks?: Array<{ id: string; title: string | null; errorSignature?: string | null }>;
  /** Unmerged PRs holding completion. */
  unmergedPrs?: Array<{
    taskId: string;
    title: string;
    prNumber: number | null;
    prUrl: string | null;
    /**
     * True when the PR is closed (will never merge on its own) with no
     * supersession edge recorded — the remedy is `record_pr_supersession`,
     * not "wait for it to merge" (task fcaf83d5).
     */
    closedUnsuperseded?: boolean;
    /** Unverified candidate from automatic detection — a hint, not an edge. */
    suggestion?: SupersessionSuggestion;
  }>;
  /** Upstream mission title, when it was loaded. */
  dependencyTitle?: string | null;
  /**
   * Failed rows excluded from the health signal because their deliverable
   * shipped anyway — see `mission-task-superseded.ts`. Reported unconditionally
   * (not gated on `view.kind`), since these tasks never drive `failing` and
   * would otherwise be invisible to `because[]`.
   */
  supersededTasks?: Array<{ id: string; title: string | null; prNumber: number; supersedingTaskId?: string | null }>;
}

/**
 * The chain behind a `MissionStateView`.
 *
 * The view already owns the precedence; this turns the winning blocker into
 * the rows that produced it. The last link is always the state itself, so a
 * reader who stops at the end has the conclusion and the evidence for it.
 */
export function buildStateBecause(
  view: MissionStateView,
  subject: BecauseSubjectRefs,
  extra: StateBecauseExtras = {},
): CausalLink[] {
  const base: ExplainRefs = {
    ...(subject.missionId ? { missionId: subject.missionId } : {}),
    ...(subject.taskId ? { taskId: subject.taskId } : {}),
    ...(subject.workspaceId ? { workspaceId: subject.workspaceId } : {}),
  };
  const links: Link[] = [];
  const w = view.waitingOn;

  // Every outstanding fact, not just the precedence winner. `view.outstanding`
  // leads with `waitingOn` when there is one, so this is a superset of the old
  // behaviour — and it is what stops a `running` verdict from producing the
  // chain "no source reports anything outstanding" over the top of an open
  // mission PR.
  for (const fact of view.outstanding) {
    links.push(...causeLinksFor(fact, base, extra));
  }

  for (const t of extra.supersededTasks ?? []) {
    links.push(
      link(
        t.supersedingTaskId
          ? `Task "${t.title ?? t.id}" failed, but sibling task "${t.supersedingTaskId}" completed the same work via merged PR #${t.prNumber}, so it does not count as a mission failure.`
          : `Task "${t.title ?? t.id}" failed, but its target PR #${t.prNumber} merged, so it does not count as a mission failure.`,
        'tasks.subjectPrNumber + workers.mergedAt',
        { ...base, taskId: t.id, prNumber: t.prNumber },
      ),
    );
  }

  // The closing link is the conclusion. When the verdict is quiet but facts are
  // outstanding, it must say BOTH — reporting "nothing outstanding" while the
  // links above it name an unmerged PR is the contradiction this chain existed
  // to make impossible.
  const closing = w
    ? `State is ${view.kind} because ${w.label}.`
    : view.outstanding.length > 0
      ? `State is ${view.kind}, but ${view.outstanding.length} fact(s) are still outstanding: ${view.outstanding.map(o => o.label).join('; ')}.`
      : `State is ${view.kind}. No source reports outstanding work.`;
  links.push(link(closing, view.derivedFrom.kind, base));

  return orderChain(links);
}

/**
 * One link per open deliverable, worded by whether THAT row has a live worker.
 *
 * "No live worker" is a claim about a single task. It used to be stamped on
 * every open row whenever the open-task fact was outstanding — including the
 * `running` reading of that fact, where by construction something IS live —
 * so a task a worker was running read as orphaned, and the situation block
 * offered to "open the blocking task".
 *
 * Unknown liveness falls back to the fact's own reading: the `warning` tone is
 * only produced when nothing in the mission is live, so every row really has
 * no worker; the `neutral` tone means something is, and the row is described
 * without guessing which.
 *
 * Rows without a worker lead: `because[0]` is the line the situation block
 * prints, and the task nothing is executing is the one worth reading about.
 */
function openTaskLinks(
  w: Extract<WaitingOnDescriptor, { kind: 'task' }>,
  base: ExplainRefs,
  extra: StateBecauseExtras,
): Link[] {
  const nothingLive = w.tone === 'warning';
  type Row = NonNullable<StateBecauseExtras['openTasks']>[number];
  const depBlocked = (t: Row) => (t.waitingOn?.length ?? 0) > 0;
  const orphaned = (t: Row) => !depBlocked(t) && (t.live === undefined ? nothingLive : !t.live);
  const rank = (t: Row) => (orphaned(t) ? 0 : depBlocked(t) ? 2 : 1);
  const rows = [...(extra.openTasks ?? [])].sort((a, b) => rank(a) - rank(b));
  return rows.slice(0, 10).map(t => {
    if (depBlocked(t)) {
      const deps = t.waitingOn!;
      const named = deps.map(d => `"${d.title ?? d.id}"`).join(', ');
      return link(
        `Task "${t.title ?? t.id}" is waiting on ${deps.length === 1 ? 'its dependency' : 'its dependencies'} ${named}.`,
        'tasks.dependsOn',
        { ...base, taskId: deps[0].id },
      );
    }
    // A local-executor mission: its rows are the person's session's to claim,
    // so "no live worker" (read: a runner should have it) is the wrong claim.
    if (w.local && !t.live) {
      return link(
        t.status === 'pending'
          ? `Task "${t.title ?? t.id}" is pending, waiting for a local session to claim it (runners never pick up this mission's tasks).`
          : `Task "${t.title ?? t.id}" is ${t.status} in a local session.`,
        'mission.executor',
        { ...base, taskId: t.id },
      );
    }
    if (t.missingBrowser && orphaned(t)) {
      return link(
        `Task "${t.title ?? t.id}" is waiting for a runner with the missing browser capability. No eligible runner advertises a working browser provider for this workspace.`,
        'tasks.roleSlug + workerHeartbeats.environment + workspaces.gitConfig.executor',
        { ...base, taskId: t.id },
      );
    }
    return link(
      orphaned(t)
        ? `Task "${t.title ?? t.id}" is ${t.status} with no live worker.`
        : t.live
          ? `Task "${t.title ?? t.id}" is ${t.status}. A worker is running it.`
          : `Task "${t.title ?? t.id}" is ${t.status} and not finished yet.`,
      'tasks.status + workers.status',
      { ...base, taskId: t.id },
    );
  });
}

function causeLinksFor(
  w: WaitingOnDescriptor,
  base: ExplainRefs,
  extra: StateBecauseExtras,
): Link[] {
  switch (w.kind) {
    case 'dependency':
      return [
        link(
          extra.dependencyTitle
            ? `Upstream mission "${extra.dependencyTitle}" has not met this mission's gate condition.`
            : 'The upstream mission has not met this mission\'s gate condition.',
          'missions.dependsOnMissionId',
          { ...base, missionId: w.missionId },
        ),
      ];

    case 'task':
      if (w.attempt) {
        const t = (extra.openTasks ?? []).find(o => w.taskIds.includes(o.id));
        const name = t ? `"${t.title ?? t.id}"` : 'A fix attempt';
        return [
          link(
            w.attempt.claimed
              ? `Fix attempt ${name} is ${t?.status ?? 'open'}. A worker has claimed it.`
              : `Fix attempt ${name} is queued with no worker yet.`,
            'tasks.status + workers.status',
            { ...base, taskId: w.taskIds[0] },
          ),
        ];
      }
      return openTaskLinks(w, base, extra);

    case 'task_failed':
      return (extra.failedTasks ?? []).slice(0, 10).map(t =>
        link(
          w.infra
            ? `Task "${t.title ?? t.id}" failed on infrastructure after exhausting retries.`
            : `Task "${t.title ?? t.id}" failed.`,
          'tasks.status + tasks.result.errorType',
          {
            ...base,
            taskId: t.id,
            ...(t.errorSignature ? { errorSignature: t.errorSignature } : {}),
          },
        ),
      );

    case 'merge':
      return (extra.unmergedPrs ?? []).slice(0, 10).map(p =>
        link(
          p.closedUnsuperseded
            ? `Task "${p.title}" is completed but its PR closed without merging, and nothing recorded that the `
              + 'work shipped elsewhere. If it did, record it with record_pr_supersession.'
            : `Task "${p.title}" is completed but its PR has not merged.`,
          p.closedUnsuperseded ? 'workers.mergedAt + workers.prLifecycleStatus + workers.supersededByPrNumber' : 'workers.mergedAt',
          {
            ...base,
            taskId: p.taskId,
            ...(p.prNumber != null ? { prNumber: p.prNumber } : {}),
            ...(p.prUrl ? { prUrl: p.prUrl } : {}),
          },
        ),
      );

    case 'ci_red':
      return (extra.unmergedPrs ?? [])
        .filter(p => w.taskIds.includes(p.taskId))
        .slice(0, 10)
        .map(p =>
          link(
            `Task "${p.title}" is completed but its PR's CI is still red after ${w.attempts} fix attempt${w.attempts === 1 ? '' : 's'}`
              + `${w.failing.length ? `: ${w.failing.join(', ')}` : ''}.`,
            'workers.prLifecycleStatus + tasks.parentTaskId',
            {
              ...base,
              taskId: p.taskId,
              ...(p.prNumber != null ? { prNumber: p.prNumber } : {}),
              ...(p.prUrl ? { prUrl: p.prUrl } : {}),
            },
          ),
        );

    case 'pr_closed_unmerged':
      return (extra.unmergedPrs ?? [])
        .filter(p => p.closedUnsuperseded)
        .slice(0, 10)
        .map(p =>
          link(
            p.suggestion
              ? `Task "${p.title}" is completed but its PR closed without merging. It is likely superseded by `
                + `${suggestionRef(p.suggestion, repoOf(p.prUrl))} (${p.suggestion.why}), but the content did not verify, `
                + 'so nothing was recorded. Confirm it, or mark the PR abandoned with a reason.'
              : `Task "${p.title}" is completed but its PR closed without merging, and nothing recorded that the `
                + 'work shipped elsewhere. If it did, record it with record_pr_supersession; if it is not shipping, mark it abandoned.',
            p.suggestion
              ? 'workers.mergedAt + workers.prLifecycleStatus + workers.supersededByPrNumber + workers.supersessionScan'
              : 'workers.mergedAt + workers.prLifecycleStatus + workers.supersededByPrNumber',
            {
              ...base,
              taskId: p.taskId,
              ...(p.prNumber != null ? { prNumber: p.prNumber } : {}),
              ...(p.prUrl ? { prUrl: p.prUrl } : {}),
            },
          ),
        );

    case 'criterion_failing':
      return (w.criteria.length ? w.criteria : ['criterion']).map(c =>
        link(`Goal criterion "${c}" returned a failing verdict.`, 'missions.goalCriteriaState', {
          ...base,
          criterion: c,
        }),
      );

    case 'criterion_unverified':
      return (w.criteria.length ? w.criteria : ['criterion']).map(c =>
        link(`Goal criterion "${c}" has no verdict yet.`, 'missions.goalCriteriaState', {
          ...base,
          criterion: c,
        }),
      );

    case 'human_decision':
      return [
        link(
          w.detail ? `An owner decision is open: ${w.detail}` : 'An owner decision is open.',
          'missions.criteriaEscalatedAt + missionNotes',
          base,
        ),
      ];

    case 'self_resolving_wait':
      return [
        link(
          w.waitUntil
            ? `Every open task is on a known self-resolving wait (${w.reason}) until ${w.waitUntil}.`
            : `Every open task is on a known self-resolving wait (${w.reason}).`,
          'classifyMissionWait',
          base,
        ),
      ];

    case 'claim_deferral':
      return w.taskIds.slice(0, 10).map(taskId =>
        link(
          `The claim loop refused this task ${w.consecutiveDeferrals} consecutive polls for the same reason (${w.reason})`
          + `${w.firstDeferredAt ? `, first at ${w.firstDeferredAt}` : ''}. The task has not started.`,
          'gate_events.detail.consecutiveDeferrals',
          { ...base, taskId },
        ),
      );
  }
}

// ─── Conflicted-PR chain ──────────────────────────────────────────────────────

export interface ConflictSubject {
  prNumber: number;
  taskId: string | null;
  branch: string | null;
  baseRef: string | null;
  /** `workers.prLifecycleStatus`. */
  lifecycleStatus: string | null;
  conflictDetectedAt: string | null;
  /** Base SHA captured when the PR opened (`workers.prOpenedBaseSha`). */
  openedBaseSha: string | null;
  openedAt: string | null;
  touches: string[];
  touchSource: TouchSource;
}

/** A PR that merged into the same base after the subject PR opened. */
export interface BaseSideMerge {
  prNumber: number | null;
  taskId: string | null;
  title: string | null;
  branch: string | null;
  mergedAt: string | null;
  /** `workers.lastCommitSha` — the head commit the merge carried. */
  headSha: string | null;
  touches: string[];
  touchSource: TouchSource;
}

export interface ConflictExplanation {
  links: CausalLink[];
  /**
   * Merges into the same base recorded after this PR opened. A FLOOR: only PRs
   * buildd itself opened have rows, so a hand-merged commit is invisible here.
   */
  commitsBehindBase: number;
  /** Union of the paths this PR shares with those merges. */
  conflictingPaths: string[];
}

/**
 * Why a `mergeable: dirty` PR is dirty, named rather than asserted.
 *
 * Reads only rows: `workers.prBaseRef` / `mergedAt` / `lastCommitSha` for the
 * base-side merges, and `workers.observedTouches` ∪ `tasks.pathManifest` for
 * both touch sets. No merge is attempted and no git command is run — the whole
 * point is that the answer is already in the database.
 *
 * The chain reads cause → effect: dev-side merges landed → they touched these
 * files → this branch touches them too → GitHub reports the PR conflicted.
 */
export function buildConflictBecause(
  subject: ConflictSubject,
  baseSide: BaseSideMerge[],
): ConflictExplanation {
  const baseLabel = subject.baseRef ?? 'the base branch';
  const refs: ExplainRefs = {
    prNumber: subject.prNumber,
    ...(subject.taskId ? { taskId: subject.taskId } : {}),
    ...(subject.branch ? { branch: subject.branch } : {}),
    ...(subject.baseRef ? { baseRef: subject.baseRef } : {}),
  };

  const links: Link[] = [];

  links.push(
    link(
      `${baseSide.length} PR(s) merged into \`${baseLabel}\` after PR #${subject.prNumber} opened` +
        (subject.openedBaseSha ? ` at base ${subject.openedBaseSha.slice(0, 12)}.` : '.'),
      // Named precisely: this counts recorded merges, not `git rev-list` output.
      // buildd stores no base-drift metric, so this is a floor — a merge nobody
      // opened through buildd leaves no row and is invisible here.
      'workers.mergedAt (merges into this base recorded since the PR opened — a floor, not a rev-list)',
      {
        ...refs,
        ...(subject.openedBaseSha ? { commitSha: subject.openedBaseSha } : {}),
      },
    ),
  );

  const overlapping: Array<{ merge: BaseSideMerge; paths: string[] }> = [];
  for (const m of baseSide) {
    const paths = intersectPaths(subject.touches, m.touches);
    if (paths.length > 0) overlapping.push({ merge: m, paths });
  }

  const conflictingPaths = [...new Set(overlapping.flatMap(o => o.paths))];

  if (subject.touchSource === 'undeclared') {
    links.push(
      link(
        `PR #${subject.prNumber} declared no file scope, so the conflicting paths cannot be named from stored data.`,
        'tasks.pathManifest (repo-wide sentinel) + workers.observedTouches (empty)',
        refs,
      ),
    );
  } else if (conflictingPaths.length > 0) {
    links.push(
      link(
        `PR #${subject.prNumber} touches ${conflictingPaths.length} of those file(s): ${conflictingPaths.join(', ')}.`,
        'workers.observedTouches ∪ tasks.pathManifest',
        { ...refs, paths: conflictingPaths, touchSource: subject.touchSource },
      ),
    );
    for (const { merge, paths } of overlapping) {
      links.push(
        link(
          `PR #${merge.prNumber ?? '?'}${merge.title ? ` ("${merge.title}")` : ''} merged into \`${baseLabel}\`` +
            `${merge.mergedAt ? ` at ${merge.mergedAt}` : ''} and touched ${paths.join(', ')}.`,
          'workers.mergedAt + workers.observedTouches ∪ tasks.pathManifest',
          {
            ...(merge.prNumber != null ? { prNumber: merge.prNumber } : {}),
            ...(merge.taskId ? { taskId: merge.taskId } : {}),
            ...(merge.branch ? { branch: merge.branch } : {}),
            ...(merge.headSha ? { commitSha: merge.headSha } : {}),
            ...(subject.baseRef ? { baseRef: subject.baseRef } : {}),
            paths,
            touchSource: merge.touchSource,
          },
        ),
      );
    }
  } else if (baseSide.length > 0) {
    links.push(
      link(
        `No stored touch set for those merges overlaps PR #${subject.prNumber}'s. The conflict is in files neither side declared.`,
        'workers.observedTouches ∪ tasks.pathManifest (no intersection)',
        refs,
      ),
    );
  }

  links.push(
    link(
      `PR #${subject.prNumber} is ${subject.lifecycleStatus === 'conflict' ? 'conflicted' : `in lifecycle state \`${subject.lifecycleStatus ?? 'unknown'}\``}` +
        ` against \`${baseLabel}\`` +
        (subject.conflictDetectedAt ? `, first detected at ${subject.conflictDetectedAt}.` : '.'),
      'workers.prLifecycleStatus + workers.conflictDetectedAt',
      refs,
    ),
  );

  return {
    links: orderChain(links),
    commitsBehindBase: baseSide.length,
    conflictingPaths,
  };
}

// ─── Dispatch wake (a pending task's latest outbox row) ──────────────────────

/** A wake still inside this window is in flight, not stuck. */
export const DISPATCH_WAKE_GRACE_MS = 5 * 60_000;

/** The newest `task_dispatch_outbox` row of a task, as core latestDispatchForTask returns it. */
export interface LatestDispatchRow {
  id?: unknown;
  status?: unknown;
  cause?: unknown;
  transport?: unknown;
  attempt_count?: unknown;
  not_before?: unknown;
  handed_off_at?: unknown;
  last_error?: unknown;
}

const isoOf = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/**
 * Why a pending task has not started, when the reason is its wake: the
 * latest intent is due and undelivered, handed off to Dispatch past due with
 * no receipt, or failed. Null when the wake is fine (still inside its window,
 * scheduled for later, or delivered); the claim gates then explain the rest.
 */
export function dispatchWakeLink(row: LatestDispatchRow | null | undefined, subject: BecauseSubjectRefs, nowMs: number): Link | null {
  if (!row || typeof row.id !== 'string') return null;
  const refs: ExplainRefs = {
    ...(subject.taskId ? { taskId: subject.taskId } : {}),
    ...(subject.workspaceId ? { workspaceId: subject.workspaceId } : {}),
    outboxId: row.id,
  };
  const due = isoOf(row.not_before);
  const pastDue = due !== null && nowMs - Date.parse(due) > DISPATCH_WAKE_GRACE_MS;
  const attempts = Number(row.attempt_count ?? 0);
  const cause = typeof row.cause === 'string' ? row.cause : 'wake';
  const transport = typeof row.transport === 'string' ? row.transport : 'in_app';
  const err = typeof row.last_error === 'string' && row.last_error ? `; last error: ${row.last_error.slice(0, 200)}` : '';
  switch (row.status) {
    case 'pending':
      if (!pastDue) return null;
      return link(`Latest wake (${cause}) has been due since ${due} and is undelivered (${transport}, ${attempts} attempt${attempts === 1 ? '' : 's'}${err}).`, 'task_dispatch_outbox.status', refs);
    case 'handed_off':
      if (!pastDue) return null;
      return link(`Latest wake (${cause}) was handed off to Dispatch at ${isoOf(row.handed_off_at) ?? 'an unknown time'}, has been due since ${due}, and has no delivery receipt${err}.`, 'task_dispatch_outbox.status', refs);
    case 'failed':
      return link(`Latest wake (${cause}) failed after ${attempts} attempt${attempts === 1 ? '' : 's'}${err}. It is parked; the next state change writes a new wake.`, 'task_dispatch_outbox.status', refs);
    default:
      return null;
  }
}

/**
 * Slice E (§17.5): for a kernel-owned delivery, the transition that put it
 * where it is, read from `workflow_transitions` (the newest row). It is the
 * cause the chain's conclusion rests on, so it goes just before it.
 */
export function deliveryTransitionLink(
  d: { state: string; headline: string; detail: string | null; prNumber: number | null; attemptLine: string | null; lastTransition: { command: string; fromState: string | null; toState: string; createdAt: string } | null } | null | undefined,
  subject: BecauseSubjectRefs,
): Link | null {
  if (!d?.lastTransition) return null;
  const t = d.lastTransition;
  const refs: ExplainRefs = {
    ...(subject.taskId ? { taskId: subject.taskId } : {}),
    ...(subject.workspaceId ? { workspaceId: subject.workspaceId } : {}),
    ...(d.prNumber != null ? { prNumber: d.prNumber } : {}),
  };
  const moved = t.fromState ? `${t.fromState} → ${t.toState}` : t.toState;
  const detail = d.detail ? `; ${d.detail}` : '';
  const attempts = d.attemptLine ? ` (${d.attemptLine})` : '';
  return link(`Delivery is ${d.state} (${d.headline}${detail})${attempts}: ${t.command} moved it ${moved} at ${t.createdAt}.`, 'DeliveryView.lastTransition', refs);
}

/**
 * Why a pending task waits on a plan limit: the hold the claim stamped on it
 * (`tasks.context.entitlementBlock`). Null when there is none.
 */
export function entitlementHoldLink(context: unknown, subject: BecauseSubjectRefs): Link | null {
  const block = parseEntitlementBlock((context as Record<string, unknown> | null)?.[ENTITLEMENT_BLOCK_CONTEXT_KEY]);
  if (!block) return null;
  const refs: ExplainRefs = {
    ...(subject.taskId ? { taskId: subject.taskId } : {}),
    ...(subject.workspaceId ? { workspaceId: subject.workspaceId } : {}),
  };
  switch (block.kind) {
    case 'hosted_runner':
      return link(
        `Hosted runner allowance used: ${block.used} of ${block.limit} counted hours this month. New cloud runs wait until it refills (${block.resetsAt}) or grows; a runner of your own can take the task now.`,
        'tasks.context.entitlementBlock', refs);
    case 'usage':
      return link(`Monthly managed runner-hours used: ${block.used} of ${block.limit}. It starts when the allowance refills (${block.resetsAt}) or grows.`, 'tasks.context.entitlementBlock', refs);
    case 'concurrency':
      return link(`${block.active} of ${block.limit} managed runs are active. It starts when one finishes.`, 'tasks.context.entitlementBlock', refs);
  }
}

/** Insert the wake link before the chain's closing conclusion, renumbered. */
export function withDispatchLink(chain: CausalLink[], wake: Link | null): CausalLink[] {
  if (!wake) return chain;
  const links: Link[] = chain.map(({ order: _order, ...l }) => l);
  links.splice(Math.max(0, links.length - 1), 0, wake);
  return orderChain(links);
}
