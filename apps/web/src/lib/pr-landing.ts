/**
 * The PR landing function — one decide-and-act answer to "what happens to this
 * PR now?", for every door that can land one (knowledge-base: buildd/design/pr-landing-guarantee.md).
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
import type { WorkspaceReleaseConfig, WorkspaceGitConfig } from '@buildd/core/db/schema';
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
import { checkSurfaceOrder, mergeInSurfaceSlot } from '@/lib/surface-ordering-door';
import type { ChecksState, LandingAlertInput } from '@/lib/pr-landing-alert';
import type { StaleApprovalReReviewInput, StaleApprovalReReviewResult } from '@/lib/stale-approval-re-review';
import { POLICY_DEFAULTS, policyValue } from '@/lib/policy-overrides';
import {
  readLandingMarker,
  writeLandingMarker,
  clearLandingMarker,
  claimReviewRevalidation as defaultClaimReviewRevalidation,
  type LandingMarker,
} from '@/lib/pr-landing-marker';
import {
  extractMutableClaims,
  hasMutableClaims,
  judgeBlockingVerdict,
  MAX_SIBLING_PR_READS,
  type SiblingState,
} from '@/lib/escalation-revalidation';
import { LANDING_CYCLE_COOLDOWN_MS } from '@/lib/pr-landing-sweep';
import type { KernelLanding, LandingInput } from '@/lib/workflow/seam';

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
  /** The refresh cycle ran out while the base kept moving, and the gap was too big (or unlistable) to land across. Retried next cycle. */
  | 'refresh_exhausted'
  /** The refresh cycle ran out and the base keeps changing what this PR changes (shared files, migrations, schema, lockfiles). Retried next cycle. */
  | 'refresh_unsafe'
  /** update-branch kept failing for an operational reason (rate limit, auth, transient) — not a conflict. */
  | 'refresh_failed'
  /** Opted-in semantic check: the PR and base share files and symbol coverage stayed unknown. */
  | 'semantic_unverified'
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
  | { kind: 'waiting_ci'; headSha: string; /** What the landing is actually waiting on (the refusing rail / check / review / kernel state). */ reason?: string }
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
  /**
   * The workspace gitConfig, for surface merge ordering (lib/surface-ordering.ts).
   * Omitted, the ordering check loads it; with ordering off nothing is read.
   */
  gitConfig?: WorkspaceGitConfig | null;
  /**
   * The workflow-kernel delivery version a person's action was taken against
   * (§7.2). A stale one makes the kernel refuse the landing; routes check it
   * before calling here so no rail acts on a stale screen either.
   */
  expectedVersion?: number;
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
  dispatchFix?: (input: FixDispatchInput) => Promise<{ taskId?: string; /** Nothing was filed, and why. */ skipped?: string } | null>;
  /**
   * Sends a reviewer for a stale approval (the diff changed after the approve,
   * so carry-forward could not keep it). Used for the `re_review` fix of a
   * `stale_approval` block when no `dispatchFix` is wired. Defaults to the
   * shared dispatcher in stale-approval-re-review.ts, which the legacy
   * auto-merge door also calls; single-flight per PR + head.
   */
  dispatchStaleApprovalReReview?: (input: StaleApprovalReReviewInput) => Promise<StaleApprovalReReviewResult>;
  escalateConflictExhaustion?: (taskId: string, repoFullName: string, prNumber: number, headSha: string) => Promise<void>;
  /** The live reviewer-retry (author fixing a finding) task for this PR, if any. */
  findLiveReviewerRetry?: (workspaceId: string, prNumber: number) => Promise<string | null>;
  now?: () => number;
  /** Raises the one-per-key page for an outcome that needs a person (enforce only). Defaults to the DB-bound alert. */
  alert?: (input: LandingAlertInput) => Promise<void>;
  /** Persists or clears the record Home reads to tell a person owns the PR. Enforce only. */
  recordHandoff?: (taskId: string, handoff: { prNumber: number; headSha: string; cause: string; reason: string } | null) => Promise<void>;
  /** When the newest review of this PR concluded (epoch ms), or null. Half of the landing clock. Defaults to the DB-bound read. */
  readApprovedAt?: (workspaceId: string, prNumber: number) => Promise<number | null>;
  /**
   * Claims the one fresh review a stale blocking verdict is owed (true for
   * exactly one caller per review task). Defaults to the marker-backed claim.
   */
  claimReviewRevalidation?: (taskId: string, reviewTaskId: string) => Promise<boolean>;
  /** The kernel's landing (T15/T16) for a kernel-owned PR; null = not the kernel's PR. Defaults to the seam's. */
  landThroughKernel?: (input: LandingInput) => Promise<KernelLanding | null>;
  /**
   * The kernel delivery that owns this PR and its current view; null = legacy-owned.
   * On a kernel PR the delivery, not the legacy reviewer row, is the review gate.
   * Defaults to the seam's `kernelLandingView`.
   */
  kernelLandingView?: typeof import('@/lib/workflow/seam').kernelLandingView;
}

// ── Constants and pure pieces ──────────────────────────────────────────────────

/**
 * A head a refresh produced lands if the base gained at most this many commits
 * since. Public default; read the live value with `policyValue('treadmillMaxBaseCommits')`.
 */
export const TREADMILL_MAX_BASE_COMMITS = POLICY_DEFAULTS.treadmillMaxBaseCommits;
/** Refreshes per landing cycle before a person is asked. Public default; live value via `policyValue('treadmillMaxRefreshes')`. */
export const TREADMILL_MAX_REFRESHES = POLICY_DEFAULTS.treadmillMaxRefreshes;
/**
 * Once a cycle's refreshes are spent, a head our refresh produced may land
 * across a base gap of up to this many commits — still only when the moved
 * files are listable, disjoint from the PR's and free of migrations, schema and
 * lockfiles. This is what stops a busy base from starving a clean PR: the
 * refresh treadmill ends in a merge, not in a page.
 */
export const TREADMILL_EXHAUSTED_MAX_BASE_COMMITS = 20;

const LOCKFILE = /(^|\/)(bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$|\.lock$/;
const SCHEMA_FILE = 'packages/core/db/schema.ts';

const isRiskyPath = (path: string) => isGeneratedMigrationPath(path) || path === SCHEMA_FILE || LOCKFILE.test(path);

export type TreadmillVerdict =
  | { accepted: true }
  /** `unsafe`: the gap itself is the problem (shared files, risky paths), not its size. */
  | { accepted: false; reason: string; unsafe?: boolean };

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
  /** Overrides the base-commit limit (the exhausted-cycle rule passes the wider one). */
  maxBaseCommits?: number;
}): TreadmillVerdict {
  const { marker, liveHeadSha, baseCommitsSince, baseFiles, prFiles } = input;
  if (!marker || marker.pendingHeadSha !== liveHeadSha) {
    return { accepted: false, reason: 'this head was not produced by a platform refresh' };
  }
  const maxBaseCommits = input.maxBaseCommits ?? policyValue('treadmillMaxBaseCommits');
  if (baseCommitsSince > maxBaseCommits) {
    return { accepted: false, reason: `the base gained ${baseCommitsSince} commits since the last refresh (limit ${maxBaseCommits})` };
  }
  if (!baseFiles || !prFiles) {
    return { accepted: false, reason: 'could not list the files on one side of the gap' };
  }
  const risky = [...baseFiles, ...prFiles].find(isRiskyPath);
  if (risky) return { accepted: false, unsafe: true, reason: `the gap involves a migration, schema or lockfile (${risky})` };
  const mine = new Set(prFiles);
  const overlap = baseFiles.find((f) => mine.has(f));
  if (overlap) return { accepted: false, unsafe: true, reason: `the base changed a file this PR changes (${overlap})` };
  return { accepted: true };
}

/**
 * How many refreshes the current landing cycle has spent. A cycle belongs to a
 * head the platform produced: a push by anyone else (an author fix, a conflict
 * resolution) starts a new one, and so does a spent cycle once it has cooled
 * down — so a PR that lost the race is retried on the next quiet window rather
 * than parked for good.
 */
export function refreshCycleCount(marker: LandingMarker | null, liveHeadSha: string, nowMs: number): number {
  if (!marker || marker.pendingHeadSha !== liveHeadSha) return 0;
  if (marker.refreshCount >= policyValue('treadmillMaxRefreshes')) {
    const at = marker.updatedAt ? Date.parse(marker.updatedAt) : NaN;
    if (Number.isFinite(at) && nowMs - at >= LANDING_CYCLE_COOLDOWN_MS) return 0;
  }
  return marker.refreshCount;
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

/**
 * When the last required check on this head finished (epoch ms), or null when no
 * run reports a completion time. Half of the landing clock: green is when the
 * checks stopped, not when they started.
 */
export function latestCheckCompletion(runs: CheckRunState[] | undefined): number | null {
  let latest: number | null = null;
  for (const run of runs ?? []) {
    const at = run.completed_at ? Date.parse(run.completed_at) : NaN;
    if (Number.isFinite(at) && (latest === null || at > latest)) latest = at;
  }
  return latest;
}

/**
 * The start of the landing clock: the moment this PR was both approved and green
 * on the live head — the later of the two. Null when neither time is known.
 */
export function approvedGreenAt(approvedAtMs: number | null, greenAtMs: number | null): number | null {
  const known = [approvedAtMs, greenAtMs].filter((t): t is number => t !== null && Number.isFinite(t));
  return known.length > 0 ? Math.max(...known) : null;
}

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

async function defaultReadApprovedAt(workspaceId: string, prNumber: number): Promise<number | null> {
  return (await import('@/lib/pr-landing-clock')).readReviewApprovedAt(workspaceId, prNumber);
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
  const trace: LandingTrace = { headSha: null, title: null, checks: null, reason: null };
  try {
    const outcome = await decideAndLand(input, deps, trace);
    await raiseAlert(input, outcome, trace, deps);
    await recordHandoff(input, outcome, trace, deps);
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
  /** The check-run state the safety rails read on the live head, when they got that far. */
  checks: ChecksState | null;
  /** The reason the decision recorded for its outcome. */
  reason: string | null;
}

/** One word for a head's check runs: any failure is red, anything unfinished is pending. */
export function summarizeChecks(runs: CheckRunState[] | undefined): ChecksState | null {
  if (!runs || runs.length === 0) return null;
  if (runs.some((r) => r.conclusion === 'failure' || r.conclusion === 'timed_out' || r.conclusion === 'cancelled')) return 'red';
  if (runs.some((r) => r.status !== 'completed')) return 'pending';
  return 'green';
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
      checks: trace.checks,
      outcomeReason: trace.reason,
      installationId: input.installationId,
    });
  } catch (err) {
    console.warn(`[pr-landing] alert failed for PR #${input.prNumber}:`, errMessage(err));
  }
}

/**
 * Enforce only, never throws. A person owns the PR only when landing says so
 * for a cause that is not "could not tell" and not a spent refresh cycle (both
 * come back as the platform's to retry). Any other outcome clears the record.
 */
async function recordHandoff(input: LandPrInput, outcome: LandingOutcome, trace: LandingTrace, deps: LandPrDeps): Promise<void> {
  if (input.mode !== 'enforce' || !input.owner.taskId) return;
  try {
    const mod = await import('@/lib/pr-landing-handoff');
    const write = deps.recordHandoff ?? ((taskId, h) => (h ? mod.writeLandingHandoff(taskId, h) : mod.clearLandingHandoff(taskId)));
    const headSha = trace.headSha ?? input.eventHeadSha;
    const transient = outcome.kind === 'needs_human'
      && (outcome.cause === 'landing_error' || outcome.cause === 'github_unreadable'
        || outcome.cause === 'refresh_exhausted' || outcome.cause === 'refresh_unsafe');
    if (outcome.kind === 'needs_human' && !transient && headSha) {
      await write(input.owner.taskId, { prNumber: input.prNumber, headSha, cause: outcome.cause, reason: outcome.reason });
    } else if (outcome.kind !== 'needs_human') {
      await write(input.owner.taskId, null);
    }
  } catch (err) {
    console.warn(`[pr-landing] handoff record failed for PR #${input.prNumber}:`, errMessage(err));
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
  // Set once the verdict and CI rails have passed: from here on the PR is "approved and green".
  let approvedGreenAtMs: number | null = null;
  // Set when a behind head lands under the spent-cycle freshness rule rather than the ordinary bound.
  let freshnessRule: 'spent_cycle' | null = null;

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
      ...(approvedGreenAtMs !== null ? { approvedGreenAt: new Date(approvedGreenAtMs).toISOString() } : {}),
      ...extra,
    };
    if (act) detail.landingOutcome = outcome.kind;
    else detail.shadowOutcome = outcome.kind;
    trace.reason = reason;
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
    done({ kind: 'waiting_ci', headSha: headSha ?? '', reason }, reason, extra);

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

  const needsFix = async (
    fix: Exclude<FixKind, 'conflict'>,
    reason: string,
    dispatch: LandPrDeps['dispatchFix'] = deps.dispatchFix,
    extra: Record<string, unknown> = {},
  ): Promise<LandingOutcome> => {
    let taskId: string | undefined;
    let dispatched = false;
    let fixSkipped: string | null = null;
    if (act && dispatch) {
      try {
        const res = await dispatch({
          kind: fix, workspaceId, installationId, repoFullName, prNumber, headSha: headSha ?? '', owner, reason,
        });
        taskId = res?.taskId;
        dispatched = !!res;
        if (res?.skipped) {
          dispatched = false;
          fixSkipped = res.skipped;
        }
      } catch (err) {
        return human('merge_failed', `could not file the ${fix} fix: ${errMessage(err)}`);
      }
    }
    return done(
      { kind: 'needs_fix', fix, reason, ...(taskId ? { taskId } : {}) },
      reason,
      { ...extra, fix, fixDispatched: dispatched, ...(fixSkipped ? { fixSkipped } : {}) },
    );
  };

  // A stale approval's fix is a reviewer for the live head, through the same
  // dispatcher the legacy auto-merge door uses (resolveReReviewPlan + the
  // reviewer-task dedupe). Already-reviewing names that reviewer as the owner.
  // A stale blocking verdict uses the same dispatcher, labelled with why.
  // A PR nobody ever asked a reviewer about uses it too, as a first review.
  const reReviewVia = (staleReason?: string, firstReview = false): NonNullable<LandPrDeps['dispatchFix']> => async (fi) => {
    const send = deps.dispatchStaleApprovalReReview
      ?? (await import('@/lib/stale-approval-re-review')).dispatchStaleApprovalReReview;
    const res = await send({
      ...(staleReason ? { staleReason } : {}),
      ...(firstReview ? { firstReview: true } : {}),
      workspaceId: fi.workspaceId,
      installationId: fi.installationId,
      repoFullName: fi.repoFullName,
      prNumber: fi.prNumber,
      headSha: fi.headSha,
      baseRef,
      taskId: fi.owner.taskId,
      workerId: fi.owner.workerId,
      policy,
    });
    return res.outcome === 'skipped' ? { skipped: res.reason } : { taskId: res.reviewTaskId };
  };
  const staleApprovalReReview = reReviewVia();

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

  // ── 2b. Surface merge ordering — before any rail that can mutate the branch ─
  // A PR behind an earlier open PR on a serialized surface waits; that PR's
  // close re-drives this one. Shadow asks without writing anything.
  const surfaceOrder = await checkSurfaceOrder({
    workspaceId,
    installationId,
    repoFullName,
    prNumber,
    headSha: liveHead,
    gitConfig: input.gitConfig,
    taskId: owner.taskId,
    workerId: owner.workerId,
    door: input.door,
    callerOrigin,
    observeOnly: !act,
  });
  if (surfaceOrder.blocks) {
    return waiting(surfaceOrder.reason, {
      waitingOn: 'surface_order',
      orderKind: surfaceOrder.kind,
      counterpartPrNumber: surfaceOrder.counterpartPrNumber,
      surface: surfaceOrder.surface,
    });
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
      gitConfig: input.gitConfig,
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
  trace.checks = summarizeChecks(observed.checkRuns);

  if (!safety.ok) {
    const reason = safety.reason;
    const refusal = classifyAutoMergeRefusal(reason);
    // A conflict blocks every door, and GitHub runs no fresh CI on a PR it
    // cannot merge, so a dirty PR is repaired first even when an earlier rail
    // (red CI, a deny path, the size cap) refused it. Repairing is not
    // merging: every rail is evaluated again on the repaired head.
    const dirty = (observed.mergeableState ?? pr.mergeableState) === 'dirty';
    if (dirty && refusal !== 'conflict' && refusal !== 'stale_head' && refusal !== 'github_read') {
      return conflictOutcome(`PR has conflicts (mergeable_state: dirty) — needs rebase onto base branch; also refused: ${reason}`, { alsoRefused: refusal });
    }
    switch (refusal) {
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
      case 'semantic_hold':
        // Base commits merged in after the semantic verdict are being re-verified
        // (base-refresh.ts): a wait while rechecks remain, a person after.
        return /^semantic hold \(needs a person\)/.test(reason) ? human('semantic_unverified', reason) : waiting(reason);
      default:
        return human('unsafe_other', reason);
    }
  }

  // ── 4. Review verdict ───────────────────────────────────────────────────────
  // A kernel-owned PR's review gate is its delivery (T15 lands only from APPROVED at
  // the exact head, or a person's override from a review state). The legacy reviewer
  // row must not block, stall or re-review it: a composition- or human-approved
  // delivery has no reviewer row at all (incident #2574). A read error falls back to
  // the legacy gate, which can only hold a landing, never authorise one past T15.
  const readKernelView = deps.kernelLandingView ?? (await import('@/lib/workflow/seam')).kernelLandingView;
  const kernelView = await readKernelView(workspaceId, repoFullName, prNumber).catch(() => null);
  if (kernelView) {
    const { state, head } = kernelView.current;
    const extra = { deliveryState: state, deliveryVersion: kernelView.current.version };
    if (head !== liveHead) return waiting(`the kernel has not observed head ${liveHead.slice(0, 7)} yet`, extra);
    const overridable = override.verdict && (state === 'AWAITING_REVIEW' || state === 'CHANGES_REQUESTED' || state === 'ESCALATED');
    if (state !== 'APPROVED' && !overridable) {
      return waiting(`the delivery is ${state ?? 'unknown'}; the kernel lands it only once APPROVED (T15)`, extra);
    }
  }

  // Legacy: the newest reviewer row, always with the carry-forward hint.
  const gate = kernelView ? { blocks: false as const } : await guardReviewVerdict({
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
      if (gate.kind === 'stale_approval') return needsFix('re_review', reason, deps.dispatchFix ?? staleApprovalReReview);
      const live = await findLiveRetry(workspaceId, prNumber).catch(() => null);
      if (live) {
        return done({ kind: 'needs_fix', fix: 're_review', reason, taskId: live }, reason, { ...extra, fix: 're_review', fixDispatched: false });
      }
      const revalidated = await revalidateBlockingVerdict(gate, reason, extra);
      if (revalidated) return revalidated;
      return human(
        'blocking_verdict',
        `${reason}. Next: a person acts on the finding; a push that fixes it is re-reviewed automatically`,
        extra,
      );
    }
  }

  // ── 5. Agent-review tier: a stored approve above the confidence bar ─────────
  if (!kernelView && policy.tier === 'agent-review' && actor.kind !== 'human') {
    const status = await reviewStatus();
    if (!status) return waiting('could not read the stored review verdict');
    if (!isApprovalSelfMergeable(status, policy.agentReview?.maxConfidenceThreshold)) {
      if (status.verdict === 'approve' && !status.merged) {
        return human('low_confidence', `the reviewer approved with confidence ${status.confidence ?? 'unknown'}, below the bar for unattended landing`);
      }
      if (status.state === 'review_failed') {
        return human('review_failed', 'the review produced no verdict');
      }
      // Green, mergeable and never reviewed: the review request was lost (or
      // never sent), so send the workspace's reviewer now. Single-flight per
      // PR + head through the reviewer dedupe; once it exists the state is
      // queued/reviewing and the verdict gate above waits on it.
      if (status.state === 'not_requested') {
        return needsFix(
          're_review',
          'the PR is green and mergeable but no review was ever requested. Next: the workspace reviewer was asked; its verdict decides the landing',
          deps.dispatchFix ?? reReviewVia(undefined, true),
          { firstReview: true },
        );
      }
      return needsFix('re_review', 'no approved review is on file for this head');
    }
  }

  // The verdict and CI rails have passed: the clock for the landing metric starts
  // at the later of the approval and the last check finishing.
  approvedGreenAtMs = approvedGreenAt(
    await (deps.readApprovedAt ?? defaultReadApprovedAt)(workspaceId, prNumber).catch(() => null),
    latestCheckCompletion(observed.checkRuns),
  );

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
        const spent = refreshCycleCount(marker, liveHead, now()) >= policyValue('treadmillMaxRefreshes');
        const tolerated = await treadmillAccepts(baseRef, spent);
        if (!tolerated.accepted) return refresh(tolerated.reason, baseRef, tolerated.unsafe === true);
        if (spent) freshnessRule = 'spent_cycle';
      }
    }
  }

  // ── 7. Mission PR lifecycle, then the merge ─────────────────────────────────
  let mergingTask: { id: string; title: string; taskClass: string | null; missionId: string | null; context: unknown } | null = null;
  if (owner.taskId) {
    try {
      mergingTask =
        (await db.query.tasks.findFirst({
          where: eq(tasks.id, owner.taskId),
          columns: { id: true, title: true, taskClass: true, missionId: true, context: true },
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

  // See the matching note in auto-merge.ts: mission-branch-refresh.ts's
  // conflict-resolution task IS the merge commit that catches a mission's
  // integration branch up with dev, and squashing it would drop that
  // ancestry — the same conflict would reappear on the next refresh.
  const requireMergeCommit = (mergingTask?.context as Record<string, unknown> | null)?.requireMergeCommit === true;
  const mergeMethod = requireMergeCommit ? 'merge' : (input.mergeMethod ?? 'squash');
  // Every rail above passed. A kernel-owned PR is merged by the kernel (T15 →
  // merge_call → T16 → verify_merge → PrMerged), which also owns the
  // post-merge work; any other PR merges here as before.
  const kernelLand = deps.landThroughKernel ?? (await import('@/lib/workflow/seam')).landThroughKernel;
  const slotted = await mergeInSurfaceSlot(surfaceOrder, async () => {
    const kernel = await kernelLand({
      workspaceId, installationId, repoFullName, prNumber, headSha: liveHead,
      door: `land_pr:${input.door}`,
      actor: actor.kind === 'human' ? `human:${actor.userId ?? 'unknown'}` : actor.kind === 'agent' ? `agent:${actor.workerId ?? 'unknown'}` : `system:${input.door}`,
      mergeMethod,
      ...(override.verdict ? { override: { reason: 'a person merged past the review verdict' } } : {}),
      ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
    });
    return kernel ? { kernel } : { legacy: await mergePullRequest(installationId, repoFullName, prNumber, mergeMethod, liveHead) };
  });
  if ('refused' in slotted) return waiting(slotted.refused, { waitingOn: 'surface_slot' });
  if (slotted.result.kernel) return kernelLanded(slotted.result.kernel);
  const result = slotted.result.legacy;
  if (result.merged) return landed(liveHead, mergingTask);

  const message = result.message || 'the merge call failed';
  if (result.indeterminate) {
    const after = await readLivePr(installationId, repoFullName, prNumber).catch(() => null);
    if (after?.merged) return landed(after.mergeCommitSha ?? liveHead, mergingTask);
    return waiting(message);
  }
  if (/base branch was modified/i.test(message)) return refresh(message, baseRef ?? '');
  if (/head branch was modified/i.test(message)) return waiting(message);
  // Branch protection that requires an up-to-date branch: same work as behind base.
  if (/(is|was) (out of date|not up to date)/i.test(message)) return refresh(message, baseRef ?? '');
  if (classifyMergeFailure(message) === 'conflict') return conflictOutcome(message);
  return human('merge_failed', message);

  // ── helpers that close over the landing state ───────────────────────────────

  /** The kernel's answer, as a landing outcome. It already queued whatever repair it owes. */
  async function kernelLanded(k: KernelLanding): Promise<LandingOutcome> {
    const extra = { kernel: k.outcome, kernelReason: k.reason, deliveryState: k.current.state, deliveryVersion: k.current.version };
    switch (k.outcome) {
      // The mission branch is finalized by the kernel's post-merge effect, not here.
      case 'merged': return landed(k.mergeCommitSha ?? liveHead, null);
      case 'behind': return done({ kind: 'updating_branch', newHeadSha: liveHead }, `the kernel is refreshing the branch: ${k.message}`, extra);
      case 'conflict': return done({ kind: 'needs_fix', fix: 'conflict', reason: k.message }, k.message, { ...extra, fix: 'conflict', fixDispatched: true });
      case 'refused': return human('merge_failed', k.message, extra);
      // A lost answer is verified by the kernel before anything re-calls GitHub; a moved head or
      // a stale screen is re-read; a delivery not ready to land is the kernel's to move on.
      default: return waiting(k.message, extra);
    }
  }

  async function landed(sha: string, mergingTask: Parameters<typeof finalizeMissionPrMerge>[0]): Promise<LandingOutcome> {
    await finalizeMissionPrMerge(mergingTask, installationId, repoFullName).catch((err) =>
      console.warn(`[pr-landing] mission finalize failed for PR #${prNumber}:`, err),
    );
    // The earliest known start wins: a refresh restarts CI, and the wait it caused is still the PR's wait.
    const fromMarker = marker?.firstApprovedGreenAt ? Date.parse(marker.firstApprovedGreenAt) : NaN;
    const starts = [fromMarker, approvedGreenAtMs ?? NaN].filter(Number.isFinite);
    if (owner.taskId && marker) await clearLandingMarker(owner.taskId).catch(() => {});
    return done(
      { kind: 'merged', sha },
      'merged',
      {
        ...(starts.length > 0 ? { timeToLandMs: Math.max(0, now() - Math.min(...starts)) } : { timeToLandUnmeasured: true }),
        ...(freshnessRule ? { freshnessRule } : {}),
      },
    );
  }

  /**
   * A blocking verdict whose basis no longer holds — given on an earlier head,
   * or resting on sibling-PR / migration / conflict state that has since
   * changed — earns one fresh review of the live head instead of a page. It is
   * never merged past: the fresh reviewer decides. One per head and basis, so a
   * verdict that blocks again goes to a person. Null when the verdict stands.
   *
   * The migration and conflict claims are judged against the rails above: this
   * runs only after `evaluateAutoMergeSafety` passed on the live head, so the
   * migration inspector found no collision and GitHub reports no conflict now.
   */
  async function revalidateBlockingVerdict(
    g: Awaited<ReturnType<typeof guardReviewVerdict>>,
    reason: string,
    extra: Record<string, unknown>,
  ): Promise<LandingOutcome | null> {
    if (g.kind !== 'escalated' && g.kind !== 'changes_requested') return null;
    const status = await reviewStatus();
    const text = [status?.escalationReason, status?.feedback, status?.summary, reason].filter(Boolean).join('\n');
    const claims = extractMutableClaims(text, prNumber);
    const reviewHeadSha = g.reviewHeadSha ?? status?.reviewHeadSha ?? null;
    const headMoved = !!reviewHeadSha && reviewHeadSha !== liveHead;
    const siblings: Record<number, SiblingState> = {};
    if (!headMoved && hasMutableClaims(claims) && claims.prNumbers.length <= MAX_SIBLING_PR_READS) {
      await Promise.all(
        claims.prNumbers.map(async (n) => {
          const p = await githubApi(installationId, `${ghPath}/pulls/${n}`).catch(() => null);
          siblings[n] = p?.merged === true ? 'merged' : p?.state === 'open' ? 'open' : p?.state === 'closed' ? 'closed' : 'unknown';
        }),
      );
    }
    const judged = judgeBlockingVerdict({
      reviewHeadSha,
      liveHeadSha: liveHead,
      equivalentHeadShas: status?.reviewEquivalentHeadShas ?? null,
      claims,
      siblings,
      migrationClear: true,
      conflictClear: true,
    });
    if (!judged.stale) return null;

    const staleExtra = { ...extra, staleVerdict: judged.basis, staleBecause: judged.why };
    const why = `the reviewer's verdict no longer describes this PR: ${judged.why}`;
    if (!act) {
      return done({ kind: 'needs_fix', fix: 're_review', reason: why }, `would request a fresh review: ${why}`, {
        ...staleExtra, fix: 're_review', fixDispatched: false,
      });
    }
    if (!owner.taskId) return null;
    const claim = deps.claimReviewRevalidation ?? defaultClaimReviewRevalidation;
    const won = await claim(owner.taskId, `${liveHead}:${judged.basis}`).catch(() => false);
    if (!won) {
      return human(
        'blocking_verdict',
        `${reason}. A fresh review was already requested for this head after the earlier verdict went stale (${judged.why}), and the PR is still blocked. Next: a person acts on the finding`,
        { ...staleExtra, revalidated: true },
      );
    }
    return needsFix(
      're_review',
      `${why}. Next: a fresh review of ${liveHead.slice(0, 7)} was requested; its verdict decides the landing`,
      deps.dispatchFix ?? reReviewVia(judged.why),
      staleExtra,
    );
  }

  async function treadmillAccepts(base: string, spent = false): Promise<TreadmillVerdict> {
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
      ...(spent ? { maxBaseCommits: Math.max(TREADMILL_EXHAUSTED_MAX_BASE_COMMITS, policyValue('treadmillMaxBaseCommits')) } : {}),
    });
  }

  /**
   * One refresh: update the branch, key the marker to the head it produced.
   *
   * A spent cycle is told apart by why the head could not land: `unsafe` (the
   * base keeps changing what this PR changes) is not the same as a base that is
   * merely busy. Either way the platform keeps owning it — a new cycle starts
   * after the cooldown — and the page says so.
   */
  async function refresh(why: string, base: string, unsafe = false): Promise<LandingOutcome> {
    const stored = marker?.refreshCount ?? 0;
    const count = refreshCycleCount(marker, liveHead, now());
    if (count >= policyValue('treadmillMaxRefreshes')) {
      const next = `Next: landing starts a new refresh cycle within ${Math.round(LANDING_CYCLE_COOLDOWN_MS / 60_000)}m and lands it in the first quiet window; a person can merge it now with a freshness override`;
      return unsafe
        ? human('refresh_unsafe', `after ${count} refreshes the base still changes what this PR changes (${why}), so a green on an older base is not proof. ${next}`, { refreshCount: count })
        : human('refresh_exhausted', `the base kept moving after ${count} refreshes (${why}). ${next}`, { refreshCount: count });
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
        stored,
      ).catch(() => false);
      return done({ kind: 'updating_branch', newHeadSha: newHead }, `refreshed the branch: ${why}`, { refreshCount: count + 1, markerWritten: won });
    }
    return mapRetry(res, why);
  }

  /**
   * One concrete repair for the conflict as it stands now. The base tip is
   * passed so the dispatcher can key the repair to this conflict basis (head +
   * base): a spent attempt budget from an earlier conflict does not strand a
   * new one, and the same basis is never repaired twice.
   */
  async function conflictOutcome(reason: string, extra: Record<string, unknown> = {}): Promise<LandingOutcome> {
    if (!owner.taskId || !owner.workerId) return human('no_owner', `${reason}, and no task owns this PR to fix it`, extra);
    if (!act) return done({ kind: 'needs_fix', fix: 'conflict', reason }, reason, { ...extra, fix: 'conflict', fixDispatched: false });
    const baseSha = baseRef
      ? await githubApi(installationId, `${ghPath}/commits/${encodeURIComponent(baseRef)}`)
        .then((c) => (typeof c?.sha === 'string' ? c.sha : null))
        .catch(() => null)
      : null;
    let res: DispatchConflictRetryResult;
    try {
      res = await dispatchConflictRetry({
        workerId: owner.workerId, taskId: owner.taskId, prNumber, headSha: liveHead, repoFullName, workspaceId, baseSha,
      });
    } catch (err) {
      return human('merge_failed', `could not file the conflict fix: ${errMessage(err)}`, extra);
    }
    return mapRetry(res, reason, extra);
  }

  async function mapRetry(res: DispatchConflictRetryResult, reason: string, extra: Record<string, unknown> = {}): Promise<LandingOutcome> {
    // The conflict flag was stale: a merge against the current base tip was
    // clean, so the branch was updated with no agent. The new head earns its
    // own CI and lands on its own event.
    if (res.conflictFalsePositive && res.branchUpdated) {
      const after = await readLivePr(installationId, repoFullName, prNumber).catch(() => null);
      return done(
        { kind: 'updating_branch', newHeadSha: after?.headSha ?? liveHead },
        `flagged as conflicting, but the base merged in cleanly; updated the branch instead of filing a fix (${reason})`,
        { ...extra, refresh: 'conflict_false_positive' },
      );
    }
    // Refresh outcomes that are not conflicts (lib/base-refresh.ts): no fix was
    // filed and none is owed. A later event or the sweep re-drives the PR.
    if (res.headChanged) return waiting(`the PR head moved before the refresh (${reason}); re-reading on the new head`, { refresh: 'head_changed' });
    if (res.refreshInFlight) return waiting(`another refresh of this PR is in flight (${reason})`, { refresh: 'in_flight' });
    if (res.refreshDeferred) {
      return waiting(`updating the branch failed (${res.refreshFailure ?? 'unknown'}), not a conflict; will retry (${reason})`, { refresh: 'deferred', failure: res.refreshFailure ?? null });
    }
    if (res.semanticDeferred) return waiting(`semantic overlap with the base is not yet verified; will recheck (${reason})`, { refresh: 'semantic_deferred' });
    if (res.alreadyUpToDate) return waiting(`the branch already has every base commit; re-reading (${reason})`, { refresh: 'up_to_date' });
    if (res.refreshExhausted) {
      return human('refresh_failed', `updating the branch kept failing (${res.refreshFailure ?? 'unknown'}), not a conflict (${reason})`, { failure: res.refreshFailure ?? null });
    }
    if (res.semanticUnverified) {
      return human('semantic_unverified', `the PR and the base change the same files and their symbol overlap could not be verified (${reason})`);
    }
    if (res.superseded) return human('superseded', 'the change is already upstream; the PR is superseded');
    if (res.dependencyBot) return human('dependency_bot', 'this is a dependency-bot PR; its own rebase owns the branch');
    if (res.baseRewritten) return human('base_rewritten', 'the base branch was rewritten after this PR opened');
    if (res.exhausted) {
      if (owner.taskId) await escalate(owner.taskId, repoFullName, prNumber, liveHead).catch(() => {});
      return human('fix_exhausted', `the conflict-fix attempts are exhausted and this exact conflict (head and base) was already attempted (${reason}). Next: a person resolves the conflict or closes the PR; a push, or a base that moves, re-enters landing with a fresh repair`);
    }
    if (res.disabled) return human('auto_resolve_disabled', `automatic conflict resolution is off for this workspace (${reason}). Next: a person resolves the conflict, or turns automatic resolution on`);
    const taskId = res.inFlightTaskId ?? res.taskId;
    return done(
      { kind: 'needs_fix', fix: 'conflict', reason, ...(taskId ? { taskId } : {}) },
      reason,
      { ...extra, fix: 'conflict', fixDispatched: !!res.dispatched, dedup: !res.dispatched && !res.inFlightTaskId },
    );
  }
}
