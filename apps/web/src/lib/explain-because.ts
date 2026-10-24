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
import { suggestionEvidence, type RefreshCheck, type SupersessionSuggestion } from '@buildd/core/pr-shipped';
import { describeUnmetCondition, type GateCondition, type UnmetCondition } from './mission-dependency-gate';
import { ENTITLEMENT_BLOCK_CONTEXT_KEY, parseEntitlementBlock } from '@buildd/shared';
import { taskRecoverySentence } from './task-recovery-hold';
import { cancellationLine } from './task-cancellation';
import { claimHoldPhrase } from './claim-hold-phrase';
import { HIDDEN_TASK_WORDS } from './hidden-task-words';
import type { DeliveryDisagreement } from './delivery-overlay';
import { roundTriggerSentence, type DeliveryRound } from '@buildd/workflow-kernel/projections';
import { offlineRunnerWaitLine, type RunnerLiveness } from './runner-offline';

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
    /** Its worker is parked on a question for a person: the question link names it, not this row. */
    waiting?: boolean;
    /** A reviewer task: runners claim it even in a local-executor mission. */
    runnerClaimable?: boolean;
    missingBrowser?: boolean;
    /** The claim loop's newest refusal reason for this pending row (spec f7f67f1a R-33). */
    holdReason?: string | null;
    /**
     * The R-14 hold the view read for this pending row (`derivePendingTaskHold`):
     * the row text and the task it waits behind. The chain prints the same
     * words the list row shows, and refs the holder.
     */
    pendingHold?: { row: string; kind: string; holder: { id: string; title: string | null; note: string | null; hidden?: true } | null } | null;
    /**
     * Unmet dependencies of a pending row. Such a row cannot be claimed, so it
     * is described as waiting on them (and ref'd to the first it may name),
     * never as orphaned — and it never leads the chain. Resolved per viewer
     * (spec e28018c2 R-7): a `hidden` one is worded `HIDDEN_TASK_WORDS` and
     * never ref'd; one in another workspace carries `workspaceName`.
     */
    waitingOn?: Array<{ id: string; title: string | null; hidden?: boolean; workspaceName?: string | null }>;
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
    /** The owner task failed while its kernel delivery is still live (fe45dc7d): never read as completed. */
    taskFailed?: boolean;
    /** Unverified candidate from automatic detection — a hint, not an edge. */
    suggestion?: SupersessionSuggestion;
    /** A closed integration-refresh PR's own proof, instead of a suggestion. */
    refreshCheck?: RefreshCheck;
  }>;
  /** Upstream mission title, when it was loaded. */
  dependencyTitle?: string | null;
  /** The downstream's gate against the upstream's live state (`evaluateMissionGate`), when it was read. */
  dependencyGate?: { gate: GateCondition; met: boolean; unmet: UnmetCondition[] } | null;
  /**
   * Failed rows excluded from the health signal because their deliverable
   * shipped anyway — see `mission-task-superseded.ts`. Reported unconditionally
   * (not gated on `view.kind`), since these tasks never drive `failing` and
   * would otherwise be invisible to `because[]`.
   */
  supersededTasks?: Array<{ id: string; title: string | null; prNumber: number | null; supersedingTaskId?: string | null; replacedByAudit?: true; waived?: true }>;
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
    if (t.waived) {
      links.push(
        link(
          `Visual audit "${t.title ?? t.id}" stalled on infrastructure, but its review was waived by a person, so it does not count as a mission failure.`,
          'mission audit waiver',
          { ...base, taskId: t.id },
        ),
      );
      continue;
    }
    if (t.replacedByAudit || t.prNumber == null) {
      links.push(
        link(
          `Visual audit "${t.title ?? t.id}" failed, but a later audit${t.supersedingTaskId ? ` ("${t.supersedingTaskId}")` : ''} completed with passing phone and desktop screenshots of the same routes, so it does not count as a mission failure.`,
          'artifacts.metadata.qa (replacedAudits)',
          { ...base, taskId: t.id },
        ),
      );
      continue;
    }
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
      : view.situation.openChecks?.length
        ? `No task, PR or decision is open; ${view.situation.openChecks.length === 1 ? 'that check is' : 'those checks are'} what is left.`
        : 'No task, PR, check or decision is open.';
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
  const name = (t: Row) => `"${t.title ?? t.id}"`;
  return rows.filter(t => !t.waiting).slice(0, 10).map(t => {
    if (depBlocked(t)) {
      const deps = t.waitingOn!;
      const named = deps.map(d => (d.hidden
        ? HIDDEN_TASK_WORDS
        : `"${d.title ?? d.id}"${d.workspaceName ? ` in ${d.workspaceName}` : ''}`)).join(', ');
      const visible = deps.find(d => !d.hidden);
      return link(
        `${name(t)} is waiting on ${named}.`,
        'tasks.dependsOn',
        visible ? { ...base, taskId: visible.id } : { ...base, taskId: t.id },
      );
    }
    // A local-executor mission: its rows are the person's session's to claim,
    // so "waiting for a runner" is the wrong claim.
    if (w.local && !t.live && !t.runnerClaimable) {
      return link(
        t.status === 'pending'
          ? `${name(t)} is ready to start. Claim it from your session.`
          : `A session claimed ${name(t)}, but it is not running now.`,
        'mission.executor',
        { ...base, taskId: t.id },
      );
    }
    if (t.missingBrowser && orphaned(t)) {
      return link(
        `${name(t)} needs a runner with a browser. None is online for this workspace.`,
        'tasks.roleSlug + workerHeartbeats.environment + workspaces.gitConfig.executor',
        { ...base, taskId: t.id },
      );
    }
    // Navigation R-14: the row's own words, the holder named, never an id.
    if (t.status === 'pending' && t.pendingHold && orphaned(t)) {
      const h = t.pendingHold;
      const derivedFrom = h.kind === 'dependency' ? 'tasks.dependsOn'
        : h.kind === 'next_in_line' || h.kind === 'scheduled' ? 'tasks.status + workers.status'
        : 'gate_events.detail';
      return link(`${name(t)}: ${h.row}.`, derivedFrom, { ...base, taskId: h.holder && !h.holder.hidden ? h.holder.id : t.id });
    }
    const hold = t.status === 'pending' ? claimHoldPhrase(t.holdReason) : null;
    if (hold && orphaned(t)) {
      return link(`${name(t)} is queued: ${hold}.`, 'gate_events.reason', { ...base, taskId: t.id });
    }
    // A reason the derivation does not know reads as waiting, with no invented cause (spec 8e137fdb AC-9).
    if (t.status === 'pending' && t.holdReason && orphaned(t)) {
      return link(`${name(t)} is waiting.`, 'gate_events.reason', { ...base, taskId: t.id });
    }
    return link(
      orphaned(t)
        ? t.status === 'pending'
          ? `${name(t)} is next in line for a runner.`
          : `${name(t)} was started, but nothing is running it now.`
        : t.live
          ? `${name(t)} is in progress${w.local ? ' in your session' : ''}.`
          : `${name(t)} is not finished yet.`,
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
    case 'dependency': {
      const upstream = extra.dependencyTitle ? `Upstream mission "${extra.dependencyTitle}"` : 'The upstream mission';
      const g = extra.dependencyGate ?? null;
      if (!g) {
        return [link(`${upstream} has not met this mission's gate condition.`, 'missions.dependsOnMissionId', { ...base, missionId: w.missionId })];
      }
      const gateName = g.gate === 'completed' ? 'completed' : 'merged';
      if (g.met) {
        return [link(
          `${upstream} has met this mission's "${gateName}" gate. The block clears the next time this mission is checked.`,
          'missions.dependsOnMissionId + evaluateUpstreamGate',
          { ...base, missionId: w.missionId },
        )];
      }
      return [
        link(`${upstream} has not met this mission's "${gateName}" gate.`, 'missions.dependsOnMissionId', { ...base, missionId: w.missionId }),
        ...g.unmet.slice(0, 10).map(u => link(
          `Still needed: ${describeUnmetCondition(u)}.`,
          'evaluateUpstreamGate',
          {
            ...base,
            missionId: w.missionId,
            ...('taskId' in u && u.taskId ? { taskId: u.taskId } : {}),
            ...('prNumber' in u && u.prNumber ? { prNumber: u.prNumber } : {}),
          },
        )),
      ];
    }

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
            ? `${taskBut(p)} its PR closed without merging, and nothing recorded that the `
              + 'work shipped elsewhere. If it did, record it with record_pr_supersession.'
            : `${taskBut(p)} its PR has not merged.`,
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
            `${taskBut(p)} its PR's CI is still red after ${w.attempts} fix attempt${w.attempts === 1 ? '' : 's'}`
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

    case 'landing_blocked':
      return (extra.unmergedPrs ?? [])
        .filter(p => w.taskIds.includes(p.taskId))
        .slice(0, 10)
        .map(p =>
          link(
            `${taskBut(p)} its PR cannot land yet: ${w.label}. `
              + `${w.owner === 'person' ? 'This needs a person' : 'buildd owns the next step'}: ${w.nextAction}`,
            'deriveLandingBlocker',
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
            p.refreshCheck
              ? closedRefreshClaim(p.title, p.refreshCheck)
              : p.suggestion && suggestionEvidence(p.suggestion) === 'unavailable'
              ? `${taskBut(p)} its PR closed without merging. ${suggestionRef(p.suggestion, repoOf(p.prUrl))} `
                + `was nominated as a possible replacement (${p.suggestion.why}); its changes could not be read, so it is neither confirmed nor ruled out `
                + 'and nothing was recorded. It is checked again on a later sweep.'
              : p.suggestion && suggestionEvidence(p.suggestion) === 'positive'
              ? `${taskBut(p)} its PR closed without merging. It is likely superseded by `
                + `${suggestionRef(p.suggestion, repoOf(p.prUrl))} (${p.suggestion.why}), but the content did not verify, `
                + 'so nothing was recorded. Confirm it, or mark the PR abandoned with a reason.'
              : p.suggestion
                ? `${taskBut(p)} its PR closed without merging. ${suggestionRef(p.suggestion, repoOf(p.prUrl))} `
                  + `was checked as a possible replacement (${p.suggestion.why}) and does not carry its changes — nothing was recorded. `
                  + 'Mark the PR abandoned with a reason, or record where it shipped with record_pr_supersession if you know.'
                : `${taskBut(p)} its PR closed without merging, and nothing recorded that the `
                  + 'work shipped elsewhere. If it did, record it with record_pr_supersession; if it is not shipping, mark it abandoned.',
            p.suggestion || p.refreshCheck
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
      if (w.question) {
        return w.question.asks.slice(0, 10).map(a =>
          link(
            a.prompt ? `"${a.title ?? a.taskId}" asks: ${a.prompt}` : `"${a.title ?? a.taskId}" is waiting for your answer.`,
            'workers.waitingFor',
            { ...base, taskId: a.taskId },
          ),
        );
      }
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
 * 58c8961e: why the delivery's latest review round started, whether it is a
 * delta review that carries an approval (or, after one, why it is full), and
 * how it ended if a push superseded it. Null for a round recorded before
 * rounds carried a trigger.
 */
export function reviewRoundLink(
  d: { prNumber: number | null; rounds: DeliveryRound[] } | null | undefined,
  subject: BecauseSubjectRefs,
): Link | null {
  const r = d?.rounds?.length ? [...d.rounds].sort((a, b) => b.round - a.round)[0] : null;
  const claim = r ? roundTriggerSentence(r) : null;
  if (!claim) return null;
  const refs: ExplainRefs = {
    ...(subject.taskId ? { taskId: subject.taskId } : {}),
    ...(subject.workspaceId ? { workspaceId: subject.workspaceId } : {}),
    ...(d!.prNumber != null ? { prNumber: d!.prNumber } : {}),
  };
  return link(claim, 'DeliveryView.rounds', refs);
}

const ROW_WORDS: Record<DeliveryDisagreement['worker'], string> = { merged: 'merged', open: 'still open', closed: 'closed' };

/** Where the PR stands, in words a person reads (never the state's name). */
const PR_STATE_WORDS: Record<DeliveryDisagreement['delivery'], string> = {
  WORKING: 'still being built',
  AWAITING_PUSH: 'waiting for a push to reach GitHub',
  AWAITING_REVIEW: 'in review',
  CHANGES_REQUESTED: 'waiting on requested changes',
  FIXING: 'being fixed after review',
  REPAIRING: 'being repaired',
  BLOCKED_ON_TRUNK: 'blocked by a red base branch',
  APPROVED: 'approved and not yet merged',
  LANDING: 'merging',
  ESCALATED: 'waiting on a person',
  MERGED: 'merged',
  CLOSED_UNMERGED: 'closed without merging',
  SUPERSEDED: 'shipped in another PR',
  ABANDONED: 'abandoned',
  FAILED: 'stopped after its attempts failed',
};

/**
 * workflow-kernel-library.md §7 / AC-26: a worker row whose merge columns say
 * something other than the PR's review state (its delivery). The answer
 * follows the review state; the row is named so the disagreement is visible.
 */
export function deliveryDisagreementLink(d: DeliveryDisagreement, subject: BecauseSubjectRefs): Link {
  const refs: ExplainRefs = {
    taskId: d.taskId,
    ...(subject.missionId ? { missionId: subject.missionId } : {}),
    ...(subject.workspaceId ? { workspaceId: subject.workspaceId } : {}),
    prNumber: d.prNumber,
  };
  return link(
    `PR #${d.prNumber} is ${PR_STATE_WORDS[d.delivery]} (${d.headline}), but the worker's own record says ${ROW_WORDS[d.worker]}. This answer follows the PR's review state.`,
    'DeliveryView.state vs workers.mergedAt', refs);
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

/**
 * failure-incident-recovery §18.5/§18.6: why a cancelled task was cancelled
 * (or what superseded it), and what a task held for its credential waits on.
 * The one sentence the task page shows too.
 */
export function taskRecoveryLink(status: string, context: unknown, subject: BecauseSubjectRefs): Link | null {
  const refs: ExplainRefs = {
    ...(subject.taskId ? { taskId: subject.taskId } : {}),
    ...(subject.workspaceId ? { workspaceId: subject.workspaceId } : {}),
  };
  if (status === 'cancelled') {
    const line = cancellationLine(context);
    return line ? link(line, 'tasks.context.cancellation', refs) : null;
  }
  if (status === 'pending') {
    const line = taskRecoverySentence(context, iso => `${iso.slice(11, 16)} UTC`);
    return line ? link(line, 'tasks.context.credentialHold', refs) : null;
  }
  return null;
}

/**
 * A live-status worker whose own runner has gone quiet (lib/runner-offline.ts):
 * the task is not RUNNING, it is waiting for that runner to be confirmed dead,
 * after which the offline-runner reaper requeues it for another runner.
 */
export function offlineRunnerLink(liveness: RunnerLiveness, subject: BecauseSubjectRefs, workerId: string | null): Link {
  const refs: ExplainRefs = {
    ...(subject.taskId ? { taskId: subject.taskId } : {}),
    ...(subject.workspaceId ? { workspaceId: subject.workspaceId } : {}),
    ...(workerId ? { workerId } : {}),
  };
  const line = offlineRunnerWaitLine(liveness);
  return link(`${line.charAt(0).toUpperCase()}${line.slice(1)}.`, 'workers.runner + workerHeartbeats.lastHeartbeatAt', refs);
}

/** Insert the wake link before the chain's closing conclusion, renumbered. */
export function withDispatchLink(chain: CausalLink[], wake: Link | null): CausalLink[] {
  if (!wake) return chain;
  const links: Link[] = chain.map(({ order: _order, ...l }) => l);
  links.splice(Math.max(0, links.length - 1), 0, wake);
  return orderChain(links);
}

/** The cause sentence for a closed integration-refresh PR, by its own proof (`SupersessionScan.refreshCheck`). */
/** How an unmerged PR's claim opens: a failed owner task whose delivery is still live is not "completed" (fe45dc7d). */
function taskBut(p: { title: string; taskFailed?: boolean }): string {
  return p.taskFailed ? `Task "${p.title}" failed, but` : `Task "${p.title}" is completed but`;
}

function closedRefreshClaim(title: string, r: RefreshCheck): string {
  const branch = r.branch ? `\`${r.branch}\`` : 'its integration branch';
  const head = `Task "${title}" is completed but its refresh PR closed without merging.`;
  if (r.outcome === 'landed') return `${head} Its work is verified in ${branch} (${r.reason}), so nothing is lost; mark it abandoned with that reason.`;
  if (r.outcome === 'unique_work') return `${head} ${branch} is missing work it carries (${r.reason}). Land that work on the branch before marking it abandoned.`;
  return `${head} Whether its work is in ${branch} could not be checked (${r.reason}); nothing was recorded.`;
}
