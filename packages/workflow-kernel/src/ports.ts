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
import type { ApplyDecision, CurrentView, EffectKind, LivePr, RecordOnly } from './commands';
import type { DeliveryState, KernelView } from './types';

export const PORTS_VERSION = 1;

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
 * Who decides for the delivery, read with the effect: `kernel`, `legacy`
 * (released), or `switched_off` (a kernel row whose workspace's kill switch is
 * off; the drain releases it before acting).
 */
export type EffectAuthority = 'kernel' | 'legacy' | 'switched_off';

/** What a drain re-checks before acting (§10.4): the delivery, who decides for it, and the queuing transition. */
export interface EffectSnapshot {
  delivery: { state: DeliveryState; version: number } | null;
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

/** The writes the kernel's effects make on GitHub. Each is idempotent at the host or keyed by the effect. */
export interface GithubWrites {
  /** Merge only if the PR's head is still `headSha`. */
  mergeAtHead(p: { repoFullName: string; prNumber: number; headSha: string; method?: 'squash' | 'merge' | 'rebase' }):
    Promise<{ outcome: 'merged'; mergeCommitSha: string | null } | { outcome: 'head_moved' | 'behind' | 'conflict' | 'blocked' | 'error'; detail?: string }>;
  postReview(p: { repoFullName: string; prNumber: number; commitId: string; event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'; body: string }): Promise<{ id: string | null }>;
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
  /** The role the task runs as (a reviewer, a fixer, a conflict resolver...). */
  role: string;
  title: string;
  description: string;
  workspaceId: string;
  /** What the task acts on: the PR and the head it was dispatched for. */
  target: { repoFullName: string; prNumber: number; headSha: string | null; baseRef?: string | null };
  /** Where it comes from: the delivery, the attempt and the task it continues. */
  lineage: { deliveryId: string; attemptId?: string | null; parentTaskId?: string | null };
  /** Idempotency: filing the same key twice returns the first task. */
  dedupeKey: string;
}

/** The host's scheduler (in buildd: a task insert plus `announceTaskCreated`). */
export interface Work {
  file(req: WorkRequest): Promise<{ taskId: string; created: boolean }>;
  wake(taskId: string, reason: string): Promise<void>;
  cancel(taskId: string, reason: string): Promise<void>;
}

// ── Notify ──────────────────────────────────────────────────────────────────

export interface Notify {
  /** Re-render the delivery's activity comment from the transition log. */
  activity(p: { deliveryId: string; version: number }): Promise<void>;
  /** A team notification about a delivery. */
  team(p: { workspaceId: string; deliveryId: string; kind: string; title: string; body?: string }): Promise<void>;
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

/** Everything a host hands the kernel, composed once at startup. `decide` is optional. */
export interface KernelPorts {
  store: Store;
  github?: GithubFacts;
  clock: Clock;
  work?: Work;
  notify?: Notify;
  policy?: Policy;
  decide?: Decide;
}
