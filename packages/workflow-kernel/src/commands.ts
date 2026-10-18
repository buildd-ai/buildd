/**
 * Kernel commands (docs/specs/workflow-state-kernel.md §6.3, T1–T27) and the
 * reducer's decision shape (§6.1). Every live GitHub read a transition needs
 * is carried IN the command as evidence, so the reducer stays a pure function
 * of (view, command); the caller (fact ingestion, a route) does the read.
 */
import type { BaseDeltaFact } from './base-delta';
import type { DeltaReading, RoundTrigger } from './delta-approval';
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
  FindingStatus,
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
  /** The head branch name, when GitHub reported it. A repair attempt resumes on exactly this branch. */
  headRef?: string | null;
  baseRef: string | null;
  mergedAt?: string | null;
  mergeCommitSha?: string | null;
  updatedAt?: string | null;
  /** GitHub's `mergeable_state` at read time (`clean`, `dirty`, `behind`, `blocked`, `unstable`, `draft`, `unknown`, ...). */
  mergeableState?: string | null;
  /** A draft PR (GitHub refuses to merge it); present only when true. */
  draft?: boolean;
  /** Who GitHub says merged it (`merged_by.login`), when it is merged and GitHub said. */
  mergedBy?: string | null;
}

/**
 * One finding as a reviewer states it (docs/specs/workflow-kernel-library.md §5).
 * `id` names a finding an earlier round raised that this round restates (it
 * keeps its identity and is open again); without one it is new.
 */
export interface FindingInput {
  id?: string | null;
  path?: string | null;
  line?: number | null;
  title: string;
  /** Default true: a request for changes blocks landing. */
  required?: boolean;
}

/** What a verdict says about the delivery's findings, beside the verdict itself. */
export interface VerdictFindings {
  /** The findings this round raises or restates. A request for changes with none is one finding naming the round. */
  findings?: FindingInput[];
  /**
   * The open findings this round verified as resolved at its head. Absent (a
   * reviewer that does not report findings) on an approval of an unscoped
   * round: every open finding was in its brief, so the approval verifies them
   * all. Present: exactly these, and an approval that leaves a required
   * finding unverified is not an approval of the head.
   */
  resolvedFindings?: string[];
  /** Open findings this round defers to a named task, with why. */
  deferredFindings?: Array<{ id: string; taskId?: string | null; reason: string }>;
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
       * edc02148: the fact layer compared the PR's diff from the approved previous head to
       * this one and it differs. A queued refresh is credited with any descending push, so
       * this, not attribution, decides whether its approval may carry (T13).
       */
      diffChanged?: boolean;
      /**
       * §6.9 provenance input from the compare API: does the live head descend
       * from the bound attempt's head? Combined with the attempt's own
       * reported_shas and its running status, never with a commit author.
       */
      attribution?: { descendsFromBound: boolean };
      /**
       * §5: the paths the PR's diff changed between the head the delivery held
       * and this one (a compare read). A finding whose path is among them is
       * `addressed`. Absent or null (unread) addresses nothing.
       */
      changedPaths?: string[] | null;
      /**
       * 58c8961e: the delta from the approved head to this one, bounded against the base,
       * when the head moved under a reviewer's approval. Decides whether the round that
       * follows may be a delta review (deltaApprovalEligibility); absent is a full review.
       */
      delta?: DeltaReading | null;
      /**
       * AC-79 (workflow-kernel-library.md §5): the move from the head the delivery held to this
       * one brought only base commits. `own_refresh`: the platform's own `refresh_branch`,
       * pinned to the held head, updated the branch. `compare`: the PR's diff against the base
       * is the same at both heads. While a review fix runs, such a push is foreign: it is never
       * credited to the fix (§6.9). Absent is unread, never "the fix's".
       */
      baseOnly?: 'own_refresh' | 'compare' | null;
    })
  | (Base & {
      /**
       * AC-1 slice 7 (workflow-kernel-library.md §9): a claim starts the owner attempt of a
       * delivery's task. The claim route's own compare-and-set already decided the race (only a
       * pending task, only one claimer: it stamped claimed_by / claimed_at and nothing else); the
       * kernel moves the task to `assigned` in the transition's own statement, only while the task
       * still carries that exact claim. Not an end and no state change: the delivery keeps its state.
       */
      type: 'AttemptStarted';
      /** The owner task being started. */
      taskId: string;
      /** The account whose claim won (tasks.claimed_by). */
      claimedBy: string;
      /** The claim's stamp, tasks.claimed_at as Postgres renders it (microseconds kept): the claim's identity and key. */
      claimedAt: string;
    })
  | (Base & {
      type: 'AttemptEnded';
      /** The worker row whose exit this is: one task can run several workers (retries). */
      workerId: string;
      /** Owner attempts are named by task id; repair attempts by workflow_attempts id. */
      taskId?: string;
      attemptId?: string;
      outcome: 'success' | 'failed' | 'lost' | 'unproven';
      /**
       * 295486ba: the end is the attempt's task being cancelled (a person, or the platform),
       * not a run that stopped. A CI repair cancelled while still queued (never claimed) with
       * nothing local did no work, so it spends nothing (skipped). Absent = a run's end.
       */
      cancelled?: boolean;
      localHeadSha: string | null;
      commitCount: number;
      live: LivePr | null;
      proof?: { liveContainsLocal: boolean; contentDiffChanged?: boolean };
      carryForward?: 'content_equivalent' | 'own_refresh' | null;
      /** 58c8961e: as HeadObserved's `delta`, for the head the attempt delivered. */
      delta?: DeltaReading | null;
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
      /** §5: the paths changed between the repair's bound head and the live head (a compare read); absent = unread. */
      changedPaths?: string[] | null;
      /**
       * §13.13 rule 4: a review fix that changed nothing because the findings' condition is
       * already absent at the head, with what it read. Never a resolution on its own: a
       * verification round at the same head decides.
       */
      noopEvidence?: { findingIds: string[]; evidence: string } | null;
      /**
       * AC-79 (workflow-kernel-library.md §5): a review fix's end, read by the fact layer: the
       * PR's diff at the live head, against the base, is the diff at the head the fix was bound
       * to. Whatever moved the head since brought only base commits (a merge of the base), so
       * nothing on it is the fix's own work. Absent or false (unread, or the diff changed) is
       * not this fact.
       */
      baseOnly?: boolean;
    })
  | (Base & {
      /**
       * AC-1 slice 6 (workflow-kernel-library.md §9): an attempt's task goes back to the queue
       * (a retry, a loop hold, a budget or credential wall, a stalled repair recovered). Not an
       * end: the attempt's work is retried on the same task, and the delivery does not move. The
       * kernel records it and moves the task to `pending` in the transition's own statement, only
       * while the requeuing worker is the task's current attempt. Named like AttemptEnded: an
       * owner attempt by task id, a repair attempt by its workflow_attempts id.
       */
      type: 'AttemptRequeued';
      /** The worker row whose attempt is requeued: its current-attempt check, and the idempotency key. */
      workerId: string;
      taskId?: string;
      attemptId?: string;
      /** Why (a short tag: `retry`, `loop_hold`, `budget`, `codex_deferral`, `conflict_recovery`, ...). */
      reason: string;
    })
  | (Base & {
      /**
       * AC-1 slice 9 (workflow-kernel-library.md §9): the owner task's attempt already ended (the
       * task is completed or failed) and the task is opened again. `pending` puts it back in the
       * queue for a new attempt (a credential, GitHub access or incident recovery requeues a task
       * that failed); `assigned` is the same worker running again (a person's follow-up resumed a
       * finished session). Not a requeue (that names a current attempt) and no state change: the
       * kernel records it and moves the task in the transition's own statement, only while the
       * named worker is still the task's latest attempt and its end is the one named.
       */
      type: 'AttemptReopened';
      taskId: string;
      /** The worker row of the ended attempt it reopens; null when the task never ran one. */
      workerId: string | null;
      /** When that attempt ended (its worker's completed_at, ISO): each reopen of one worker is its own key. */
      endedAt: string | null;
      to: 'pending' | 'assigned';
      /** Why (a short tag: `credential_restored`, `repo_access_verified`, `incident_recovery`, `resumed`). */
      reason: string;
    })
  | (Base & {
      /**
       * AC-1 slice 9: a claim that does not go on to run the owner task's attempt. With `claim`,
       * the claim's own start is given back (`requeued`: the account cap refused its worker, or a
       * cleanup found the claim with no attempt row) or ended for good (`failed`). With no claim,
       * a queued task that no claim holds is refused for good (`failed`: the workspace lacks the
       * project it is pinned to, or a sandbox mount gap ran its mission out of budget). No attempt
       * ran under it, so it is no end; no state change. The kernel records it and moves the task in
       * the transition's own statement, only while the task still carries exactly that claim (or,
       * with no claim, is still queued with no live attempt).
       */
      type: 'AttemptWithdrawn';
      taskId: string;
      /** tasks.claimed_by and tasks.claimed_at as Postgres renders it (microseconds kept), or null. */
      claim: { claimedBy: string; claimedAt: string } | null;
      outcome: 'requeued' | 'failed';
      /** Why (a short tag: `account_cap`, `orphaned_claim`, `retry_cap`, `workspace_mismatch`, `mission_budget`). */
      reason: string;
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
      /**
       * The commit the reviewer's checkout was at when it judged (`git rev-parse HEAD`).
       * Only a verdict read at the round's own head decides it: any other commit (or
       * `null`, none reported) is inconclusive, never an approval, and fails the round
       * as T27 does. Absent = a caller that does not attest it.
       */
      evidenceSha?: string | null;
      /** The reviewer that judged: one inconclusive verdict per reviewer spends the round's budget. */
      reviewerTaskId?: string;
      /** T27's budget for an inconclusive verdict. Absent = 0: it escalates at once. */
      maxContractRetries?: number;
    } & VerdictFindings)
  | (Base & {
      /**
       * 00d288fd: the verdict of a reviewer that ran outside the kernel's rounds (filed
       * before the delivery opened, by a door that raced it) on a PR the kernel owns. It is
       * the verdict on `headBound` when that is the current head: kept while the owner
       * still works and applied when it ends, so the same head is never reviewed twice.
       */
      type: 'ReviewVerdictAdopted';
      reviewerTaskId: string;
      verdict: Verdict;
      effectiveVerdict: Verdict;
      headBound: string;
      confidence?: number | null;
      /** As T6's: a verdict read at any other commit than `headBound` is never adopted. */
      evidenceSha?: string | null;
    } & VerdictFindings)
  | (Base & {
      /**
       * §5: a person waives a finding, or defers it to a named task. Recorded with
       * who and why; it closes the finding and nothing else.
       */
      type: 'FindingDisposed';
      findingId: string;
      disposition: 'waived' | 'deferred';
      reason: string;
      deferredToTaskId?: string | null;
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
      /**
       * 38442d17: CI went green on `headSha` (every check completed, none failing), read
       * live. A CI repair bound to that same head has nothing left to fix (a re-run of an
       * infrastructure failure passed): its attempt is cancelled, spending nothing when it
       * never started, and the delivery returns to what the head was owed before.
       */
      type: 'CiGreenObserved';
      headSha: string;
      liveChecks: { complete: boolean; failing: string[] };
      /**
       * The host read every check suite on the head as passed (an allow-list of passing
       * conclusions), not merely "nothing failed": a cancelled, stale or action-required
       * run is not green. Absent or false is refused.
       */
      allPassing?: boolean;
    })
  | (Base & {
      /**
       * 6900a317: the CI reading on the current head, recorded as a fact without moving
       * the delivery. T10 and the repair-ending green act on a reading; this only keeps
       * `ci`/`ciHeadSha` true when they did not (no repair to end, a fix still in flight,
       * a state CI does not move), so a head with a failed check never reads "Checking"
       * and a green head never stays "Checking" either. Read live by the host, with
       * superseded re-runs dropped: `red` needs a failing run, `green` needs every run
       * complete, none failing, and every suite passed (`allPassing`). `running` (nothing
       * failing, not every run finished) withdraws an earlier red on the same head: the run
       * that failed was re-run and the head is being checked again.
       */
      type: 'CiObserved';
      headSha: string;
      verdict: 'red' | 'green' | 'running';
      liveChecks: { complete: boolean; failing: string[] };
      allPassing?: boolean;
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
      /**
       * S15, behind only: what the base gained since this head, read live by the seam
       * (`observeConflict`). With it, an approved head whose base delta passes the
       * disjoint-delta rule (base-delta.ts) is not refreshed or escalated:
       * `rejected(behind_tolerated)` and a door lands it (T15 checks the same fact
       * again at merge time). Absent: the treadmill as before.
       */
      baseDelta?: BaseDeltaFact | null;
      /** The ordinary commit bound for a platform-refreshed head (`treadmillMaxBaseCommits`). */
      maxBaseCommits?: number;
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
      /**
       * What a door's own rails said, when it reports them. Never trusted as a
       * pass: the `merge_call` effect evaluates the rails itself against a fresh
       * read (the `rails` port, workflow-kernel-library.md §4). A door that reports
       * a refusal is still refused here.
       */
      rails?: { passed: boolean; redCi?: boolean; denyPaths?: boolean; reasons?: string[] };
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
      /**
       * S15: the door saw the head behind its base and asks to land it anyway
       * under the disjoint-delta rule. The base delta read live at landing time;
       * T15 lands only if the rule still holds (`rejected(behind_not_tolerated)`
       * otherwise, and the door refreshes). Absent: the door's own freshness rail
       * decided, as before. A freshness override skips it.
       */
      baseDelta?: BaseDeltaFact | null;
      maxBaseCommits?: number;
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
      outcome: 'merged' | 'indeterminate' | 'behind' | 'conflict' | 'refused' | 'not_merged' | 'gate_refused' | 'held';
      detail?: string;
      /**
       * `held`: GitHub would not merge yet because a required check has not passed
       * (§4, merge holds). The merge effect waits on it itself; this is applied only
       * when it stops waiting: `lasting` (the hold outlived its bound, or the check is
       * one only a person can now pass) escalates naming `check`, otherwise the
       * approval stands and a door or the sweep asks again.
       */
      hold?: { check: string | null; heldForMs?: number | null; lasting?: boolean };
      /**
       * `gate_refused`: the landing gate, asked again when the merge effect ran,
       * refused before any merge call (§4): which half refused and why. The
       * approval stands only when the review half still passes.
       */
      gate?: { half: 'review' | 'rails'; reasons: string[]; lasting?: boolean };
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
      reason: 'no_verdict' | 'prose_verdict' | 'infra' | 'human_takeover' | 'evidence_not_at_head';
      maxContractRetries: number;
      /**
       * The reviewer task whose run failed. The failure is counted once per
       * reviewer (key `roundfail:{round}:{reviewerTaskId}`), and a reviewer that
       * is not the round's current one is stale. Absent only when the kernel
       * itself could not serve the round (no reviewer was ever asked).
       */
      reviewerTaskId?: string;
      /** How long the re-queued round waits before its dispatch runs again (a reviewer that could not be filed). Absent = at once. */
      retryDelayMs?: number;
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
  'escalate_exhaustion', 'gate_event', 'capture_ci_evidence',
  'publish_landing_status', 'dispatch_external_merge_fix',
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
  | {
      op: 'insert'; id: string; round: number; headSha: string; kind: RoundKind; priorRound: number | null; scope?: Record<string, unknown> | null;
      /** Why the round started (58c8961e); persisted with the round. */
      trigger?: RoundTrigger;
      /** 00d288fd: a round inserted already decided (a reviewer outside the kernel's rounds, adopted at the head it judged). */
      decided?: { verdict: Verdict; effectiveVerdict: Verdict; confidence: number | null; reviewerTaskId: string };
    }
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
        /** Why a round ended without its own verdict (a supersession), persisted with the round. */
        endReason?: string;
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

/** §5 finding writes, applied in the transition's statement. At most one op per finding per decision. */
export type FindingOp =
  | {
      op: 'insert';
      id: string;
      originRoundId: string;
      originRound: number;
      originHeadSha: string;
      ordinal: number;
      path: string | null;
      line: number | null;
      title: string;
      required: boolean;
    }
  | {
      op: 'update';
      findingId: string;
      whenStatus: FindingStatus[];
      set: {
        status?: FindingStatus;
        lastRound?: number;
        title?: string;
        required?: boolean;
        addressedBySha?: string | null;
        closedByRoundId?: string | null;
        closedBy?: string | null;
        closedReason?: string | null;
        deferredToTaskId?: string | null;
      };
    };

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
  findings?: FindingOp[];
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
  /** §5 finding writes (absent = none). */
  findings?: FindingOp[];
  effects: EffectSpec[];
  evidence: Record<string, unknown>;
  bypass?: Record<string, unknown> | null;
}

export type Decision =
  | ApplyDecision
  | { result: 'duplicate'; reason: string; current: CurrentView }
  | { result: 'stale'; reason: string; current: CurrentView; record?: RecordOnly }
  | { result: 'rejected'; reason: string; missing?: string[]; current: CurrentView; record?: RecordOnly };
