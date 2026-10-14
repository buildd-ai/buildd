/**
 * The kernel's ports (docs/specs/workflow-kernel-library.md §2): the
 * interfaces a host implements so the kernel can run without knowing what its
 * store, GitHub client, scheduler, notifier or model layer are.
 *
 * Every port is data in, data out. Nothing here names a table, a driver or an
 * HTTP client: buildd's Postgres adapter (apps/web/src/lib/workflow/
 * postgres-store.ts) keeps today's SQL statements, and the in-memory adapters
 * under ./memory reproduce their CAS and uniqueness rules for the conformance
 * suite.
 *
 * Versioned with the package: a breaking change to a port is a major bump.
 */
import type { BaseDeltaFact } from './base-delta';
import type { ApplyDecision, Command, CurrentView, EffectKind, LivePr, RecordOnly } from './commands';
import type { AttemptSnapshot, DeliverySnapshot, DeliveryState, KernelView, RoundSnapshot } from './types';

/**
 * 2: `Work` files under the kernel's own id and can skip, cancel what is
 * pending and steer a filed task; `Store.linkAttemptTask` and
 * `linkRoundReviewer`; `Notify.team` carries the PR and a link;
 * `GithubWrites.postReview` says whether the review went up; the effect
 * snapshot carries the delivery's own authority and workspace, and the drain
 * reads the kill switch from `Policy`; the `Trunk`, `Escalate`, `Evidence`,
 * `Reviews`, `Conflicts` and `HandOff` ports.
 */
export const PORTS_VERSION = 2;

// ── References and results shared by the store and the command runner ──────

export type DeliveryRef =
  | { deliveryId: string }
  | { workspaceId: string; ownerTaskId: string }
  | { workspaceId: string; repoFullName: string; prNumber: number };

export type CommandResult =
  | { result: 'applied'; transitionId: string; deliveryId: string; version: number; decision: ApplyDecision }
  | { result: 'duplicate'; transitionId: string | null; reason: string; current: CurrentView }
  | { result: 'stale'; reason: string; current: CurrentView }
  | { result: 'rejected'; reason: string; missing?: string[]; current: CurrentView };

/**
 * What one transition write answered. `conflict` means nothing was written:
 * `guard` = the CAS guard (version, allowed states, bound head or round, the
 * kernel still owning the delivery) did not match, or a creating write found
 * the delivery already there; `unique` = a uniqueness rule (a replayed
 * idempotency key, a racing single-flight insert) aborted the whole write.
 * Either way the caller re-reads and decides again.
 */
export type TransitionWrite =
  | { status: 'applied'; transitionId: string; deliveryId: string; version: number }
  | { status: 'conflict'; cause: 'guard' | 'unique' };

// ── Effects ─────────────────────────────────────────────────────────────────

/**
 * Who decides for the delivery, as a handler sees it: `kernel`, `legacy`
 * (released), or `switched_off` (a kernel row whose workspace's kill switch is
 * off, read from `Policy` by the drain, which releases it before acting).
 */
export type EffectAuthority = 'kernel' | 'legacy' | 'switched_off';

/**
 * What a drain re-checks before acting (§10.4): the delivery, the authority
 * its own row records, and the queuing transition. The store never reads the
 * kill switch: the drain asks `Policy` for the delivery's workspace.
 */
export interface EffectSnapshot {
  delivery: { state: DeliveryState; version: number; workspaceId?: string | null } | null;
  transition: { toState: DeliveryState; toVersion: number } | null;
  authority?: EffectAuthority;
}

export interface ClaimedEffect extends EffectSnapshot {
  id: string;
  deliveryId: string;
  transitionId: string;
  kind: EffectKind;
  dedupeKey: string;
  payload: Record<string, unknown>;
  attemptCount: number;
}

export interface FollowupEffect {
  deliveryId: string;
  transitionId: string;
  kind: EffectKind;
  dedupeKey: string;
  payload: Record<string, unknown>;
  delayMs?: number;
}

// ── Facts ───────────────────────────────────────────────────────────────────

export interface FactInsert {
  workspaceId: string;
  kind: string;
  factKey: string;
  source: string;
  repoFullName?: string | null;
  prNumber?: number | null;
  payload: Record<string, unknown>;
}

export interface StoredFact {
  id: string;
  appliedTransitionId: string | null;
  payload: Record<string, unknown>;
}

// ── Landing lane ────────────────────────────────────────────────────────────

export interface LaneKey { repoFullName: string; baseRef: string }

// ── Store ───────────────────────────────────────────────────────────────────

/**
 * The kernel's statements. Each method is one statement in the Postgres
 * adapter and one all-or-nothing step in memory; none is a transaction the
 * caller holds open. Time inside a statement (`now()`, a lease, a backoff)
 * is the store's own clock.
 */
export interface Store {
  /** Everything the reducer needs for one delivery; a missing delivery is `{ delivery: null, rounds: [], attempts: [] }`. */
  loadView(ref: DeliveryRef): Promise<KernelView>;
  /** The transition already written under this idempotency key, if any. */
  findTransition(deliveryId: string, idempotencyKey: string): Promise<{ id: string } | null>;
  /**
   * Apply one decision: the delivery CAS (or the insert that opens it), the
   * transition row, its effects (idempotent on dedupe key), round and attempt
   * writes and the fact link, all or nothing.
   */
  applyTransition(decision: ApplyDecision, ref: { deliveryId: string | null; factId?: string | null }): Promise<TransitionWrite>;
  /** Audit writes kept when no transition applies (a stale verdict, a skipped fix). */
  recordOnly(deliveryId: string, record: RecordOnly): Promise<void>;

  /** Record a fact once under its natural key; null when the key was already recorded. */
  insertFact(fact: FactInsert): Promise<{ id: string } | null>;
  findFact(workspaceId: string, factKey: string): Promise<StoredFact | null>;

  /** Claim due (and lease-expired) effects, oldest first, each leased for `leaseMs` with its attempt counted. */
  claimDueEffects(opts: { limit: number; leaseMs: number; deliveryId?: string | null }): Promise<ClaimedEffect[]>;
  /** Renew one claimed row's lease while this attempt holds it; the snapshot is read now. null = another drain holds it. */
  renewEffectLease(id: string, attemptCount: number, leaseMs: number): Promise<EffectSnapshot | null>;
  /** Settle the attempt that ran. false = the row is no longer this attempt's. */
  ackEffect(id: string, attemptCount: number, outcome: string): Promise<boolean>;
  /** Back off (effects.ts `effectRetry`) or go dead. null = the row is no longer this attempt's. */
  failEffect(id: string, attemptCount: number, error: string): Promise<'pending' | 'dead' | null>;
  /** Bind a ledger row to the task filed for it, once: a row already bound keeps its task. */
  linkAttemptTask(attemptId: string, taskId: string): Promise<void>;
  /** Bind a review round to its reviewer task, once. */
  linkRoundReviewer(roundId: string, taskId: string): Promise<void>;
  /** Back to pending after `delayMs`, handing the attempt back (a wait is not a failure). */
  parkEffect(id: string, attemptCount: number, outcome: string, delayMs: number): Promise<boolean>;
  /** A follow-up of an effect still running its course; idempotent on its own dedupe key. */
  insertFollowupEffect(effect: FollowupEffect): Promise<boolean>;
  /** §14: hand a kernel delivery to legacy. false = it was not the kernel's. */
  releaseToLegacy(deliveryId: string): Promise<boolean>;

  /** Take the lane, or renew it for its holder. true only when this delivery holds it afterwards. */
  acquireLane(k: LaneKey & { deliveryId: string; headSha: string; holdMs: number }): Promise<boolean>;
  laneHolder(k: LaneKey): Promise<{ deliveryId: string; prNumber: number | null } | null>;
  /** Drop the lanes this delivery holds nothing in any more; returns them. */
  releaseSettledLanes(deliveryId: string): Promise<LaneKey[]>;
  /** Make the oldest parked refresh on this lane due now; returns its delivery. */
  wakeNextLaneWaiter(k: LaneKey): Promise<string | null>;
}

// ── GitHub ──────────────────────────────────────────────────────────────────

/** Live reads the kernel acts on (R2: never a webhook payload). Every optional read answers null when it cannot tell. */
export interface GithubFactReader {
  /** Live `GET /repos/{repo}/pulls/{n}`; null when it cannot be read. */
  readPr(repoFullName: string, prNumber: number): Promise<LivePr | null>;
  /** Compare API: is `ancestorSha` contained in `headSha`? */
  contains?(repoFullName: string, ancestorSha: string, headSha: string): Promise<boolean>;
  /**
   * Is CI green on `headSha` now (every check suite completed, none failing)?
   * null = unknown (still running, no suites, unreadable): never read as green.
   */
  ciGreen?(repoFullName: string, headSha: string): Promise<boolean | null>;
  /**
   * The check runs on `sha` (§6.10 signatures): the names of the failing ones,
   * and whether every run has completed. null = unreadable.
   */
  checkRuns?(repoFullName: string, sha: string): Promise<{ complete: boolean; failing: string[] } | null>;
  /** The head commit of branch `ref` now; null = unreadable. */
  branchHead?(repoFullName: string, ref: string): Promise<string | null>;
  /**
   * Names of the checks and workflows that failed on `headSha` (§6.10: a CI
   * failure a preflight would have caught is tagged `preflight_miss`).
   * null = unreadable; never read as "nothing failed".
   */
  failingChecks?(repoFullName: string, headSha: string): Promise<string[] | null>;
  /**
   * §8.3 content-equivalence: does the PR carry the same change at `toSha` as
   * at `fromSha`, each compared against `baseRef`? null = could not tell;
   * never read as equivalent.
   */
  contentEquivalent?(repoFullName: string, baseRef: string, fromSha: string, toSha: string): Promise<boolean | null>;
  /**
   * A retarget's evidence: is the PR's diff at `headSha` against `toBase` the same
   * change as against `fromBase`? null = could not tell; never read as equivalent.
   */
  baseDiffEquivalent?(repoFullName: string, fromBase: string, toBase: string, headSha: string): Promise<boolean | null>;
  /**
   * Does branch `ref` exist in `repoFullName` now? A PR GitHub closed because
   * its base branch was deleted is `CLOSED_UNMERGED(base_deleted)` (§4).
   * null = unreadable; never read as "deleted".
   */
  branchExists?(repoFullName: string, ref: string): Promise<boolean | null>;
  /**
   * S15's base delta: the commits the base `baseRef` has that `headSha` does not,
   * the files they changed, and the files the PR changes. A side that cannot be
   * read or listed in full is null; never read as "nothing changed".
   */
  baseDelta?(repoFullName: string, prNumber: number, headSha: string, baseRef: string): Promise<BaseDeltaFact | null>;
}

/** GitHub's answer to a pinned merge call, read as the T16 outcome it is (`MergeCallResult`). */
export type MergeCallOutcome = Extract<Command, { type: 'MergeCallResult' }>['outcome'];

export interface MergeAnswer {
  outcome: MergeCallOutcome;
  /** What GitHub said, recorded on the transition. */
  detail?: string;
  /** A transient answer (rate limit, 5xx): when GitHub said to call again (ISO); null or absent = no wait asked. */
  retryAt?: string | null;
}

export interface PostedReview {
  id: string | null;
  posted?: boolean;
  reason?: string;
  commentedOwnPr?: boolean;
}

/** The writes the kernel's effects make on GitHub. Each is idempotent at the host or keyed by the effect. */
export interface GithubWrites {
  /**
   * Merge only if the PR's head is still `headSha`. The host reads GitHub's
   * answer into the outcome (a moved head or a rate limit is `not_merged`, a
   * lost or 5xx answer `indeterminate`, an out-of-date branch `behind`); the
   * kernel verifies anything but a definite refusal with a live read.
   */
  mergeAtHead(p: { repoFullName: string; prNumber: number; headSha: string; method?: 'squash' | 'merge' | 'rebase' }): Promise<MergeAnswer>;
  /**
   * A review at `commitId`. `posted: false` with GitHub's reason when it did not
   * go up (a matching review for the commit already exists is one such reason);
   * `commentedOwnPr` when the host posted a verdict on its own PR as a comment.
   */
  postReview(p: { repoFullName: string; prNumber: number; commitId: string; event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'; body: string }): Promise<PostedReview>;
  publishStatus(p: { repoFullName: string; sha: string; context: string; state: 'pending' | 'success' | 'failure' | 'error'; description: string; targetUrl?: string | null }): Promise<void>;
  /** Create or update the comment carrying `marker` on the PR. */
  upsertComment(p: { repoFullName: string; prNumber: number; marker: string; body: string }): Promise<{ id: string | null }>;
  deleteBranch(p: { repoFullName: string; ref: string }): Promise<void>;
}

export interface GithubFacts extends GithubFactReader {
  writes?: GithubWrites;
}

// ── Clock ───────────────────────────────────────────────────────────────────

/** ISO-8601 now. Statement time inside the Postgres store stays SQL `now()`. */
export interface Clock {
  now(): string;
}

// ── Work ────────────────────────────────────────────────────────────────────

export interface WorkRequest {
  /** The role the task runs as (a reviewer, a fixer, a conflict resolver, `ci_fix`, `trunk_fix`...). */
  role: string;
  /** How the kernel words the task, when it does; else the host's builder for `role` words it. */
  title?: string;
  description?: string;
  workspaceId: string;
  /**
   * The id to file the task under (the kernel's ledger id, so a redelivery
   * finds the first one). Absent = the host's own id.
   */
  taskId?: string;
  /** What the task acts on: the PR and the head it was dispatched for (a trunk fix has no PR). */
  target: { repoFullName: string; prNumber?: number | null; headSha?: string | null; baseRef?: string | null };
  /** Where it comes from: the delivery, the attempt and the task it continues. */
  lineage: { deliveryId: string; attemptId?: string | null; parentTaskId?: string | null };
  /** Idempotency: filing the same key twice returns the first task. */
  dedupeKey: string;
  /** What the kernel knows that the host's builder needs (the attempt number and cap, who triggered it, the incident...). */
  detail?: Record<string, unknown>;
}

/** `WorkFiled.skipped` when the host has no role that can run the work: the kernel reads it (a review round fails, T27). */
export const NO_ROLE = 'no_role';

export interface WorkFiled {
  /** null only when nothing was filed (`skipped`). */
  taskId: string | null;
  /** false = a task already existed under the id or key (a redelivery, or the host adopted a live one), or `skipped`. */
  created: boolean;
  /** Nothing filed and nothing owed now (the host lacks what the task needs): why. `NO_ROLE` is the one reason the kernel acts on. */
  skipped?: string;
  /** Which shape the host filed, when it has more than one (`diagnose` for a CI fix that only diagnoses). */
  variant?: string;
  /**
   * Evidence the host still has to capture for the task: the kernel owes it as
   * a follow-up effect. Also answered for a task filed before (a run that
   * crashed before the kernel bound its row), which is owed it just the same.
   */
  evidence?: Record<string, unknown>;
}

/** The host's scheduler (in buildd: a task insert plus `announceTaskCreated`). */
export interface Work {
  file(req: WorkRequest): Promise<WorkFiled>;
  wake(taskId: string, reason: string): Promise<void>;
  cancel(taskId: string, reason: string): Promise<void>;
  /** Cancel the delivery's tasks of `role` nobody started (all but `keepTaskId`); returns how many. */
  cancelPending(p: { deliveryId: string; role: string; reason: string; summary: string; keepTaskId?: string | null }): Promise<number>;
  /** Tell a filed task (and whoever runs it now) what it was not filed with. Idempotent per `marker`. */
  steer(taskId: string, p: { marker: string; note: string }): Promise<void>;
}

// ── Notify ──────────────────────────────────────────────────────────────────

export interface TeamNotice {
  workspaceId: string;
  deliveryId: string;
  kind: string;
  title: string;
  body?: string;
  prNumber?: number | null;
  url?: string;
  urlTitle?: string;
}

export interface Notify {
  /**
   * Re-render the delivery's activity comment from the transition log, at
   * `version` (the view the kernel read, when it has one). The kernel owes a
   * follow-up render itself if the delivery moved on meanwhile; the answer is
   * the effect's outcome (`ok:created`, `skipped:older_version`, ...).
   */
  activity(p: { deliveryId: string; version: number; view?: KernelView }): Promise<{ outcome: string } | void>;
  /** A team notification about a delivery. `kind` is the host's alert kind; one it does not know is an error. */
  team(p: TeamNotice): Promise<void>;
}

// ── Policy ──────────────────────────────────────────────────────────────────

export type LandingLaneMode = 'off' | 'shadow' | 'enforce';

/** The per-workspace knobs the kernel reads, passed in: never queried from a host table inside a kernel step. */
export interface KernelPolicy {
  /** §14 kill switch: false hands every delivery in the workspace to legacy on its next touch. */
  kernelEnabled: boolean;
  landingLane: LandingLaneMode;
  maxRounds: number;
  maxConflictIterations: number;
}

export interface Policy {
  forWorkspace(workspaceId: string): Promise<KernelPolicy>;
}

// ── Decide (optional) ───────────────────────────────────────────────────────

/** A host decider's answer at a named decision point. */
export interface DecideAnswer {
  verdict: string;
  /** 0..1 */
  confidence: number;
  reason: string;
}

/**
 * Optional model-backed judgment (§2 "Decide"). A host may omit it; every
 * decision point has a deterministic default in the package (decide.ts), and
 * the kernel never needs an answer to progress. Called only from the command
 * and effect layer through `decideAt`, never from the reducer or a gate check.
 */
export interface Decide {
  /** Recorded on every decision fact. */
  id: string;
  decide(point: string, input: Record<string, unknown>): Promise<DecideAnswer | null>;
}

// ── Ingest ──────────────────────────────────────────────────────────────────

/** A fact an effect observed on a live read and hands to the ingest funnel. */
export interface IngestFact {
  kind: 'pr_closed' | 'head_observed';
  workspaceId: string;
  source: string;
  repoFullName: string;
  prNumber: number;
}

/**
 * The ingest funnel (record the fact once, apply the command it maps to). Still
 * the host's: buildd's `ingestFact` sequences its statements in apps/web until
 * the funnel moves into the package. `github` is the read the fact was taken
 * from, so the funnel acts on that read rather than taking another.
 */
export interface Ingest {
  ingest(fact: IngestFact, github: GithubFactReader): Promise<{ result: string }>;
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

/**
 * What the host does at a delivery's lifecycle points, which the kernel
 * orders but cannot know: its own records of the outcome and the work that
 * follows. The kernel decides when (the effect, after the transition) and
 * re-checks the delivery first; the host does the what.
 */
export interface Lifecycle {
  /**
   * T20/T21: project the resolution onto the host's records of the PR (in
   * buildd: every unmerged worker row of it), never overwriting one already
   * recorded. Returns how many records changed.
   */
  projectResolution(d: DeliverySnapshot, resolution: 'superseded' | 'abandoned'): Promise<number>;
  /**
   * T18: look for where a closed, unmerged PR's work landed. Detection only
   * nominates: an edge it can prove comes back as a command. null = nothing to
   * scan from (no record of the PR's author); else the scan's outcome.
   */
  scanSupersession(d: DeliverySnapshot): Promise<string | null>;
  /** Whatever coordinates the owner task may act now (in buildd: wake its mission). null = nothing coordinates it. */
  wakeCoordinator(d: DeliverySnapshot, reason: 'pr_resolved'): Promise<{ woken: boolean; reason?: string } | null>;
  /** T17's once-per-merge work (the post-merge events). false = no record of the PR's author to run it for. */
  merged(d: DeliverySnapshot): Promise<boolean>;
  /** After a merge, tidy what the delivery leaves on the host (in buildd: delete a shipped mission branch). */
  finalizeMerge(d: DeliverySnapshot): Promise<void>;
}

// ── Trunk ───────────────────────────────────────────────────────────────────

/** One red base's incident (§6.10), as the host's ledger holds it. */
export interface TrunkIncident {
  id: string;
  workspaceId: string;
  repoFullName: string;
  baseRef: string;
  /** `ci:<check>|<check>` (`signatureChecks`). */
  signature: string;
  status: string;
  fixTaskId: string | null;
  affectedDeliveries: string[];
}

/**
 * The trunk circuit breaker's incident ledger. Still the host's: buildd's
 * `trunk_incidents` rows are opened and joined by its ingest funnel.
 */
export interface Trunk {
  incident(id: string): Promise<TrunkIncident | null>;
  /**
   * The trunk-fix task this incident belongs to: one per red base, so the
   * oldest unresolved incident on the base whose fix is not finished. null =
   * the incident is its own.
   */
  fixAnchor(incidentId: string): Promise<{ taskId: string; incidentId: string; fixSignature: string | null } | null>;
  /** Record the incident's fix task (only while it has none, is unresolved, and the task exists). */
  linkFix(incidentId: string, taskId: string): Promise<void>;
  /** The host's signature of the checks failing now, in `signatureChecks` form. */
  signatureOf(failing: string[]): string;
}

// ── Escalate ────────────────────────────────────────────────────────────────

/** A repair family ran out (or is off): a person owns the delivery now. */
export interface ExhaustionNotice {
  family: string;
  headSha: string;
  attempts: number;
  max: number;
  /** The kernel's words for why. */
  title: string;
  detail: string;
  /** What the last reviewer asked for, when the family is the review loop's. */
  note?: string | null;
}

export interface Escalate {
  /** Hand the delivery to a person (in buildd: mark the owner, notify, a mission note). Returns the outcome. */
  exhausted(d: DeliverySnapshot, n: ExhaustionNotice): Promise<string>;
}

// ── Evidence ────────────────────────────────────────────────────────────────

/** Capture run evidence the host keeps (a CI job log); never throws for a capture that failed. */
export interface Evidence {
  capture(p: { kind: string; workspaceId: string; deliveryId: string; payload: Record<string, unknown> }): Promise<{ status: string; record?: Record<string, unknown> }>;
}

// ── Reviews ─────────────────────────────────────────────────────────────────

/** A reviewer's structured output for a round: the raw fact its verdict came from. */
export interface ReviewOutput {
  verdict?: string;
  confidence?: number;
  summary?: string;
  feedback?: string | null;
  escalationReason?: string | null;
}

/** The host's half of the review loop: what a reviewer said, and what only the host can record or check. */
export interface Reviews {
  /** The round's reviewer output; `{}` when it has none. */
  output(round: RoundSnapshot): Promise<ReviewOutput>;
  /**
   * §5.9: a composed PR (a mission integration PR, a release PR) whose commits
   * are all already-reviewed changes needs no second full review. The effect's
   * outcome when an attestation took the round, else null (review in full).
   */
  attestComposition(d: DeliverySnapshot, round: RoundSnapshot): Promise<string | null>;
  /** A verdict GitHub would not take as a review: record it where a person sees it. */
  postFailed(d: DeliverySnapshot, p: { event: 'APPROVE' | 'REQUEST_CHANGES'; reason: string }): Promise<void>;
  /** An approval supersedes the open fix (the host's own supersession rules). */
  supersedeFixOnApproval(d: DeliverySnapshot): Promise<void>;
  /** The reviewer escalated `round`: tell a person, in the host's words. */
  escalated(d: DeliverySnapshot, round: RoundSnapshot | null): Promise<void>;
}

// ── Conflicts ───────────────────────────────────────────────────────────────

/** T26's plain base refresh, pinned to a head: done, an operational failure to retry, or refused (the PR's own facts answer it). */
export type BranchUpdate = { kind: 'updated' } | { kind: 'retry'; reason: string } | { kind: 'refused'; reason: string };

/** A bound attempt's mechanical refresh, pinned to its head. */
export type MechanicalRefresh =
  | { kind: 'updated' }
  | { kind: 'up_to_date' }
  | { kind: 'head_changed' }
  /** Refused for a reason an agent can fix (a textual conflict, a same-symbol overlap): T12 allocates the agent attempt. */
  | { kind: 'refused'; refusal: Record<string, unknown> }
  /** Operational and bounded by the host: the outbox retries. */
  | { kind: 'retry'; reason: string }
  /** A dead end no agent should take: a person lands it. */
  | { kind: 'failed'; reason: string };

/** A colliding migration's byte-identical renumber, verified against live trees now. */
export type MigrationRenumber =
  | { kind: 'renumbered'; to: string }
  | { kind: 'not_needed'; reason: string }
  | { kind: 'refused'; refusal: Record<string, unknown> }
  | { kind: 'head_moved' }
  | { kind: 'retry'; reason: string };

/** The host's half of the conflict and migration families: the git work, and what only the host can inspect. */
export interface Conflicts {
  /** A dependency bot owns the PR's branch: the platform never pushes to it (S27). */
  botOwned(d: DeliverySnapshot): Promise<boolean>;
  updateBranch(d: DeliverySnapshot, headSha: string): Promise<BranchUpdate>;
  refresh(d: DeliverySnapshot, attempt: AttemptSnapshot): Promise<MechanicalRefresh>;
  renumber(d: DeliverySnapshot, attempt: AttemptSnapshot, payload: Record<string, unknown>): Promise<MigrationRenumber>;
  /** Is a migration repair's agent attempt still owed at the bound head (§10.5)? Unknown fails toward doing the work. */
  migrationOwed(d: DeliverySnapshot, attempt: AttemptSnapshot, p: { repairKind: 'migration' | 'migration_split'; baseRef: string | null }): Promise<{ owed: boolean; reason?: string }>;
}

// ── HandOff ─────────────────────────────────────────────────────────────────

/** §14: legacy's first review for a delivery the kill switch released before its first round. */
export interface HandOff {
  /** Claim the hand-off once per owner task; false = already handed off. */
  claim(d: DeliverySnapshot): Promise<boolean>;
  /** Let the next owner end try again (the hand-off failed). */
  unclaim(d: DeliverySnapshot): Promise<void>;
  /** File what legacy would have filed at PR open: a reviewer at the live head, or a person for a pre-flight finding. */
  firstReview(p: {
    d: DeliverySnapshot & { repoFullName: string; prNumber: number };
    headSha: string;
    baseRef: string | null;
    policyEvidence: { headSha: string; outcome: string; reason: string } | null;
  }): Promise<{ outcome: string }>;
}

/** Everything a host hands the kernel, composed once at startup. `decide` is optional. */
export interface KernelPorts {
  store: Store;
  /** The host's GitHub when it has one installation for every workspace. */
  github?: GithubFacts;
  /** The host's GitHub per workspace (an installation per workspace in buildd); null = none. Wins over `github`. */
  githubFor?(workspaceId: string): Promise<GithubFacts | null>;
  clock: Clock;
  /** Ids for rows the kernel writes (rounds, attempts); the reducer's default when absent. */
  newId?: () => string;
  work?: Work;
  notify?: Notify;
  policy?: Policy;
  decide?: Decide;
  ingest?: Ingest;
  lifecycle?: Lifecycle;
  trunk?: Trunk;
  escalate?: Escalate;
  evidence?: Evidence;
  reviews?: Reviews;
  conflicts?: Conflicts;
  handOff?: HandOff;
}

/** The GitHub to act on for a workspace's delivery, or null when the host has none for it. */
export async function githubOf(ports: Pick<KernelPorts, 'github' | 'githubFor'>, workspaceId: string): Promise<GithubFacts | null> {
  if (ports.githubFor) return ports.githubFor(workspaceId);
  return ports.github ?? null;
}
