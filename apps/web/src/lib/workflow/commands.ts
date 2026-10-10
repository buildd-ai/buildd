/**
 * Kernel commands (docs/specs/workflow-state-kernel.md §6.3, T1–T27) and the
 * reducer's decision shape (§6.1). Every live GitHub read a transition needs
 * is carried IN the command as evidence, so the reducer stays a pure function
 * of (view, command); the caller (fact ingestion, a route) does the read.
 */
import type {
  Actor,
  AttemptFamily,
  AttemptMode,
  AttemptOutcome,
  AttemptStatus,
  ApprovalBasis,
  CloseCause,
  CompositionAttestation,
  PolicyEvidence,
  ConstituentEvidence,
  DeliveryState,
  RoundKind,
  RoundStatus,
  Verdict,
} from './types';

/** A GitHub `GET /pulls/{n}` read the kernel took after the command arrived (R2). */
export interface LivePr {
  state: 'open' | 'closed';
  merged: boolean;
  headSha: string;
  headRepoFullName: string | null;
  baseRef: string | null;
  mergedAt?: string | null;
  mergeCommitSha?: string | null;
  updatedAt?: string | null;
  /** GitHub's `mergeable_state` at read time (`clean`, `dirty`, `behind`, `blocked`, `unstable`, `draft`, `unknown`, ...). */
  mergeableState?: string | null;
  /** A draft PR (GitHub refuses to merge it); present only when true. */
  draft?: boolean;
}

interface Base {
  actor: Actor;
  /** Human/agent callers send back the version they read (§7.2); reducer-driven callers omit it. */
  expectedVersion?: number;
}

export type Command =
  | (Base & { type: 'DeliveryOpened'; workspaceId: string; ownerTaskId: string; requiresPr: boolean; maxRounds?: number })
  | (Base & {
      type: 'PrBound';
      repoFullName: string;
      prNumber: number;
      live: LivePr;
      /** Adoption of a PR buildd did not open: creates the delivery (synthetic owner task). */
      adoption?: { workspaceId: string; ownerTaskId: string; maxRounds?: number };
    })
  | (Base & {
      type: 'HeadObserved';
      /** The head a webhook payload claimed; diagnostic only. */
      hintedHeadSha?: string | null;
      live: LivePr;
      /** §9 proof inputs for the bound attempt, when one exists. */
      proof?: { liveContainsLocal: boolean; contentDiffChanged?: boolean };
      /** §8.3 carry-forward evidence for an APPROVED/LANDING delivery. */
      carryForward?: 'content_equivalent' | 'own_refresh' | null;
      /**
       * §6.9 provenance input from the compare API: does the live head descend
       * from the bound attempt's head? Combined with the attempt's own
       * reported_shas and its running status, never with a commit author.
       */
      attribution?: { descendsFromBound: boolean };
    })
  | (Base & {
      type: 'AttemptEnded';
      /** The worker row whose exit this is: one task can run several workers (retries). */
      workerId: string;
      /** Owner attempts are named by task id; repair attempts by workflow_attempts id. */
      taskId?: string;
      attemptId?: string;
      outcome: 'success' | 'failed' | 'lost' | 'unproven';
      localHeadSha: string | null;
      commitCount: number;
      live: LivePr | null;
      proof?: { liveContainsLocal: boolean; contentDiffChanged?: boolean };
      carryForward?: 'content_equivalent' | 'own_refresh' | null;
      /** The owner task's own (infra) retry budget, not a ledger. */
      taskRetryBudgetLeft?: boolean;
      /** Whether this workspace's policy wants a review round once a head exists. */
      reviewRequired?: boolean;
      /**
       * §6.5 row 1 (e9f1674b): the check runs on the live head, read when the owner attempt
       * ended. A red head is handed on to `REPAIRING(ci)` by T10's ledger rather than to a
       * review round, because a failure hint that arrived while `WORKING` was refused there.
       * Absent or null (unreadable) hands on exactly as before.
       */
      ci?: { liveChecks: { complete: boolean; failing: string[] }; signature: string; maxAttempts: number } | null;
    })
  | (Base & { type: 'ReviewRequested'; headSha: string; live: LivePr; forced?: boolean })
  | (Base & {
      type: 'ReviewVerdictRecorded';
      roundId: string;
      verdict: Verdict;
      /** Server escalation rules (file list, confidence) applied by the caller. */
      effectiveVerdict: Verdict;
      headBound: string;
      confidence?: number | null;
    })
  | (Base & { type: 'ReviewBudgetExhausted' })
  | (Base & {
      type: 'FixDispatched';
      roundId: string;
      taskId: string;
      maxAttempts: number;
      /**
       * `human`: T23 apply/request changes on an escalation. The round need not carry a
       * request-changes verdict (an escalated one is the point), and past the cap the person
       * extends the budget by exactly one, recorded as a bypass. Absent = automatic.
       */
      trigger?: 'automatic' | 'human';
      revalidation: { live: LivePr; newerApprove: boolean };
    })
  | (Base & {
      type: 'FixClaimed';
      attemptId: string;
      /** `ciGreen`: the CI family's own trigger fact is no longer true at the head (§10.5). */
      revalidation: { live: LivePr; approved: boolean; ciGreen?: boolean; conflictResolved?: boolean };
    })
  | (Base & {
      /**
       * §10.5 dispatch-time revalidation for a repair family: the bound repair
       * attempt's target no longer needs work (head moved, PR not open, CI green).
       * The ledger row is `skipped` (it consumes no budget) and the delivery
       * resumes the state the repair interrupted.
       */
      type: 'RepairNotNeeded';
      attemptId: string;
      reason: string;
      live?: LivePr | null;
    })
  | (Base & {
      /**
       * §5.7 rule 5 / AC-14: a person asks for one more attempt of a family whose
       * budget is spent. Allocates that attempt (trigger=human, numbered after
       * the last, never 0) in the same statement, so the extension is visible as
       * its own transition and bounds exactly one dispatch.
       */
      type: 'BudgetExtended';
      family: 'ci';
      headSha: string;
      signature: string;
      /** The configured cap (gitConfig.maxCiRetries or the policy default). */
      maxAttempts: number;
      reason: string;
    })
  | (Base & {
      type: 'CiFailedObserved';
      headSha: string;
      signature: string;
      maxAttempts: number;
      /** An open trunk incident whose signature matches (§6.10); routes to T25. */
      openTrunkIncidentId?: string | null;
      /** §6.10 tier 3: the failing check a configured preflight covers, recorded as `preflightMiss` on the transition. */
      preflightMiss?: string | null;
      trigger?: 'automatic' | 'human';
      triggerFactId?: string | null;
      /**
       * §6.3 T10: the check runs on `headSha` read live when the hint was
       * handled. A read with nothing failing (green, or a re-run still going)
       * means the hint is no longer true: `rejected(ci_not_red)`. Absent or
       * null (unreadable) fails toward doing the work.
       */
      liveChecks?: { complete: boolean; failing: string[] } | null;
    })
  | (Base & {
      type: 'ConflictObserved';
      headSha: string;
      /** From a live read taken now, not a stored snapshot. */
      mergeable: 'dirty' | 'behind';
      migrationCollision?: boolean;
      /** Set when the mechanical attempt for this head was refused (textual conflict). */
      mechanicalRefused?: boolean;
      maxMechanical?: number;
      maxAgentAttempts: number;
      isDependencyBot?: boolean;
      /** What the refused mechanical attempt saw (update-branch refusal, semantic overlap), handed to the agent attempt. */
      refusal?: Record<string, unknown> | null;
      /** The repair's subject, carried on its effects (e.g. the migration collision: file, otherFile, otherPrNumber). */
      detail?: Record<string, unknown> | null;
    })
  | (Base & {
      /**
       * A mechanical repair failed for an operational reason (update-branch kept
       * failing, refused by GitHub, semantic overlap unverifiable), not a textual
       * conflict. No agent can fix that: the bound mechanical row ends `failed`
       * and landing needs a person (§6.7).
       */
      type: 'MechanicalRepairFailed';
      attemptId: string;
      reason: string;
    })
  | (Base & {
      /**
       * S15 cycles: the landing sweep found a delivery the behind-refresh
       * treadmill escalated, and the cooldown since that escalation has passed.
       * It returns to `APPROVED` with a fresh refresh budget (a `treadmill_cycle`
       * marker row opens the new cycle), at most `MAX_TREADMILL_CYCLES` cycles
       * per delivery. The caller pins `expectedVersion` to the version the
       * treadmill escalation produced, so any later move refuses it.
       */
      type: 'TreadmillCycleRestarted';
    })
  | (Base & { type: 'HumanApproved'; reviewId: string; commitId: string; hasMergePermission: boolean })
  | (Base & {
      /**
       * The escalation gate's `policy_merge` rule (@buildd/core/escalation-gate
       * `isPolicyMerge`): a review escalation that was the policy's alone, with
       * CI green on the reviewed head, not a draft, not XL, and only the risk
       * classes that landed cleanly in the backtest. It approves exactly
       * `headSha` (a later push is not covered) on the basis `policy_rule`, and
       * the normal landing doors then land it under the workspace merge policy
       * with every rail (deny paths, size cap, migration inspector) evaluated
       * again. Rule-only: the actor is `rule:<name>`, never a model.
       */
      type: 'PolicyMergeApproved';
      headSha: string;
      reason: string;
    })
  | (Base & {
      type: 'LandingRequested';
      door: string;
      headSha: string;
      live: LivePr;
      rails: { passed: boolean; redCi?: boolean; denyPaths?: boolean; reasons?: string[] };
      /**
       * A person merging past a rail (the dashboard's "Merge anyway", `merge_pr`
       * with `overrides`, chat): recorded in `bypass`, never past red CI or a
       * deny path. `kinds` absent or naming `verdict`: a verdict override, from
       * the review states. Only `freshness` / `size`: lifts a landing escalation
       * (`ESCALATED(landing_needs_human)`, e.g. the spent treadmill) and nothing
       * else. `grantedBy`: an agent run acting under a grant a person put on
       * its task (`context.landingOverride`); the door is that person's.
       */
      override?: { reason: string; kinds?: Array<'verdict' | 'freshness' | 'size'>; grantedBy?: string } | null;
      /** How GitHub combines the PR; carried to the `merge_call` effect. Default squash. */
      mergeMethod?: 'merge' | 'squash' | 'rebase';
    })
  | (Base & {
      type: 'MergeCallResult';
      headSha: string;
      /**
       * GitHub's answer to the pinned merge call. `not_merged`: the live read a
       * `verify_merge` took after an indeterminate answer shows the PR still open
       * and unmerged at the head (or the head moved under the call), so nothing
       * landed and landing may be requested again.
       */
      outcome: 'merged' | 'indeterminate' | 'behind' | 'conflict' | 'refused' | 'not_merged';
      detail?: string;
      /** The version T15 left the delivery at: one landing request, so a re-landing at the same head after a refusal is a new key. */
      landingVersion?: number;
      /** A transient answer (rate limit, 5xx): when GitHub said to call again (ISO). The landing sweep waits until then. */
      retryAt?: string;
    })
  | (Base & { type: 'PrMerged'; live: LivePr })
  | (Base & { type: 'PrClosedUnmerged'; live: LivePr; closeCause: CloseCause })
  | (Base & { type: 'PrReopened'; live: LivePr })
  | (Base & {
      /**
       * The PR's base branch changed (`pull_request.edited` with `changes.base`, or a live read
       * that disagrees with `delivery.baseRef`, e.g. GitHub's retarget of a stacked PR). The head
       * did not move, but the diff did (24e1cfad).
       */
      type: 'BaseChanged';
      live: LivePr;
      /** The PR's diff against the new base equals its diff against the old one (§8.3 evidence). */
      diffEquivalent?: boolean;
    })
  | (Base & {
      type: 'SupersessionRecorded';
      target: { repoFullName: string; prNumber: number; merged: boolean; url: string | null };
      reason: string;
      authorised: boolean;
    })
  | (Base & { type: 'Abandon'; reason: string })
  | (Base & { type: 'PushRecoveryExhausted'; localHeadSha: string | null })
  | (Base & {
      /**
       * §10.3: an effect the delivery needed went `dead` (8 failed tries). A
       * critical one hands the delivery to a person; the reducer decides
       * whether it still describes the delivery.
       */
      type: 'EffectDead';
      effectId: string;
      effectKind: EffectKind;
      dedupeKey: string;
      lastError?: string | null;
    })
  | (Base & {
      type: 'HumanResolve';
      choice: 'approve' | 'request_changes' | 'apply_recommendation' | 'dismiss';
      reason?: string;
      /** apply_recommendation / request_changes: what the person wants fixed, carried into the fix task. */
      instructions?: string;
      /** approve: the head the person approved. T14's evidence: must equal the live head. */
      commitId?: string;
      /** approve: the person holds merge permission on the repo (T14's evidence). */
      hasMergePermission?: boolean;
    })
  | (Base & { type: 'DeliveryFailed'; reason: string })
  | (Base & {
      type: 'TrunkRedObserved';
      incidentId: string;
      signature: string;
      headSha: string;
      /** Base branch's own head fails the signature, or the multi-delivery threshold is met. */
      thresholdMet: boolean;
    })
  | (Base & { type: 'TrunkRecovered'; incidentId: string; baseStillRed: boolean; headPredatesFix: boolean })
  | (Base & {
      type: 'ReviewRoundFailed';
      roundId: string;
      /** `human_takeover` (a person interrupted the reviewer) escalates at once, never re-queued. */
      reason: 'no_verdict' | 'prose_verdict' | 'infra' | 'human_takeover';
      maxContractRetries: number;
      /**
       * The reviewer task whose run failed. The failure is counted once per
       * reviewer (key `roundfail:{round}:{reviewerTaskId}`), and a reviewer that
       * is not the round's current one is stale. Absent only when the kernel
       * itself could not serve the round (no reviewer was ever asked).
       */
      reviewerTaskId?: string;
    })
  | (Base & {
      /**
       * T28: a preflight finding for ONE head. Head-bound: a finding for any
       * other head than the delivery's current one is stale and changes nothing.
       */
      type: 'PolicyEvidenceRecorded';
      evidence: PolicyEvidence;
    })
  | (Base & {
      type: 'CompositionAttested';
      attestation: CompositionAttestation;
      /** Resolved per constituent by the caller; keyed by roundId. */
      constituents: ConstituentEvidence[];
      factId?: string | null;
    });

export type CommandType = Command['type'];

// ── Decision (§6.1) ─────────────────────────────────────────────────────────

/** Every effect kind the kernel can record (§10.2); a runtime list so the composition root can be checked against it. */
export const EFFECT_KINDS = [
  'dispatch_review', 'dispatch_fix', 'dispatch_ci_fix', 'dispatch_conflict_fix',
  'dispatch_trunk_fix', 'post_review', 'merge_call', 'verify_merge', 'refresh_branch',
  'renumber_migration', 'push_recovery', 'stamp_pr_rows', 'cancel_open_attempts',
  'render_activity', 'notify', 'mission_note', 'wake_mission', 'release_attribution',
  'finalize_mission_pr', 'emit_pr_merged', 'scan_supersession', 'project_supersession',
  'escalate_exhaustion', 'gate_event',
] as const;

export type EffectKind = (typeof EFFECT_KINDS)[number];

export interface EffectSpec {
  kind: EffectKind;
  dedupeKey: string;
  payload: Record<string, unknown>;
  /** Delay before the effect is due, ms. */
  delayMs?: number;
}

export interface DeliveryPatch {
  repoFullName?: string | null;
  prNumber?: number | null;
  baseRef?: string | null;
  stateReason?: string | null;
  currentHeadSha?: string | null;
  currentRound?: number;
  maxRounds?: number;
  boundAttemptId?: string | null;
  resumeState?: DeliveryState | null;
  trunkIncidentId?: string | null;
  approvedHeads?: string[];
  approvalBasis?: ApprovalBasis | null;
  compositionHeads?: string[];
  ci?: string | null;
  ciHeadSha?: string | null;
  mergeable?: string | null;
  mergeableHeadSha?: string | null;
  mergedAt?: string | null;
  mergeCommitSha?: string | null;
  supersededByPr?: number | null;
  supersededByUrl?: string | null;
  supersededReason?: string | null;
  recordedBy?: string | null;
  policyEvidence?: PolicyEvidence | null;
}

export type RoundOp =
  | { op: 'insert'; id: string; round: number; headSha: string; kind: RoundKind; priorRound: number | null; scope?: Record<string, unknown> | null }
  | {
      op: 'update';
      roundId: string;
      whenStatus: RoundStatus[];
      set: {
        status?: RoundStatus;
        verdict?: Verdict | null;
        effectiveVerdict?: Verdict | null;
        confidence?: number | null;
        decided?: boolean;
        failureCount?: number;
        clearReviewer?: boolean;
      };
    };

export type AttemptOp =
  | {
      op: 'insert';
      /** Pre-assigned so the same statement can bind it (delivery.bound_attempt_id) and effects can name it. */
      id: string;
      family: AttemptFamily;
      attemptNo: number;
      mode: AttemptMode;
      boundHeadSha: string | null;
      triggerReason: string | null;
      triggerFactId?: string | null;
      taskId: string | null;
      trigger: 'automatic' | 'human';
      status: AttemptStatus;
      maxAttempts: number;
    }
  | {
      op: 'update';
      attemptId: string;
      whenStatus: AttemptStatus[];
      set: { status?: AttemptStatus; outcome?: AttemptOutcome | null; pushedHeadSha?: string | null; appendReportedSha?: string; ended?: boolean };
    }
  | { op: 'cancel_open'; families: AttemptFamily[]; status: 'cancelled' | 'skipped'; headSha?: string | null };

export interface CurrentView {
  state: DeliveryState | null;
  version: number;
  head: string | null;
  round: number;
}

/** Writes that are recorded even though the delivery does not transition (a stale verdict kept for audit). */
export interface RecordOnly {
  rounds: RoundOp[];
  attempts: AttemptOp[];
}

export interface CreateSpec {
  workspaceId: string;
  ownerTaskId: string;
  maxRounds: number;
}

export interface ApplyDecision {
  result: 'apply';
  command: CommandType;
  idempotencyKey: string;
  /** Present for T1 and T2-adoption: the statement inserts the delivery row. */
  create?: CreateSpec;
  fromState: DeliveryState | null;
  toState: DeliveryState;
  guard: { version: number; states: DeliveryState[]; headSha?: string | null; round?: number };
  patch: DeliveryPatch;
  rounds: RoundOp[];
  attempts: AttemptOp[];
  effects: EffectSpec[];
  evidence: Record<string, unknown>;
  bypass?: Record<string, unknown> | null;
}

export type Decision =
  | ApplyDecision
  | { result: 'duplicate'; reason: string; current: CurrentView }
  | { result: 'stale'; reason: string; current: CurrentView; record?: RecordOnly }
  | { result: 'rejected'; reason: string; missing?: string[]; current: CurrentView; record?: RecordOnly };
