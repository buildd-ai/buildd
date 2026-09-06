/**
 * PR lifecycle freshness — the age bound that "unknown" never had.
 *
 * Home used to converge PR lifecycle state only when it happened to render:
 * `refreshStaleWorkersForWorkspaces` ran blocking before the openPrWorkers
 * query, and every previous fix for a stale MERGE card added another branch to
 * the render predicate. A row nothing could resolve stayed pinned to the action
 * queue forever, because null lifecycle means "treat as open" (I-9 / PR #1537)
 * and an unresolvable row is deliberately not dropped (facae217 AC-6). Those
 * two correct rules compose into a permanent leak with no age bound.
 *
 * This module supplies the missing bound, in three parts:
 *
 *   1. A tiered SLA the sweep converges against, so lifecycle truth has a
 *      documented maximum age that does not depend on anyone opening Home.
 *   2. A TTL after which an unresolvable row stops pretending to be open and
 *      goes terminal (`prLifecycleStatus = 'unresolvable'`).
 *   3. A read-path gate (`resolveStaleGate`) the action queue uses to fail
 *      CLOSED — a row whose state is older than its SLA can never render as a
 *      merge CTA.
 *
 * All GitHub resolution happens in the sweep. This module is pure: it reads
 * timestamps and returns verdicts, never talks to GitHub, and the UI layer
 * still reads lifecycle from persisted columns only (I-9 hard constraint).
 */

export const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/**
 * How often a row's lifecycle state must be re-verified, by PR age.
 *
 * A PR opened an hour ago changes state constantly and someone is watching it;
 * a PR opened 90 days ago changes state almost never and nobody is. Tiering
 * keeps the bounded per-run batch from being consumed by cold rows while still
 * guaranteeing every cold row is checked daily.
 */
export type PrFreshnessTier = 'hot' | 'warm' | 'cold';

/** PRs younger than this are `hot`. */
export const HOT_MAX_AGE_MS = DAY_MS;
/** PRs younger than this (and not hot) are `warm`. */
export const WARM_MAX_AGE_MS = 7 * DAY_MS;

/** Maximum permitted age of a row's lifecycle state, per tier. */
export const TIER_SLA_MS: Record<PrFreshnessTier, number> = {
  hot: 30 * MINUTE_MS,
  warm: 6 * HOUR_MS,
  cold: DAY_MS,
};

/**
 * A genuinely-open PR older than this is a decision, not a merge tap. It keeps
 * a card — never silently dropped — but the card says STALE and states its age.
 */
export const STALE_PR_AGE_MS = 14 * DAY_MS;

/**
 * How long a row may stay unresolvable before it goes terminal. Paired with
 * UNRESOLVABLE_FAILURE_THRESHOLD: both must be satisfied, so a single GitHub
 * incident cannot condemn a row that would resolve fine an hour later.
 */
export const UNKNOWN_TTL_MS = DAY_MS;

/** Consecutive failed resolution attempts before a row goes terminal. */
export const UNRESOLVABLE_FAILURE_THRESHOLD = 3;

export function prFreshnessTier(ageMs: number): PrFreshnessTier {
  if (ageMs < HOT_MAX_AGE_MS) return 'hot';
  if (ageMs < WARM_MAX_AGE_MS) return 'warm';
  return 'cold';
}

/** The SLA a PR of this age must be re-verified within. */
export function prStateSlaMs(ageMs: number): number {
  return TIER_SLA_MS[prFreshnessTier(ageMs)];
}

export interface PrFreshnessInput {
  /** When the PR opened (worker completedAt, falling back to createdAt). */
  prOpenedAt: Date | null;
  /**
   * `workers.prLastVerifiedAt` — null means GitHub has never CONFIRMED this
   * row's state. Deliberately not `prLastCheckedAt`: that column advances on a
   * failed check too (recordFailure calls recordCheck), so "checked" and
   * "known" are different facts and this reads only the latter.
   */
  verifiedAt: Date | null;
  now: Date;
}

/**
 * True when this row's lifecycle state is within its tier's SLA.
 *
 * A row that was never verified is NOT fresh — "GitHub has never confirmed
 * this" is the exact state the stale MERGE cards were in. Critically, that is
 * also the state of a row whose every check attempt has FAILED: a failure
 * must never satisfy this predicate, or the fail-closed gate below has
 * nothing left to catch.
 */
export function isPrStateFresh(input: PrFreshnessInput): boolean {
  if (!input.verifiedAt) return false;
  const ageMs = input.prOpenedAt
    ? input.now.getTime() - input.prOpenedAt.getTime()
    : Number.POSITIVE_INFINITY;
  const sinceCheck = input.now.getTime() - input.verifiedAt.getTime();
  return sinceCheck <= prStateSlaMs(ageMs);
}

/**
 * Whether a row that keeps failing to resolve should go terminal.
 *
 * Both conditions are required. Failure count alone would condemn a young PR
 * during a GitHub outage (the hot tier retries every 30 minutes, so three
 * failures is 90 minutes); age alone would condemn every old PR the moment one
 * check happened to fail.
 */
export function shouldMarkUnresolvable(input: {
  failureCount: number;
  prOpenedAt: Date | null;
  now: Date;
}): boolean {
  if (input.failureCount < UNRESOLVABLE_FAILURE_THRESHOLD) return false;
  if (!input.prOpenedAt) return true;
  return input.now.getTime() - input.prOpenedAt.getTime() >= UNKNOWN_TTL_MS;
}

/** "36 hours" / "3 days" / "90 days" — the age a STALE card states. */
export function describeAge(ms: number): string {
  const hours = Math.floor(ms / HOUR_MS);
  if (hours < 48) return `${Math.max(hours, 0)} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(ms / DAY_MS);
  return `${days} day${days === 1 ? '' : 's'}`;
}

export type StaleGate =
  /** Lifecycle state is older than the row's tier SLA — we do not know if this PR is still open. */
  | { kind: 'unverified'; reason: string; ageHours: number }
  /** Verified open, but old enough that merging blind is the wrong ask. */
  | { kind: 'ancient'; reason: string; ageHours: number };

export interface StaleGateInput {
  /**
   * When the PR opened. REQUIRED — a caller with genuinely no known age must
   * still pass `null` explicitly and take the fail-closed answer that follows
   * (no age is treated as maximally cold, never as "unverified" simply
   * disappearing). This field used to be optional, and omitting it opted the
   * caller out of the invariant entirely — the exact structural hole
   * docs/design/derived-state-accessors.md's `no-stale-pr-read` rule exists to
   * close for every other seam. Making it required moves that closure to the
   * type checker: omitting the key is now a compile error, not a silent skip.
   */
  prOpenedAt: Date | null;
  /** `workers.prLastVerifiedAt`. Null means GitHub has never confirmed this row's state. */
  prLifecycleVerifiedAt?: Date | null;
  now: Date;
}

/**
 * The read-path invariant: given a row that would otherwise render as an
 * actionable merge CTA, decide whether it may.
 *
 * Returns null when the card may stand as-is. Any non-null result means the
 * card degrades to STALE — never the other way round. This is deliberately the
 * fail-CLOSED direction: an unknown-age or unverified row falls back to the
 * "we do not know" surface, never forward to a button that merges something.
 */
export function resolveStaleGate(input: StaleGateInput): StaleGate | null {
  const now = input.now.getTime();
  const openedAt = input.prOpenedAt?.getTime() ?? null;
  const ageMs = openedAt === null ? Number.POSITIVE_INFINITY : now - openedAt;
  const ageHours = Number.isFinite(ageMs) ? Math.floor(ageMs / HOUR_MS) : 0;

  const verifiedAt = input.prLifecycleVerifiedAt ?? null;
  if (!isPrStateFresh({ prOpenedAt: input.prOpenedAt, verifiedAt, now: input.now })) {
    const sla = prStateSlaMs(ageMs);
    return {
      kind: 'unverified',
      ageHours,
      reason: verifiedAt
        ? `PR state last verified ${describeAge(now - verifiedAt.getTime())} ago — past the ${describeAge(sla)} check window`
        : 'PR state has never been verified against GitHub',
    };
  }

  if (ageMs >= STALE_PR_AGE_MS) {
    return {
      kind: 'ancient',
      ageHours,
      reason: `Open for ${describeAge(ageMs)} — decide whether this still ships, don't merge it blind`,
    };
  }

  return null;
}
