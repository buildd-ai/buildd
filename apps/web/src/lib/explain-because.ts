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
  /** Open deliverable rows, for naming which tasks are holding. */
  openTasks?: Array<{ id: string; title: string | null; status: string }>;
  /** Failed rows with the signature their failure was bucketed under. */
  failedTasks?: Array<{ id: string; title: string | null; errorSignature?: string | null }>;
  /** Unmerged PRs holding completion. */
  unmergedPrs?: Array<{ taskId: string; title: string; prNumber: number | null; prUrl: string | null }>;
  /** Upstream mission title, when it was loaded. */
  dependencyTitle?: string | null;
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

  if (w) {
    links.push(...causeLinksFor(w, base, extra));
  }

  links.push(
    link(
      w
        ? `State is ${view.kind} because ${w.label}.`
        : `State is ${view.kind}: no source reports anything outstanding.`,
      view.derivedFrom.kind,
      base,
    ),
  );

  return orderChain(links);
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
      return (extra.openTasks ?? []).slice(0, 10).map(t =>
        link(
          `Task "${t.title ?? t.id}" is ${t.status} with no live worker.`,
          'tasks.status + workers.status',
          { ...base, taskId: t.id },
        ),
      );

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
          `Task "${p.title}" is completed but its PR has not merged.`,
          'workers.mergedAt',
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
            ? `Every open task is on a known self-resolving wait (${w.reason}); it resumes at ${w.waitUntil}.`
            : `Every open task is on a known self-resolving wait (${w.reason}).`,
          'classifyMissionWait',
          base,
        ),
      ];
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
        `No stored touch set for those merges overlaps PR #${subject.prNumber}'s — the conflict is in files neither side declared.`,
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
