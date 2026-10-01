/**
 * The PR landing function — one decide-and-act answer to "what happens to this
 * PR now?", for every door that can land one (docs/design/pr-landing-guarantee.md).
 *
 * It composes the existing pieces instead of restating them: the safety rails
 * (`evaluateAutoMergeSafety`), the verdict gate with carry-forward
 * (`guardReviewVerdict`), the stored-approval confidence rule
 * (`isApprovalSelfMergeable`) and the behind-base / conflict dispatcher
 * (`dispatchConflictRetry`). What it adds is the part none of them owns:
 *
 *  - every outcome is one of five typed results with a named owner, never a
 *    silent refusal;
 *  - "behind base" is work — one refresh, recorded in a marker keyed to the head
 *    the refresh produced — bounded by the treadmill rule so a busy base cannot
 *    starve a green, approved PR forever;
 *  - every non-merged outcome writes exactly one `pr_landing` gate event.
 *
 * `mode` is the rollout flag (`gitConfig.landing.mode`): `enforce` acts;
 * `shadow` computes the same outcome and records it (outcome `warned`) while
 * taking no action, so the legacy door keeps deciding; `off` computes and
 * records nothing. Shadow and off never merge, push, file a task, write the
 * marker, record a carried approval or page; and landPr never throws, so a
 * shadow call cannot disturb the door that made it.
 *
 * No `db.transaction()` (neon-http): the marker write is one atomic UPDATE with a
 * compare-and-set on its refresh counter.
 */

import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { OPEN_TASK_STATUSES, type MergePolicy } from '@buildd/shared';
import type { GateCallerOrigin, GateOutcome } from '@buildd/core/gate-events';
import type { MissionIntegrationFields } from '@buildd/core/mission-integration';
import type { WorkspaceReleaseConfig } from '@buildd/core/db/schema';
import { githubApi, mergePullRequest } from '@/lib/github';
import {
  evaluateAutoMergeSafety,
  classifyAutoMergeRefusal,
  loadMissionIntegrationFields,
  escalateConflictExhaustion,
} from '@/lib/auto-merge';
import type { ModelApproveBound, CheckRunState } from '@/lib/auto-merge-bound';
import { guardReviewVerdict } from '@/lib/review-verdict-gate';
import { carryForwardApprovalIfUnchanged } from '@/lib/approval-carry-forward';
import { readPrReviewStatus } from '@/lib/pr-review-request';
import { isApprovalSelfMergeable, type PrReviewStatus } from '@/lib/pr-review-status';
import {
  classifyMergeFailure,
  dispatchConflictRetry,
  type DispatchConflictRetryResult,
} from '@/lib/conflict-retry';
import { guardMissionPrMerge, finalizeMissionPrMerge } from '@/lib/mission-pr';
import { isGeneratedMigrationPath } from '@/lib/migration-safety';
import { fireGateEvent, GATE_SLUGS } from '@/lib/gate-ledger';
import type { LandingAlertInput } from '@/lib/pr-landing-alert';
import {
  readLandingMarker,
  writeLandingMarker,
  clearLandingMarker,
  type LandingMarker,
} from '@/lib/pr-landing-marker';

// ── Types ──────────────────────────────────────────────────────────────────────

export type LandingMode = 'off' | 'shadow' | 'enforce';

/** Which door asked. Recorded on the ledger row; it never changes the decision. */
export type LandingDoor =
  | 'check_suite'
  | 'approve'
  | 'merge_pr'
  | 'dashboard'
  | 'sweep'
  | 'status'
  | (string & {});

export type LandingActor =
  | { kind: 'system' }
  | { kind: 'agent'; workerId?: string | null }
  | {
      kind: 'human';
      userId?: string | null;
      /** What this person is explicitly overriding. Red CI and deny paths are never overridable. */
      override?: { verdict?: boolean; size?: boolean; freshness?: boolean };
    };

export type FixKind = 'ci_fix' | 're_review' | 'conflict' | 'renumber_migration';

export type HumanCause =
  | 'human_tier'
  | 'blocking_verdict'
  | 'low_confidence'
  | 'review_failed'
  | 'deny_path'
  | 'size_cap'
  | 'branch_protection'
  | 'migration'
  | 'unsafe_other'
  | 'refresh_exhausted'
  | 'fix_exhausted'
  | 'superseded'
  | 'dependency_bot'
  | 'base_rewritten'
  | 'auto_resolve_disabled'
  | 'no_owner'
  | 'merge_failed'
  | 'pr_closed'
  | 'github_unreadable'
  /** The landing function itself threw. Nothing was decided past that point; see the ledger row's reason. */
  | 'landing_error';

export type LandingOutcome =
  | { kind: 'merged'; sha: string }
  | { kind: 'updating_branch'; newHeadSha: string }
  | { kind: 'waiting_ci'; headSha: string }
  | { kind: 'needs_fix'; reason: string; fix: FixKind; taskId?: string }
  | { kind: 'needs_human'; reason: string; cause: HumanCause };

export type OutcomeOwner =
  | { kind: 'marker'; headSha: string }
  | { kind: 'checks'; headSha: string }
  | { kind: 'task'; taskId: string }
  | { kind: 'unassigned_fix'; fix: FixKind }
  | { kind: 'human'; cause: HumanCause };

export interface LandPrInput {
  workspaceId: string;
  installationId: number;
  repoFullName: string;
  prNumber: number;
  /** The head SHA the triggering event was about; null for doors with no event (dashboard, sweep). */
  eventHeadSha: string | null;
  door: LandingDoor;
  actor: LandingActor;
  mode: LandingMode;
  policy: MergePolicy;
  /** The PR's owning task/worker: where the refresh marker lives and who a refresh is filed under. */
  owner: { taskId: string | null; workerId: string | null };
  /** Set only when a model verdict is what authorises this landing (the reviewer approve door). */
  bound?: ModelApproveBound;
  mission?: MissionIntegrationFields | null;
  releaseConfig?: WorkspaceReleaseConfig | null;
  /** How GitHub combines the PR. Default squash; `merge_pr` lets the caller choose. */
  mergeMethod?: 'merge' | 'squash' | 'rebase';
}

export interface FixDispatchInput {
  kind: Exclude<FixKind, 'conflict'>;
  workspaceId: string;
  installationId: number;
  repoFullName: string;
  prNumber: number;
  headSha: string;
  owner: { taskId: string | null; workerId: string | null };
  reason: string;
}

export interface LandPrDeps {
  /**
   * Files the one fix task for a non-conflict fix (CI red, stale approval,
   * migration renumber). The logic that does this today lives inline in the
   * doors; until one of them hands it over, an unwired dispatcher yields a
   * `needs_fix` with no `taskId` and a ledger row saying so.
   */
  dispatchFix?: (input: FixDispatchInput) => Promise<{ taskId?: string } | null>;
  escalateConflictExhaustion?: (taskId: string, repoFullName: string, prNumber: number, headSha: string) => Promise<void>;
  /** The live reviewer-retry (author fixing a finding) task for this PR, if any. */
  findLiveReviewerRetry?: (workspaceId: string, prNumber: number) => Promise<string | null>;
  now?: () => number;
  /** Raises the one-per-key page for an outcome that needs a person (enforce only). Defaults to the DB-bound alert. */
  alert?: (input: LandingAlertInput) => Promise<void>;
}

// ── Constants and pure pieces ──────────────────────────────────────────────────

/** A head a refresh produced lands if the base gained at most this many commits since. */
export const TREADMILL_MAX_BASE_COMMITS = 3;
/** Refreshes per landing cycle before a person is asked. */
export const TREADMILL_MAX_REFRESHES = 3;

const LOCKFILE = /(^|\/)(bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$|\.lock$/;
const SCHEMA_FILE = 'packages/core/db/schema.ts';

const isRiskyPath = (path: string) => isGeneratedMigrationPath(path) || path === SCHEMA_FILE || LOCKFILE.test(path);

export type TreadmillVerdict = { accepted: true } | { accepted: false; reason: string };

/**
 * May the landing proceed on a head that is a little behind base, rather than
 * refreshing it again? Only a head our own refresh produced qualifies, only
 * while the base has barely moved, only if the moved files are disjoint from the
 * PR's, and never when either side touches migrations, schema or lockfiles —
 * those are where "unrelated" is not a safe assumption. Unknown file lists
 * refuse: a green measured against a base we cannot describe proves nothing.
 */
export function evaluateTreadmillBound(input: {
  marker: LandingMarker | null;
  liveHeadSha: string;
  baseCommitsSince: number;
  baseFiles: string[] | null;
  prFiles: string[] | null;
}): TreadmillVerdict {
  const { marker, liveHeadSha, baseCommitsSince, baseFiles, prFiles } = input;
  if (!marker || marker.pendingHeadSha !== liveHeadSha) {
    return { accepted: false, reason: 'this head was not produced by a platform refresh' };
  }
  if (baseCommitsSince > TREADMILL_MAX_BASE_COMMITS) {
    return { accepted: false, reason: `the base gained ${baseCommitsSince} commits since the last refresh (limit ${TREADMILL_MAX_BASE_COMMITS})` };
  }
  if (!baseFiles || !prFiles) {
    return { accepted: false, reason: 'could not list the files on one side of the gap' };
  }
  const risky = [...baseFiles, ...prFiles].find(isRiskyPath);
  if (risky) return { accepted: false, reason: `the gap involves a migration, schema or lockfile (${risky})` };
  const mine = new Set(prFiles);
  const overlap = baseFiles.find((f) => mine.has(f));
  if (overlap) return { accepted: false, reason: `the base changed a file this PR changes (${overlap})` };
  return { accepted: true };
}

/** The rollout mode for a workspace. Shadow is the default: observe before acting. */
export function resolveLandingMode(gitConfig: { landing?: { mode?: unknown } } | null | undefined): LandingMode {
  const mode = gitConfig?.landing?.mode;
  return mode === 'off' || mode === 'shadow' || mode === 'enforce' ? mode : 'shadow';
}

/** Who is responsible for moving this outcome forward; null once merged. */
export function outcomeOwner(outcome: LandingOutcome): OutcomeOwner | null {
  switch (outcome.kind) {
    case 'merged':
      return null;
    case 'updating_branch':
      return { kind: 'marker', headSha: outcome.newHeadSha };
    case 'waiting_ci':
      return { kind: 'checks', headSha: outcome.headSha };
    case 'needs_fix':
      return outcome.taskId ? { kind: 'task', taskId: outcome.taskId } : { kind: 'unassigned_fix', fix: outcome.fix };
    case 'needs_human':
      return { kind: 'human', cause: outcome.cause };
  }
}

function gateOutcomeFor(outcome: LandingOutcome): GateOutcome {
  if (outcome.kind === 'merged') return 'accepted';
  if (outcome.kind === 'needs_human') return outcome.cause === 'human_tier' ? 'deferred' : 'stranded';
  return 'deferred';
}

function callerOriginFor(actor: LandingActor): GateCallerOrigin {
  return actor.kind === 'human' ? 'dashboard' : actor.kind === 'agent' ? 'worker' : 'system';
}

const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ── GitHub reads ───────────────────────────────────────────────────────────────

interface LivePr {
  state: string;
  merged: boolean;
  mergeCommitSha: string | null;
  mergeableState: string | null;
  headSha: string | null;
  baseRef: string | null;
  title: string | null;
}

async function readLivePr(installationId: number, repoFullName: string, prNumber: number): Promise<LivePr> {
  const pr = await githubApi(installationId, `/repos/${repoFullName}/pulls/${prNumber}`);
  return {
    state: pr?.state ?? 'unknown',
    merged: pr?.merged === true,
    mergeCommitSha: pr?.merge_commit_sha ?? null,
    mergeableState: pr?.mergeable_state ?? null,
    headSha: pr?.head?.sha ?? null,
    baseRef: pr?.base?.ref ?? null,
    title: typeof pr?.title === 'string' ? pr.title : null,
  };
}

/** Files in a compare/PR-files listing, or null when it may be truncated or malformed. */
const COMPARE_FILE_CAP = 300;
function filenames(list: unknown): string[] | null {
  if (!Array.isArray(list) || list.length >= COMPARE_FILE_CAP) return null;
  const names = list.map((f) => (f && typeof (f as { filename?: unknown }).filename === 'string' ? (f as { filename: string }).filename : null));
  return names.some((n) => n === null) ? null : (names as string[]);
}

async function findLiveReviewerRetryTask(workspaceId: string, prNumber: number): Promise<string | null> {
  const row = await db.query.tasks.findFirst({
    where: and(
      eq(tasks.workspaceId, workspaceId),
      eq(tasks.reviewerRetryPrNumber, prNumber),
      inArray(tasks.status, [...OPEN_TASK_STATUSES]),
    ),
    columns: { id: true },
  });
  return row?.id ?? null;
}

/**
 * The carry-forward check without its write: same equivalence answer, but the
 * new head is not recorded on the review task. Shadow uses this so observing a
 * landing never changes the review state the legacy door reads.
 */
const dryRunCarryForward: typeof carryForwardApprovalIfUnchanged = (p) =>
  carryForwardApprovalIfUnchanged({ ...p, deps: { ...p.deps, record: async () => {} } });

/** A ledger write must never be what fails a landing (or the door that asked). */
function safeFireGateEvent(input: Parameters<typeof fireGateEvent>[0]): void {
  try {
    fireGateEvent(input);
  } catch (err) {
    console.warn('[pr-landing] gate event write failed:', errMessage(err));
  }
}

// ── landPr ─────────────────────────────────────────────────────────────────────

/**
 * Never throws. An unexpected error resolves to `needs_human` (`landing_error`)
 * with one ledger row: in shadow that leaves the legacy door entirely in charge,
 * and in enforce it parks the PR rather than merging on a half-made decision.
 */
export async function landPr(input: LandPrInput, deps: LandPrDeps = {}): Promise<LandingOutcome> {
  const trace: LandingTrace = { headSha: null, title: null };
  try {
    const outcome = await decideAndLand(input, deps, trace);
    await raiseAlert(input, outcome, trace, deps);
    return outcome;
  } catch (err) {
    const reason = `the landing function failed: ${errMessage(err)}`;
    console.warn(`[pr-landing] ${input.repoFullName}#${input.prNumber}:`, reason);
    const outcome: LandingOutcome = { kind: 'needs_human', cause: 'landing_error', reason };
    if (input.mode !== 'off') {
      const act = input.mode === 'enforce';
      safeFireGateEvent({
        gate: GATE_SLUGS.PR_LANDING,
        surface: 'pr-landing',
        outcome: act ? gateOutcomeFor(outcome) : 'warned',
        reason,
        workspaceId: input.workspaceId,
        taskId: input.owner.taskId,
        workerId: input.owner.workerId,
        callerOrigin: callerOriginFor(input.actor),
        detail: {
          prNumber: input.prNumber,
          headSha: input.eventHeadSha,
          repoFullName: input.repoFullName,
          door: input.door,
          mode: input.mode,
          tier: input.policy.tier,
          owner: outcomeOwner(outcome),
          cause: 'landing_error',
          [act ? 'landingOutcome' : 'shadowOutcome']: outcome.kind,
        },
      });
    }
    return outcome;
  }
}

/** What the decision saw that the alert needs and the outcome does not carry. */
interface LandingTrace {
  headSha: string | null;
  title: string | null;
}

/** Enforce only, never throws: a page is a side effect of a landing, not part of it. */
async function raiseAlert(input: LandPrInput, outcome: LandingOutcome, trace: LandingTrace, deps: LandPrDeps): Promise<void> {
  if (input.mode !== 'enforce') return;
  try {
    const raisePage = deps.alert ?? (await import('@/lib/pr-landing-alert-deps')).raiseLandingAlert;
    await raisePage({
      workspaceId: input.workspaceId,
      prNumber: input.prNumber,
      headSha: trace.headSha ?? input.eventHeadSha ?? '',
      repoFullName: input.repoFullName,
      prTitle: trace.title,
      taskId: input.owner.taskId,
      outcome,
    });
  } catch (err) {
    console.warn(`[pr-landing] alert failed for PR #${input.prNumber}:`, errMessage(err));
  }
}

async function decideAndLand(input: LandPrInput, deps: LandPrDeps, trace: LandingTrace): Promise<LandingOutcome> {
  const { workspaceId, installationId, repoFullName, prNumber, owner, actor, policy } = input;
  const act = input.mode === 'enforce';
  const now = deps.now ?? Date.now;
  const escalate = deps.escalateConflictExhaustion ?? escalateConflictExhaustion;
  const findLiveRetry = deps.findLiveReviewerRetry ?? findLiveReviewerRetryTask;
  const callerOrigin = callerOriginFor(actor);
  const override = actor.kind === 'human' ? (actor.override ?? {}) : {};
  const ghPath = `/repos/${repoFullName}`;

  let headSha: string | null = input.eventHeadSha;
  let baseRef: string | null = null;
  let marker: LandingMarker | null = null;

  const done = (outcome: LandingOutcome, reason: string, extra: Record<string, unknown> = {}): LandingOutcome => {
    if (input.mode === 'off') return outcome;
    const detail: Record<string, unknown> = {
      prNumber,
      headSha,
      repoFullName,
      door: input.door,
      mode: input.mode,
      tier: policy.tier,
      owner: outcomeOwner(outcome),
      ...extra,
    };
    if (act) detail.landingOutcome = outcome.kind;
    else detail.shadowOutcome = outcome.kind;
    safeFireGateEvent({
      gate: GATE_SLUGS.PR_LANDING,
      surface: 'pr-landing',
      outcome: act ? gateOutcomeFor(outcome) : 'warned',
      reason,
      workspaceId,
      taskId: owner.taskId,
      workerId: owner.workerId,
      callerOrigin,
      detail,
    });
    return outcome;
  };

  const human = (cause: HumanCause, reason: string, extra?: Record<string, unknown>) =>
    done({ kind: 'needs_human', cause, reason }, reason, { cause, ...extra });
  const waiting = (reason: string, extra?: Record<string, unknown>) =>
    done({ kind: 'waiting_ci', headSha: headSha ?? '' }, reason, extra);

  const bypass = (gate: string, reason: string, detail: Record<string, unknown>) => {
    if (!act) return;
    safeFireGateEvent({
      gate,
      surface: 'pr-landing',
      outcome: 'bypassed',
      reason,
      workspaceId,
      taskId: owner.taskId,
      workerId: owner.workerId,
      callerOrigin,
      detail: { prNumber, headSha, repoFullName, ...detail },
    });
  };

  const needsFix = async (fix: Exclude<FixKind, 'conflict'>, reason: string): Promise<LandingOutcome> => {
    let taskId: string | undefined;
    let dispatched = false;
    if (act && deps.dispatchFix) {
      try {
        const res = await deps.dispatchFix({
          kind: fix, workspaceId, installationId, repoFullName, prNumber, headSha: headSha ?? '', owner, reason,
        });
        taskId = res?.taskId;
        dispatched = !!res;
      } catch (err) {
        return human('merge_failed', `could not file the ${fix} fix: ${errMessage(err)}`);
      }
    }
    return done({ kind: 'needs_fix', fix, reason, ...(taskId ? { taskId } : {}) }, reason, { fix, fixDispatched: dispatched });
  };

  const readMarker = async () => {
    if (!owner.taskId) return null;
    return readLandingMarker(owner.taskId, prNumber).catch(() => null);
  };

  let reviewStatusPromise: Promise<PrReviewStatus | null> | null = null;
  const reviewStatus = () =>
    (reviewStatusPromise ??= readPrReviewStatus({ workspaceId, prNumber }).catch(() => null));

  // ── 1. The live PR ──────────────────────────────────────────────────────────
  let pr: LivePr;
  try {
    pr = await readLivePr(installationId, repoFullName, prNumber);
  } catch (err) {
    return human('github_unreadable', `could not read the PR from GitHub: ${errMessage(err)}`);
  }
  if (pr.merged) return { kind: 'merged', sha: pr.mergeCommitSha ?? pr.headSha ?? '' };
  if (!pr.headSha) return human('github_unreadable', 'GitHub returned no head commit for this PR');
  const liveHead = pr.headSha;
  headSha = liveHead;
  trace.headSha = liveHead;
  trace.title = pr.title;
  baseRef = pr.baseRef;
  if (pr.state !== 'open') return human('pr_closed', `the PR is ${pr.state} and was not merged`);

  marker = await readMarker();

  // An event about a head that is no longer live is not a reason to act: the
  // live head has its own event coming (or its own marker).
  if (input.eventHeadSha && input.eventHeadSha !== liveHead) {
    return marker?.pendingHeadSha === liveHead
      ? { kind: 'updating_branch', newHeadSha: liveHead }
      : { kind: 'waiting_ci', headSha: liveHead };
  }

  // ── 2. Tier: a person is the gate on the human tier ─────────────────────────
  if (policy.tier === 'human' && actor.kind !== 'human') {
    return human('human_tier', 'this workspace merges by human decision; the PR is waiting in the review queue');
  }

  // ── 3. Safety rails (every one except base freshness, which is work below) ──
  const mission = input.mission !== undefined ? input.mission : await loadMissionIntegrationFields(owner.taskId);
  const effectivePolicy: MergePolicy = override.size
    ? { ...policy, threshold: { ...policy.threshold, maxLines: Number.MAX_SAFE_INTEGER } as MergePolicy['threshold'] }
    : policy;
  const observed: { baseRef?: string | null; mergeableState?: string | null; checkRuns?: CheckRunState[] } = {};
  const runSafety = (bound: ModelApproveBound | undefined) =>
    evaluateAutoMergeSafety(installationId, repoFullName, prNumber, liveHead, effectivePolicy, {
      mission,
      bound,
      releaseConfig: input.releaseConfig ?? null,
      workspaceId,
      taskId: owner.taskId,
      workerId: owner.workerId,
      skipBaseFreshness: true,
      observed,
    });

  let safety = await runSafety(input.bound);
  if (!safety.ok && input.bound && classifyAutoMergeRefusal(safety.reason) === 'model_bound') {
    // The bound is an extra rail on a model-driven merge. A stored approval that
    // already clears the confidence bar may still land under the unbounded rule.
    const status = await reviewStatus();
    if (status && isApprovalSelfMergeable(status, policy.agentReview?.maxConfidenceThreshold)) {
      safety = await runSafety(undefined);
    }
  }
  if (baseRef === null) baseRef = observed.baseRef ?? null;

  if (!safety.ok) {
    const reason = safety.reason;
    switch (classifyAutoMergeRefusal(reason)) {
      case 'ci': {
        const red = (observed.checkRuns ?? []).some((r) => r.conclusion === 'failure');
        return red ? needsFix('ci_fix', reason) : waiting(reason);
      }
      case 'stale_head':
      case 'github_read':
        return waiting(reason);
      case 'deny_path':
        return human('deny_path', reason);
      case 'migration':
        if (/^migration number collision:/.test(reason)) return needsFix('renumber_migration', reason);
        return /^could not /.test(reason) ? waiting(reason) : human('migration', reason);
      case 'size':
        return human('size_cap', reason);
      case 'conflict':
        return conflictOutcome(reason);
      case 'blocked':
        return human('branch_protection', reason);
      default:
        return human('unsafe_other', reason);
    }
  }

  // ── 4. Review verdict — always with the carry-forward hint ──────────────────
  const gate = await guardReviewVerdict({
    workspaceId,
    prNumber,
    headSha: liveHead,
    surface: 'pr-landing',
    taskId: owner.taskId,
    workerId: owner.workerId,
    callerOrigin,
    carryForward: baseRef ? { installationId, repoFullName, baseRef } : null,
    // Shadow answers the same question but must not record the carried head.
    ...(act ? {} : { deps: { carryForward: dryRunCarryForward } }),
  });
  if (gate.blocks) {
    const reason = gate.reason ?? 'the review verdict blocks this landing';
    if (override.verdict) {
      bypass(GATE_SLUGS.REVIEW_VERDICT, reason, { reviewKind: gate.kind ?? null, reviewState: gate.state ?? null });
    } else {
      const extra = { reviewKind: gate.kind ?? null, reviewState: gate.state ?? null, reviewTaskId: gate.reviewTaskId ?? null, clearedBy: gate.clearedBy ?? null };
      if (gate.kind === 'in_flight') return waiting(reason, extra);
      if (gate.kind === 'stale_approval') return needsFix('re_review', reason);
      const live = await findLiveRetry(workspaceId, prNumber).catch(() => null);
      if (live) {
        return done({ kind: 'needs_fix', fix: 're_review', reason, taskId: live }, reason, { ...extra, fix: 're_review', fixDispatched: false });
      }
      return human('blocking_verdict', reason, extra);
    }
  }

  // ── 5. Agent-review tier: a stored approve above the confidence bar ─────────
  if (policy.tier === 'agent-review' && actor.kind !== 'human') {
    const status = await reviewStatus();
    if (!status) return waiting('could not read the stored review verdict');
    if (!isApprovalSelfMergeable(status, policy.agentReview?.maxConfidenceThreshold)) {
      if (status.verdict === 'approve' && !status.merged) {
        return human('low_confidence', `the reviewer approved with confidence ${status.confidence ?? 'unknown'}, below the bar for unattended landing`);
      }
      if (status.state === 'review_failed') {
        return human('review_failed', 'the review produced no verdict');
      }
      return needsFix('re_review', 'no approved review is on file for this head');
    }
  }

  // ── 6. Behind base is work with an owner ────────────────────────────────────
  if (baseRef) {
    let behindBy: number | null = null;
    let compareError: unknown = null;
    try {
      const cmp = await githubApi(installationId, `${ghPath}/compare/${encodeURIComponent(baseRef)}...${liveHead}`);
      behindBy = typeof cmp?.behind_by === 'number' ? cmp.behind_by : 0;
    } catch (err) {
      compareError = err;
    }
    if (compareError && !override.freshness) {
      return waiting(`could not verify base freshness — GitHub compare lookup failed: ${errMessage(compareError)}`);
    }
    const behind = (behindBy ?? 0) > 0 || (observed.mergeableState ?? pr.mergeableState) === 'behind';
    if (behind) {
      const gap = `PR is ${behindBy ? `${behindBy} commit${behindBy === 1 ? '' : 's'}` : 'behind'} behind ${baseRef}`;
      if (override.freshness) {
        bypass(GATE_SLUGS.MERGE_BASE_FRESHNESS, `${gap}; a person merged it anyway`, { baseRef, behindBy });
      } else {
        const tolerated = await treadmillAccepts(baseRef);
        if (!tolerated.accepted) return refresh(tolerated.reason, baseRef);
      }
    }
  }

  // ── 7. Mission PR lifecycle, then the merge ─────────────────────────────────
  let mergingTask: { id: string; title: string; taskClass: string | null; missionId: string | null } | null = null;
  if (owner.taskId) {
    try {
      mergingTask =
        (await db.query.tasks.findFirst({
          where: eq(tasks.id, owner.taskId),
          columns: { id: true, title: true, taskClass: true, missionId: true },
        })) ?? null;
    } catch (err) {
      console.warn(`[pr-landing] could not read task ${owner.taskId}:`, errMessage(err));
    }
  }
  const missionGate = await guardMissionPrMerge(mergingTask);
  if (missionGate.blocks) {
    return waiting(missionGate.reason ?? 'mission work is not finished', { waitingOn: 'mission_siblings' });
  }

  if (!act) return done({ kind: 'merged', sha: liveHead }, 'every rail passed; this PR would merge now');

  const result = await mergePullRequest(installationId, repoFullName, prNumber, input.mergeMethod ?? 'squash', liveHead);
  if (result.merged) return landed(liveHead, mergingTask);

  const message = result.message || 'the merge call failed';
  if (result.indeterminate) {
    const after = await readLivePr(installationId, repoFullName, prNumber).catch(() => null);
    if (after?.merged) return landed(after.mergeCommitSha ?? liveHead, mergingTask);
    return waiting(message);
  }
  if (/base branch was modified/i.test(message)) return refresh(message, baseRef ?? '');
  if (/head branch was modified/i.test(message)) return waiting(message);
  if (classifyMergeFailure(message) === 'conflict') return conflictOutcome(message);
  return human('merge_failed', message);

  // ── helpers that close over the landing state ───────────────────────────────

  async function landed(sha: string, mergingTask: Parameters<typeof finalizeMissionPrMerge>[0]): Promise<LandingOutcome> {
    await finalizeMissionPrMerge(mergingTask, installationId, repoFullName).catch((err) =>
      console.warn(`[pr-landing] mission finalize failed for PR #${prNumber}:`, err),
    );
    const startedAt = marker?.firstApprovedGreenAt ? Date.parse(marker.firstApprovedGreenAt) : NaN;
    if (owner.taskId && marker) await clearLandingMarker(owner.taskId).catch(() => {});
    return done({ kind: 'merged', sha }, 'merged', Number.isFinite(startedAt) ? { timeToLandMs: now() - startedAt } : {});
  }

  async function treadmillAccepts(base: string): Promise<TreadmillVerdict> {
    if (!marker || marker.pendingHeadSha !== liveHead) {
      return { accepted: false, reason: 'this head was not produced by a platform refresh' };
    }
    const [baseSide, prSide] = await Promise.all([
      githubApi(installationId, `${ghPath}/compare/${liveHead}...${encodeURIComponent(base)}`).catch(() => null),
      githubApi(installationId, `${ghPath}/pulls/${prNumber}/files?per_page=${COMPARE_FILE_CAP}`).catch(() => null),
    ]);
    return evaluateTreadmillBound({
      marker,
      liveHeadSha: liveHead,
      baseCommitsSince: typeof baseSide?.ahead_by === 'number' ? baseSide.ahead_by : Number.POSITIVE_INFINITY,
      baseFiles: filenames(baseSide?.files),
      prFiles: filenames(prSide),
    });
  }

  /** One refresh: update the branch, key the marker to the head it produced. */
  async function refresh(why: string, base: string): Promise<LandingOutcome> {
    const count = marker?.refreshCount ?? 0;
    if (count >= TREADMILL_MAX_REFRESHES) {
      return human('refresh_exhausted', `the base kept moving after ${count} refreshes (${why})`, { refreshCount: count });
    }
    if (!owner.taskId || !owner.workerId) {
      return human('no_owner', `${why}, and no task owns this PR to refresh it`);
    }
    if (!act) return done({ kind: 'updating_branch', newHeadSha: liveHead }, `would refresh the branch: ${why}`, { refreshCount: count });
    let res: DispatchConflictRetryResult;
    try {
      res = await dispatchConflictRetry({
        workerId: owner.workerId, taskId: owner.taskId, prNumber, headSha: liveHead, repoFullName, workspaceId, behindOnly: true,
      });
    } catch (err) {
      return human('merge_failed', `could not refresh the branch: ${errMessage(err)}`);
    }
    if (res.branchUpdated) {
      const after = await readLivePr(installationId, repoFullName, prNumber).catch(() => null);
      const newHead = after?.headSha ?? liveHead;
      const baseTip = base
        ? await githubApi(installationId, `${ghPath}/commits/${encodeURIComponent(base)}`).then((c) => (typeof c?.sha === 'string' ? c.sha : null)).catch(() => null)
        : null;
      const won = await writeLandingMarker(
        owner.taskId,
        {
          prNumber,
          pendingHeadSha: newHead,
          baseShaAtUpdate: baseTip,
          refreshCount: count + 1,
          firstApprovedGreenAt: marker?.firstApprovedGreenAt ?? new Date(now()).toISOString(),
          lastOutcome: 'updating_branch',
        },
        count,
      ).catch(() => false);
      return done({ kind: 'updating_branch', newHeadSha: newHead }, `refreshed the branch: ${why}`, { refreshCount: count + 1, markerWritten: won });
    }
    return mapRetry(res, why);
  }

  async function conflictOutcome(reason: string): Promise<LandingOutcome> {
    if (!owner.taskId || !owner.workerId) return human('no_owner', `${reason}, and no task owns this PR to fix it`);
    if (!act) return done({ kind: 'needs_fix', fix: 'conflict', reason }, reason, { fix: 'conflict', fixDispatched: false });
    let res: DispatchConflictRetryResult;
    try {
      res = await dispatchConflictRetry({
        workerId: owner.workerId, taskId: owner.taskId, prNumber, headSha: liveHead, repoFullName, workspaceId,
      });
    } catch (err) {
      return human('merge_failed', `could not file the conflict fix: ${errMessage(err)}`);
    }
    return mapRetry(res, reason);
  }

  async function mapRetry(res: DispatchConflictRetryResult, reason: string): Promise<LandingOutcome> {
    if (res.superseded) return human('superseded', 'the change is already upstream; the PR is superseded');
    if (res.dependencyBot) return human('dependency_bot', 'this is a dependency-bot PR; its own rebase owns the branch');
    if (res.baseRewritten) return human('base_rewritten', 'the base branch was rewritten after this PR opened');
    if (res.exhausted) {
      if (owner.taskId) await escalate(owner.taskId, repoFullName, prNumber, liveHead).catch(() => {});
      return human('fix_exhausted', `the conflict-fix attempts are exhausted (${reason})`);
    }
    if (res.disabled) return human('auto_resolve_disabled', `automatic conflict resolution is off for this workspace (${reason})`);
    const taskId = res.inFlightTaskId ?? res.taskId;
    return done(
      { kind: 'needs_fix', fix: 'conflict', reason, ...(taskId ? { taskId } : {}) },
      reason,
      { fix: 'conflict', fixDispatched: !!res.dispatched, dedup: !res.dispatched && !res.inFlightTaskId },
    );
  }
}
