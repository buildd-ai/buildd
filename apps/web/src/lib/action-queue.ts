import type { CiGate } from './ci-gate';
import { resolveStaleGate, type StaleGate } from './pr-freshness';

/**
 * ── The queue freshness rule ────────────────────────────────────────────────
 * Every actionable chip asserts something about its subject's CURRENT state —
 * "this PR is open and mergeable", "this mission owes you a decision right
 * now" — and may only render while that state is known to be live. A stored
 * flag (`criteriaEscalatedAt`, `prLifecycleStatus`, a note left `open`) is a
 * record of when something happened, never proof that it still holds; a
 * builder must re-derive membership from the subject's current row, not trust
 * the flag alone.
 *
 * MERGE/REVIEW enforce this via `MERGE_CTA_CHIPS` + the STALE gate below.
 * DECIDE enforces it in `buildDecideItems`: a candidate is dropped unless the
 * mission is still live (`status` in active/paused) AND its criteria verdict
 * is not passing, in addition to the escalation flag and the open note.
 * QUESTION is exempt by construction rather than by a separate check — it is
 * built from `workers.status === 'waiting_input'` queried fresh on every
 * build, not from a persisted "this worker asked something" flag, so there is
 * no stale state for it to trust. RECONNECT and APPROVE are the same shape:
 * both come from a live re-check (`needsReconnect()` against the credential
 * row; "does an approved child task exist yet") each time the queue is built.
 * Any new chip must name which of these two patterns it uses — re-derive on
 * every build, or gate a persisted flag against a second, independently-live
 * signal — before it ships.
 *
 * AUTO_MERGE is agent-handled, so it asks nothing of the human and the freshness
 * rule has nothing to guard. It is still re-derived on every build, from the
 * resolved merge policy and the open PR row, like MERGE.
 */

export type ActionChip =
  | 'MERGE' | 'BLOCKED' | 'RECONNECT' | 'REVIEW' | 'QUESTION' | 'DECIDE' | 'DISCREPANCY' | 'APPROVE'
  | 'STALE'
  | 'RESOLVING' | 'FIXING_CI' | 'CI_RUNNING' | 'AUTO_MERGE' | 'FIXING_SPEC';

/** docs/design/spec-conformance.md §8 — which way a discrepancy's gap runs. */
export type DiscrepancyDirection = 'spec_ahead' | 'code_ahead' | 'contradicted';

/**
 * Chips an agent is already handling. They stay visible (a stuck fix must not
 * become invisible) but never count toward "waiting on you" and never sort
 * above work that genuinely needs a human.
 */
const AGENT_HANDLED_CHIPS: ReadonlySet<ActionChip> = new Set<ActionChip>([
  'RESOLVING', 'FIXING_CI', 'CI_RUNNING', 'AUTO_MERGE', 'FIXING_SPEC',
]);

export function isActionableChip(chip: ActionChip): boolean {
  return !AGENT_HANDLED_CHIPS.has(chip);
}

export interface ResolvedEscalationItem {
  workerId: string;
  taskId: string;
  taskTitle: string;
  prNumber: number | null;
  prUrl: string | null;
  /** Persisted lifecycle value — never re-derived from GitHub. */
  prLifecycleStatus: 'merged' | 'closed';
  workspaceName: string;
}

/**
 * Splits escalation-eligible items by lifecycle state.
 *
 * Resolution rule (§1.3 mobile-decision-flow): an item moves to resolved when
 * prLifecycleStatus is 'merged' or 'closed'. Null/unknown → treat as 'keep'
 * (item stays active). Never auto-resolve on a null lifecycle.
 */
export function partitionEscalations<T extends { prLifecycleStatus: string | null }>(
  items: T[],
): { active: T[]; resolved: T[] } {
  const active: T[] = [];
  const resolved: T[] = [];
  for (const item of items) {
    if (item.prLifecycleStatus === 'merged' || item.prLifecycleStatus === 'closed') {
      resolved.push(item);
    } else {
      active.push(item);
    }
  }
  return { active, resolved };
}

export interface WaitingOnYouRawItem {
  kind: 'merge' | 'approve' | 'answer' | 'reconnect' | 'decide' | 'discrepancy';
  prUrl?: string;
  prNumber?: number;
  prLifecycleStatus?: 'open' | 'merged' | 'closed' | 'unresolvable' | null;
  upstreamTaskId?: string;
  upstreamTaskTitle?: string;
  unblockCount?: number;
  taskId?: string;
  taskTitle?: string;
  workerId?: string;
  question?: string;
  missionId?: string | null;
  missionTitle?: string | null;
  /** kind === 'reconnect' — the connector whose credential needs re-authorising. */
  connectorId?: string;
  connectorName?: string;
  /** kind === 'decide' — the fingerprint of the escalated criteria for dedup. */
  criteriaRearmFingerprint?: string;
  /** kind === 'merge' — opts this row into the freshness invariant. See EscalationRawItem. */
  prOpenedAt?: Date | null;
  /** `workers.prLastVerifiedAt` — when GitHub last CONFIRMED this row's state. */
  prLifecycleVerifiedAt?: Date | null;
  /** kind === 'decide' — the open `missionNotes` row this card links back to. */
  noteId?: string;
  /** kind === 'decide' — the note's title, e.g. "Goal criteria blocked — owner decision needed". */
  noteTitle?: string;
  /**
   * kind === 'decide' — `missions.criteriaRearmFingerprint` at escalation time.
   * Dedupe key component, deliberately NOT the note body: an LLM re-grading
   * the same failure phrases it differently every run, so keying on evidence
   * text would spawn a fresh card every cycle for one unresolved decision.
   */
  criteriaFingerprint?: string;
  /**
   * kind === 'decide' — which remedy `inferCriteriaFailureReading` says the
   * failure pattern supports, already rendered to a sentence by the caller.
   * A heuristic over LLM-graded prose, so it is shown, never acted on: the
   * card must not preselect an exit from this alone.
   */
  recommendation?: string | null;
  /**
   * kind === 'discrepancy' — the REPRESENTATIVE spec_discrepancies row id (§7):
   * the oldest row in the grouped card. Single-row routes (adjudicate, dispatch
   * doc fix) are addressed through it; the server re-derives the rest of the
   * group from the row's own spec path rather than trusting a client-supplied
   * list.
   */
  discrepancyId?: string;
  /** kind === 'discrepancy' — every row id in the grouped card, oldest first. */
  discrepancyIds?: string[];
  /** kind === 'discrepancy' — the spec doc the assertions live in. */
  specPath?: string;
  /** kind === 'discrepancy' — the representative (oldest) assertion id. */
  assertionId?: string;
  /** kind === 'discrepancy' — every assertion id in the grouped card, oldest first. */
  assertionIds?: string[];
  /** kind === 'discrepancy' — which way the gap runs (§8). */
  direction?: DiscrepancyDirection;
  /** kind === 'discrepancy' — when the OLDEST row in the group first appeared. */
  firstSeenAt?: Date;
  /** kind === 'discrepancy' — the doc-fix task claimed on this spec path, if any. */
  docFixTaskId?: string | null;
  /** kind === 'discrepancy' — `tasks.status` of docFixTaskId. */
  docFixTaskStatus?: string | null;
  /** kind === 'discrepancy' — `workers.prLifecycleStatus` for docFixTaskId's PR, if any. */
  docFixPrLifecycleStatus?: string | null;
  /**
   * kind === 'discrepancy' — a doc-fix task whose PR merged and was rechecked
   * with the gap still open (isDocFixClaimStale). Set only when no live claim
   * owns the group. The card offers the owner's exits, never a second fix.
   */
  mergedDocFixTaskId?: string | null;
  /** kind === 'discrepancy' — see deriveDocFixAutomation. Decides the chip, copy and CTA set. */
  docFixAutomation?: DocFixAutomation | null;
  /** kind === 'discrepancy' — the one automatic follow-up task, once filed. */
  docFixFollowUpTaskId?: string | null;
  /** kind === 'discrepancy' — minutes since the latest forced ledger re-run was dispatched. */
  recheckDispatchedMinutesAgo?: number | null;
  /** kind === 'discrepancy' — hours since the doc-fix PR merged. */
  docFixMergedHoursAgo?: number | null;
  /** kind === 'discrepancy' — hours since the checker last evaluated the rows. */
  lastCheckedHoursAgo?: number | null;
  /** kind === 'discrepancy' — the doc status the checker last read (evidence). */
  declaredStatus?: string | null;
  /** kind === 'discrepancy' — set once `promote_discrepancy` has minted a mission. */
  promotedMissionId?: string | null;
  /** kind === 'discrepancy' — the discrepancy's owning workspace. */
  workspaceId?: string;
  /** kind === 'discrepancy' — the discrepancy's owning workspace name. */
  workspaceName?: string | null;
}

export interface EscalationRawItem {
  workerId: string;
  taskId: string;
  taskTitle: string;
  workspaceId: string;
  workspaceName: string;
  prNumber: number | null;
  prUrl: string | null;
  policyTier: string;
  escalationReason: string | null;
  /**
   * The platform will merge this PR by itself once CI is green (reviewer gate
   * `platformState === 'auto_merge'`). Renders as the in-flight AUTO_MERGE
   * chip, unless a CI or conflict state outranks it.
   */
  autoMerge?: boolean;
  /**
   * True only when an OPEN `reviewer_escalated` mission note exists for this
   * task — as opposed to `escalationReason` being set from pure reviewer-task-
   * status inference (review_failed, cancelled, stalled, no reviewer task,
   * completed-without-a-verdict). A note existing means an agent (or the
   * automated retry-exhaustion path) handed the PR back with a concrete
   * statement, even absent a structured `recommendation` — that statement is
   * still a valid instruction to dispatch a fix against. Pure inference has no
   * defect statement to dispatch, only a description of why nothing acted.
   */
  hasEscalationNote?: boolean;
  /** Mission the PR's task belongs to — drives the card's arc context line. */
  missionId?: string | null;
  missionTitle?: string | null;
  waitingMinutes: number | null;
  /** CI state of the PR — resolved by lib/ci-gate before the queue is built. */
  ciGate?: CiGate | null;
  /** Reviewer's recommended next step, when it escalated to a human. */
  recommendation?: string | null;
  /**
   * An open `reviewer_approved` note's summary — set only when the reviewer
   * approved under an approve-only gate and is waiting on a human merge.
   * Distinguishes "approved, nothing to apply" from "no verdict at all" for a
   * REVIEW-chip card, since both leave `recommendation` null.
   */
  verdictSummary?: string | null;
  /**
   * The SHA the most recent terminal reviewer verdict was made against, and
   * the PR's current head. Together they drive the "Re-review changes since
   * approval" affordance — offered only while they differ, since a re-review
   * at an unchanged head has nothing new to say.
   */
  approvedSha?: string | null;
  headSha?: string | null;
  /** Set when an agent is actively resolving conflicts for this PR. */
  conflictRetryTaskId?: string | null;
  conflictRetryIteration?: number | null;
  /** Set when conflict-resolution retries are exhausted — PR needs human action. */
  deadZoneExhausted?: boolean;
  /** The last conflict retry task ID — used as the CTA target on BLOCKED cards. */
  deadZoneLastRetryTaskId?: string | null;
  /**
   * Persisted lifecycle value. `'unresolvable'` is terminal and drops the row
   * out of the queue entirely — it belongs on the health/orphans surface, not
   * on a queue of things a human can act on.
   */
  prLifecycleStatus?: string | null;
  /**
   * When the PR opened. Supplying this OPTS THIS ROW IN to the freshness
   * invariant (see lib/pr-freshness.ts): without an age there is no tier and
   * therefore no SLA. Callers that omit it are exempt.
   */
  prOpenedAt?: Date | null;
  /**
   * `workers.prLastVerifiedAt` — when GitHub last CONFIRMED this row's state.
   * Deliberately not `prLastCheckedAt`: that column also advances on a FAILED
   * check, so it cannot answer "do we actually know this PR's state".
   */
  prLifecycleVerifiedAt?: Date | null;
  /**
   * Set only for a mission's own integration PR (the "Ship mission: ..."
   * bookkeeping task) when `guardMissionPrMerge` currently refuses to merge
   * it — the reason names the blocking task/PR. Re-derived live by the
   * caller on every queue build via a fresh `guardMissionPrMerge` call, the
   * same live-re-check pattern QUESTION and DECIDE use (see the freshness
   * rule at the top of this file): there is no persisted flag to trust here,
   * only a DB read taken at build time. Never set for an ordinary task PR —
   * `guardMissionPrMerge` itself is a no-op for those.
   */
  missionMergeBlockedReason?: string | null;
}

export interface ActionQueueItem {
  subjectKey: string;
  // Set on Home when the item's mission belongs to an initiative — drives the
  // initiative filter chips (scoping only; buildActionQueue itself never sets it).
  initiativeId?: string | null;
  initiativeTitle?: string | null;
  chip: ActionChip;
  prUrl?: string;
  prNumber?: number;
  prLifecycleStatus?: 'open' | 'merged' | 'closed' | 'unresolvable' | null;
  taskId?: string;
  taskTitle?: string;
  workspaceId?: string;
  workspaceName?: string;
  upstreamTaskTitle?: string;
  unblockCount?: number;
  missionId?: string | null;
  missionTitle?: string | null;
  /**
   * Mission of the tasks this PR unblocks — distinct from missionTitle, which is
   * the mission the PR itself belongs to. Only set for blocker-derived items.
   */
  unblockMissionTitle?: string | null;
  waitingMinutes?: number | null;
  escalationReason?: string | null;
  /** See {@link EscalationRawItem.hasEscalationNote} — carried through unchanged. */
  hasEscalationNote?: boolean;
  workerId?: string;
  question?: string;
  /** Set when the card is CI-gated — drives FIXING_CI / CI_RUNNING / CI BLOCKED copy. */
  ciGate?: CiGate | null;
  /**
   * The last agent's own advice on what a human should do next
   * (tasks.result.nextSuggestion). Shown on BLOCKED cards, where the human is
   * being asked to decide something an agent already failed at.
   */
  recommendation?: string | null;
  /** See {@link EscalationRawItem.verdictSummary} — carried through unchanged. */
  verdictSummary?: string | null;
  /** See {@link EscalationRawItem.approvedSha} — carried through unchanged. */
  approvedSha?: string | null;
  /** See {@link EscalationRawItem.headSha} — carried through unchanged. */
  headSha?: string | null;
  /** Set when chip === 'RESOLVING' — the task actively resolving merge conflicts. */
  conflictRetryTaskId?: string | null;
  conflictRetryIteration?: number | null;
  /** Set when chip === 'BLOCKED' — retries exhausted, human decision required. */
  deadZoneExhausted?: boolean;
  /** Link target for the BLOCKED card's primary CTA. */
  deadZoneLastRetryTaskId?: string | null;
  /** Set when chip === 'RECONNECT' — the connector needing re-auth. */
  connectorId?: string;
  connectorName?: string;
  /** Set when chip === 'DECIDE' — the escalation note this card links back to. */
  noteId?: string;
  noteTitle?: string;
  /**
   * Set when chip === 'STALE' — why this stopped being a merge CTA, and how
   * old the PR is. `kind: 'unverified'` means we do not know the PR's current
   * state; `kind: 'ancient'` means we do, and it is old enough that merging it
   * blind is the wrong ask.
   */
  staleGate?: StaleGate | null;
  /** PR age in hours — emitted for the action_queue.card_age_hours metric. */
  cardAgeHours?: number | null;
  /**
   * Set when chip === 'DISCREPANCY'/'FIXING_SPEC' — the representative (oldest)
   * spec_discrepancies row id (§7) the card's actions address.
   */
  discrepancyId?: string;
  /** Every row id behind the card, oldest first. */
  discrepancyIds?: string[];
  /** Set when chip === 'DISCREPANCY'/'FIXING_SPEC' — the spec doc this card is about. */
  specPath?: string;
  /** The representative (oldest) assertion id. */
  assertionId?: string;
  /** Every assertion id behind the card, oldest first — the expandable list. */
  assertionIds?: string[];
  /** Set when chip === 'DISCREPANCY'/'FIXING_SPEC' — which way the gap runs (§8). */
  direction?: DiscrepancyDirection;
  /** Set when chip === 'DISCREPANCY' and `promote_discrepancy` has already minted a mission. */
  promotedMissionId?: string | null;
  /** Set when chip === 'FIXING_SPEC' — the in-flight doc-fix task to link to. */
  docFixTaskId?: string | null;
  /** `tasks.status` of docFixTaskId — distinguishes "being worked" from "shipped, awaiting re-run". */
  docFixTaskStatus?: string | null;
  /**
   * `workers.prLifecycleStatus` of docFixTaskId's PR — distinguishes "PR
   * still open" (no re-run pending; the doc fix hasn't landed yet) from "PR
   * merged, genuinely awaiting the conformance re-run" so the card names the
   * real blocker instead of assuming completion means merged.
   */
  docFixPrLifecycleStatus?: string | null;
  /** See {@link WaitingOnYouRawItem.mergedDocFixTaskId} — carried through unchanged. */
  mergedDocFixTaskId?: string | null;
  /** The doc-fix automation fields below are carried through unchanged from WaitingOnYouRawItem. */
  docFixAutomation?: DocFixAutomation | null;
  docFixFollowUpTaskId?: string | null;
  recheckDispatchedMinutesAgo?: number | null;
  docFixMergedHoursAgo?: number | null;
  lastCheckedHoursAgo?: number | null;
  declaredStatus?: string | null;
  /** See {@link EscalationRawItem.missionMergeBlockedReason} — carried through unchanged. */
  missionMergeBlockedReason?: string | null;
}

// Chip display order: lower index = shown first.
// BLOCKED: retries exhausted, human must decide — actionable, placed after MERGE.
// DECIDE: mission criteria escalated, owner decision needed — actionable.
// RESOLVING is last — it is informational (agent is handling it), not action-required.
// RECONNECT sits high: a connector that can no longer re-authorise itself
// silently starves every task that needs it, and the fix is a single tap.
// DECIDE sits with QUESTION: both are "the platform stopped and needs a human
// call", just at different scopes (task vs. mission). Placed after QUESTION,
// not above it — a live worker blocked on an answer is still more urgent than
// a mission whose heartbeat has already been stood down and is going nowhere
// regardless of when the owner looks.
// DISCREPANCY sits immediately after DECIDE, never above it (docs/design/
// spec-conformance.md §12): "the platform found something that needs an
// owner call", the same tier as DECIDE, but a live mission decision always
// outranks a doc/checker finding.
// STALE sits below every live decision and above the agent-handled chips: it
// still needs a human, but a 90-day-old PR must never outrank today's work.
// FIXING_SPEC is DISCREPANCY's agent-handled counterpart: a doc-fix task has
// been dispatched for that spec path, so the row is no longer waiting on a
// human. It stays visible for the same reason RESOLVING does — a doc fix that
// dies must not take the finding with it — but never counts as actionable.
const CHIP_ORDER: ActionChip[] = [
  'MERGE', 'BLOCKED', 'RECONNECT', 'REVIEW', 'QUESTION', 'DECIDE', 'DISCREPANCY', 'APPROVE',
  'STALE',
  'RESOLVING', 'FIXING_CI', 'CI_RUNNING', 'AUTO_MERGE', 'FIXING_SPEC',
];

/**
 * Chips that may be presented as a one-tap merge. The freshness invariant is
 * enforced against exactly this set: everything here asserts something about
 * the PR's current state, so it may only be shown when that state is known to
 * be current.
 */
const MERGE_CTA_CHIPS: ReadonlySet<ActionChip> = new Set<ActionChip>(['MERGE', 'REVIEW']);

export interface BuildActionQueueOptions {
  /** Injected for deterministic tests. Defaults to now. */
  now?: Date;
  /**
   * subjectKeys the requesting user currently has an active (unexpired) snooze
   * on — see `action_queue_snoozes` in schema.ts. Dropped from the built queue
   * entirely rather than flagged, so a snoozed MERGE/REVIEW gate card behaves
   * exactly like one that never escalated. Callers must have already filtered
   * this set to `snoozedUntil > now`; buildActionQueue does not re-check it —
   * the freshness invariant this file otherwise enforces (see header comment)
   * is about re-deriving subject state (open/merged/CI), not about re-running
   * an expiry check the caller already ran a moment earlier.
   */
  snoozedSubjectKeys?: ReadonlySet<string>;
}

/** Mission statuses under which a DECIDE card may still be a live ask. */
const LIVE_MISSION_STATUSES = new Set(['active', 'paused']);

/** A mission that may or may not be waiting on an owner decision. */
export interface EscalatedMissionCandidate {
  missionId: string;
  missionTitle: string | null;
  /**
   * `missions.criteriaEscalatedAt` — WHEN the escalation happened, never an
   * assertion that it is still true now. A completed mission, an answered
   * note, or a verdict that later passed can all leave this column set while
   * the escalation itself is long dead — see `status` and
   * `criteriaOverallVerdict` below, which is why membership never reads this
   * column alone.
   */
  criteriaEscalatedAt: Date | string | null;
  criteriaRearmFingerprint: string | null;
  /** The mission's open `missionNotes` row of type 'question', if any. */
  openNote: { id: string; title: string; body: string | null } | null;
  /** `missions.status` — a terminal mission cannot owe anyone a live decision. */
  status: string;
  /** `goalCriteriaState.overall` — a passing verdict means nothing is blocked, whatever the stale flag says. */
  criteriaOverallVerdict: string | null;
  /**
   * `describeCriteriaFailureReading(inferCriteriaFailureReading(...))` — which
   * remedy the failure pattern supports, already rendered to a sentence.
   * Passed through verbatim; this module never re-derives it from criteria.
   */
  recommendation?: string | null;
}

/**
 * Filters escalated missions down to the ones that actually belong on the
 * action queue, and shapes them into `decide` raw items.
 *
 * Every condition here is required, independently of the others — this is a
 * DERIVATION, not a trust of `criteriaEscalatedAt`. `criteria-rearm` always
 * escalates alongside an open note, sets a non-passing verdict, and leaves the
 * mission active in the same transaction, but this function does not assume
 * that invariant holds forever: a mission whose note was answered, whose
 * verdict later passed, or that was completed/archived out from under a stale
 * flag must drop out on any one of those signals alone, not just all of them
 * at once. Same precedent as mission 5a4e7013's correction of cached
 * goal-criteria verdicts: a persisted flag records when something happened,
 * never whether it is still true.
 */
export function buildDecideItems(candidates: EscalatedMissionCandidate[]): WaitingOnYouRawItem[] {
  const items: WaitingOnYouRawItem[] = [];
  for (const c of candidates) {
    if (!c.criteriaEscalatedAt) continue;
    if (!c.openNote) continue;
    if (!LIVE_MISSION_STATUSES.has(c.status)) continue;
    if (c.criteriaOverallVerdict === 'pass') continue;
    items.push({
      kind: 'decide',
      missionId: c.missionId,
      missionTitle: c.missionTitle,
      noteId: c.openNote.id,
      noteTitle: c.openNote.title,
      question: c.openNote.body ?? undefined,
      criteriaFingerprint: c.criteriaRearmFingerprint ?? 'none',
      recommendation: c.recommendation ?? null,
    });
  }
  return items;
}

/** A `spec_discrepancies` row (packages/core/db/schema.ts) that may belong on the queue. */
export interface DiscrepancyCandidate {
  id: string;
  workspaceId: string;
  workspaceName?: string | null;
  specPath: string;
  assertionId: string;
  direction: DiscrepancyDirection;
  status: 'open' | 'accepted' | 'resolved';
  firstSeenAt: Date | string;
  promotedMissionId?: string | null;
  /** `spec_discrepancies.last_checked_at` — when the checker last evaluated this row. */
  lastCheckedAt?: Date | string;
  /** `spec_discrepancies.doc_fix_task_id` — the dispatched docs-only follow-up. */
  docFixTaskId?: string | null;
  /** `tasks.status` of `docFixTaskId`, resolved by the caller. */
  docFixTaskStatus?: string | null;
  /** `workers.prLifecycleStatus` for `docFixTaskId`'s PR, resolved by the caller. */
  docFixPrLifecycleStatus?: string | null;
  /** `workers.mergedAt` for `docFixTaskId`'s PR, resolved by the caller. */
  docFixMergedAt?: Date | string | null;
  /** `spec_discrepancies.recheck_requested_at` — when a forced ledger re-run was last dispatched. */
  recheckRequestedAt?: Date | string | null;
  /** `spec_discrepancies.auto_follow_up_task_id` — non-null once the one automatic follow-up is spent. */
  autoFollowUpTaskId?: string | null;
  /** `evidence.declaredStatus` — the doc status the checker last read. */
  declaredStatus?: string | null;
}

export interface DiscrepancyQueueResult {
  items: WaitingOnYouRawItem[];
  /**
   * SPECS beyond each workspace's top-`cap` — never silently dropped (§12).
   * The DISCREPANCY-queue equivalent of `summariseActionQueueAge`: a caller
   * must surface this count somewhere (e.g. "N specs beyond the visible top
   * 10") so a clean-looking queue can never hide a growing backlog the way
   * the Schedules page did.
   *
   * Counted in SPECS, not rows, because the cap is applied to grouped cards:
   * four stale assertions on one doc are one card and one unit of overflow,
   * not four. A row-count here would have read "12 more" for what is really
   * two documents to fix.
   */
  overflowCount: number;
}

/**
 * A doc-fix task in one of these statuses still owns the spec path: the card
 * is agent-handled, and a second tap must attach to it rather than file again.
 * `completed` is included deliberately — the docs PR has been written and the
 * rows now wait on a checker re-run (§9), so re-dispatching in that window
 * would file duplicate work against a document that has already been fixed.
 * `failed`/`cancelled` release the claim: nothing is coming, and the human
 * needs the CTA back.
 */
/**
 * How long after a doc-fix merge a ledger recheck has to land before it counts
 * as having evaluated the fix. It bounds one Spec Discrepancy Ledger run
 * (checkout, install, evaluate, write) with room to spare; a run that began
 * before the merge finishes well inside it.
 */
export const DOC_FIX_RECHECK_GRACE_MS = 30 * 60 * 1000;

const LIVE_DOC_FIX_STATUSES: ReadonlySet<string> = new Set([
  'pending', 'assigned', 'in_progress', 'completed',
]);

export function isDocFixInFlight(
  candidate: Pick<DiscrepancyCandidate, 'docFixTaskId' | 'docFixTaskStatus'>,
): boolean {
  if (!candidate.docFixTaskId) return false;
  // An unresolved status (the caller could not read the task row) is treated as
  // live: failing closed here costs one card's CTA, failing open files a
  // duplicate task against a doc somebody is already fixing.
  if (!candidate.docFixTaskStatus) return true;
  return LIVE_DOC_FIX_STATUSES.has(candidate.docFixTaskStatus);
}

/**
 * A completed doc-fix task still counts as "in flight" per `isDocFixInFlight`
 * above — on purpose, so a fresh completion isn't mistaken for an abandoned
 * claim. But nothing released that claim once the checker actually got a
 * chance to re-evaluate the row against the merged fix and STILL found the
 * same gap. Without this, `docFixTaskId` sits on the row forever: every
 * future Tier-2 run keeps 'refresh'ing direction/lastCheckedAt (the row is
 * correctly tracked), but the card never finds out — it keeps citing a task
 * that finished days or weeks ago and calling the row "awaiting the
 * conformance re-run" when a re-run, or several, already ran and changed
 * nothing. That's the stranded-card bug.
 *
 * Staleness requires proof, not a guess from task status alone: the task's
 * PR must have actually MERGED (`workers.prLifecycleStatus === 'merged'`) —
 * a task can complete without its PR merging (planning tasks open a PR and
 * stop there), and claiming staleness before merge would let a human
 * re-dispatch a duplicate fix while the first one is still sitting in review
 * — and the row's own `lastCheckedAt` must be at or after that merge, i.e.
 * the checker has demonstrably run again since the fix landed. Never trust
 * the task's own say-so (§9) — only a timestamp comparison against the
 * ledger row's own last real evaluation.
 *
 * The recheck must also land at least DOC_FIX_RECHECK_GRACE_MS after the
 * merge. The ledger writer stamps last_checked_at when it FINISHES, so a run
 * started on an earlier dev push that completes just after the merge moves
 * last_checked_at past mergedAt without ever reading the fixed doc.
 *
 * A stale claim is NOT an invitation to dispatch the same doc fix again: the
 * dispatch route leaves such rows out of any new task, refuses outright
 * (`doc_fix_already_merged`) when every open row on the path is held that
 * way, and in that case the card offers Accept only. A code_ahead row that survives a merged, rechecked docs fix is held
 * open by its assertions, not by the document text, and only the owner can
 * change that (accept, `skip_until`, or rewrite the assertion).
 */
export function isDocFixClaimStale(
  candidate: Pick<
    DiscrepancyCandidate,
    'docFixTaskStatus' | 'docFixPrLifecycleStatus' | 'docFixMergedAt' | 'lastCheckedAt'
  >,
): boolean {
  if (candidate.docFixTaskStatus !== 'completed') return false;
  if (candidate.docFixPrLifecycleStatus !== 'merged' || !candidate.docFixMergedAt) return false;
  if (!candidate.lastCheckedAt) return false;
  return (
    new Date(candidate.lastCheckedAt).getTime() >=
    new Date(candidate.docFixMergedAt).getTime() + DOC_FIX_RECHECK_GRACE_MS
  );
}

// ─── Doc-fix automation (docs/design/spec-conformance.md §9/§12.1) ──────────

/** The hourly sweep only re-dispatches a re-run for a fix merged at least this long ago. */
export const DOC_FIX_RECHECK_SWEEP_AFTER_MS = 60 * 60 * 1000;
/** A dispatched forced re-run counts as in flight (covering later merges) for this long. */
export const DOC_FIX_RECHECK_IN_FLIGHT_MS = 45 * 60 * 1000;
/**
 * The re-run's whole budget, measured from the doc-fix merge. Past it, a row
 * that was never rechecked is a genuine failure of the automation (the ledger
 * workflow is not running, or cannot reach the row) and goes to the owner. It also caps the
 * sweep: hourly re-dispatches stop here, so a broken workflow costs a handful
 * of runs, not one an hour forever.
 */
export const DOC_FIX_AUTOMATION_BUDGET_MS = 6 * 60 * 60 * 1000;

/**
 * Where the automation stands on one card, derived only from ledger, task and
 * worker rows — never from what any agent reported (§9).
 *
 *   fix_running        doc-fix task pending/running                   agents
 *   follow_up_running  the one automatic follow-up pending/running    agents
 *   pr_open            task done, docs PR still open                  agents (the PR is its own MERGE card)
 *   pr_unknown         task done, PR lifecycle not yet observed       agents (pr-reconcile heals it; Accept stays as the exit)
 *   recheck_dispatched merged; a forced re-run is in flight           agents
 *   recheck_queued     merged; the next sweep dispatches the re-run   agents
 *   recheck_stalled    merged past the budget and never rechecked     owner
 *   follow_up_queued   merged, rechecked, still open; follow-up owed  agents (the hourly sweep files it; the
 *                                                                     only way that fails is transiently, and
 *                                                                     the next sweep retries)
 *   needs_owner        fix AND follow-up merged, recheck still open   owner
 *
 * null means no automation is involved: the card offers Dispatch doc fix.
 */
export type DocFixAutomation =
  | 'fix_running'
  | 'follow_up_running'
  | 'pr_open'
  | 'pr_unknown'
  | 'recheck_dispatched'
  | 'recheck_queued'
  | 'recheck_stalled'
  | 'follow_up_queued'
  | 'needs_owner';

const AGENT_HANDLED_AUTOMATION: ReadonlySet<DocFixAutomation> = new Set<DocFixAutomation>([
  'fix_running', 'follow_up_running', 'pr_open', 'pr_unknown', 'recheck_dispatched', 'recheck_queued', 'follow_up_queued',
]);

/** True while automation still owns the card — Home shows it under "agents handling", never "needs you". */
export function isDocFixAutomationAgentHandled(state: DocFixAutomation | null | undefined): boolean {
  return state != null && AGENT_HANDLED_AUTOMATION.has(state);
}

const ms = (d: Date | string | null | undefined) => (d ? new Date(d).getTime() : null);

/** A forced re-run was dispatched after this row's fix merged, recently enough to still be running. */
export function isRecheckInFlight(
  c: Pick<DiscrepancyCandidate, 'recheckRequestedAt' | 'docFixMergedAt'>,
  now: Date,
): boolean {
  const requested = ms(c.recheckRequestedAt);
  const merged = ms(c.docFixMergedAt);
  if (requested == null || merged == null) return false;
  return requested >= merged && now.getTime() - requested < DOC_FIX_RECHECK_IN_FLIGHT_MS;
}

/**
 * A merged doc fix whose row the checker has not yet evaluated, and for which
 * automation should dispatch a forced ledger re-run now. `minAgeMs` is 0 on
 * the merge webhook and DOC_FIX_RECHECK_SWEEP_AFTER_MS on the hourly sweep
 * (which gives the ordinary dev-push run first go).
 */
export function rowNeedsRecheck(c: DiscrepancyCandidate, now: Date, minAgeMs: number): boolean {
  if (c.status !== 'open' || !c.docFixTaskId) return false;
  if (c.docFixTaskStatus !== 'completed' || c.docFixPrLifecycleStatus !== 'merged') return false;
  const merged = ms(c.docFixMergedAt);
  if (merged == null) return false;
  if (isDocFixClaimStale(c)) return false; // already rechecked since the merge
  const age = now.getTime() - merged;
  if (age < minAgeMs || age > DOC_FIX_AUTOMATION_BUDGET_MS) return false;
  return !isRecheckInFlight(c, now);
}

/**
 * The card-level state for one group (every open row on a spec path and
 * direction). Pure; `buildDiscrepancyItems`, the hourly sweep and the
 * dispatch route all read it, so what Home says and what automation does
 * cannot disagree.
 */
export function deriveDocFixAutomation(rows: DiscrepancyCandidate[], now: Date): DocFixAutomation | null {
  const claim = rows.find((r) => isDocFixInFlight(r) && !isDocFixClaimStale(r));
  if (claim) {
    const isFollowUp = Boolean(claim.autoFollowUpTaskId) && claim.autoFollowUpTaskId === claim.docFixTaskId;
    if (claim.docFixTaskStatus !== 'completed') return isFollowUp ? 'follow_up_running' : 'fix_running';
    if (claim.docFixPrLifecycleStatus == null || (claim.docFixPrLifecycleStatus === 'merged' && !claim.docFixMergedAt)) {
      return 'pr_unknown';
    }
    if (claim.docFixPrLifecycleStatus !== 'merged') return 'pr_open';
    if (rows.some((r) => r.docFixTaskId === claim.docFixTaskId && isRecheckInFlight(r, now))) return 'recheck_dispatched';
    const age = now.getTime() - (ms(claim.docFixMergedAt) ?? now.getTime());
    return age > DOC_FIX_AUTOMATION_BUDGET_MS ? 'recheck_stalled' : 'recheck_queued';
  }

  const mergedStale = (r: DiscrepancyCandidate) => Boolean(r.docFixTaskId) && isDocFixClaimStale(r);
  if (rows.length === 0 || !rows.every(mergedStale)) return null;
  // The cap is per row: spent once a follow-up has been filed for it. Every
  // row must have had its one follow-up before the owner is asked.
  // No time budget here, unlike the re-run: a row can reach this state long
  // after its merge (a fix that merged days before the writer could reach
  // its row), and it is still owed its one follow-up.
  return rows.every((r) => Boolean(r.autoFollowUpTaskId)) ? 'needs_owner' : 'follow_up_queued';
}

/** §12 ranking: an owner call outranks real unbuilt work outranks a pure doc fix. */
const DISCREPANCY_DIRECTION_RANK: Record<DiscrepancyDirection, number> = {
  contradicted: 0,
  spec_ahead: 1,
  code_ahead: 2,
};

/** §12: cap the queue to the top 10 DISCREPANCY cards (specs) per workspace. */
const DEFAULT_DISCREPANCY_QUEUE_CAP = 10;

function latest(values: Array<Date | string | null | undefined>): number | null {
  const times = values.map((v) => ms(v)).filter((t): t is number => t != null);
  return times.length ? Math.max(...times) : null;
}
function minutesSince(t: number | Date | string | null | undefined, now: Date): number | null {
  const at = typeof t === 'number' ? t : ms(t);
  return at == null ? null : Math.max(0, Math.floor((now.getTime() - at) / 60_000));
}
function hoursSince(t: number | Date | string | null | undefined, now: Date): number | null {
  const m = minutesSince(t, now);
  return m == null ? null : Math.floor(m / 60);
}

/** One card: every open row sharing a (workspace, spec path, direction). */
interface DiscrepancyGroup {
  workspaceId: string;
  workspaceName?: string | null;
  specPath: string;
  direction: DiscrepancyDirection;
  /** Oldest first — the order the card renders its assertion list in. */
  rows: DiscrepancyCandidate[];
  oldestFirstSeen: number;
  promotedMissionId: string | null;
  docFixTaskId: string | null;
  docFixTaskStatus: string | null;
  docFixPrLifecycleStatus: string | null;
  docFixMergedAt: Date | string | null;
  inFlight: boolean;
  /** A merged, rechecked fix that did not close the gap — see isDocFixClaimStale. */
  mergedDocFixTaskId: string | null;
  automation: DocFixAutomation | null;
}

/**
 * Filters, GROUPS and ranks discrepancy ledger rows into `discrepancy` raw
 * items, per docs/design/spec-conformance.md §12.
 *
 * `status: accepted` rows are excluded outright — accepting already recorded
 * that an owner made the call, so re-surfacing it would recreate the
 * Schedules-page problem this design exists to avoid. `resolved` rows have no
 * open gap left to show. Neither is "hidden": both remain queryable via
 * `list_discrepancies` for anyone auditing what's been deferred or fixed.
 *
 * ── One card per spec path, not per assertion ──
 * A document that goes stale goes stale as a document: every assertion in it
 * fails the same status check, so a per-row queue rendered four identical
 * cards for one doc fix and pushed everything else off the visible ten. Rows
 * are grouped on `(workspaceId, specPath, direction)` — direction is part of
 * the key because it decides the card's entire CTA set (§8's promotion table),
 * so two directions on one path are genuinely two different asks and must not
 * be merged into a card that can only offer one of them.
 *
 * Within each workspace, cards rank actionable before agent-handled (a doc fix
 * already in flight must never displace a decision that is still owed), then
 * `contradicted` (needs an owner call before anything else can happen), then
 * `spec_ahead`, then `code_ahead` (lowest stakes) last; within a direction,
 * oldest `first_seen_at` first, so a doc that has survived several check-runs
 * always outranks one that appeared this week. Cards beyond the cap are
 * dropped from `items` but counted in `overflowCount` — an `open` row is never
 * silently dropped without that count reflecting it.
 */
export function buildDiscrepancyItems(
  candidates: DiscrepancyCandidate[],
  options: { cap?: number; now?: Date } = {},
): DiscrepancyQueueResult {
  const cap = options.cap ?? DEFAULT_DISCREPANCY_QUEUE_CAP;
  const now = options.now ?? new Date();
  const open = candidates.filter((c) => c.status === 'open');

  const groups = new Map<string, DiscrepancyGroup>();
  for (const c of open) {
    const key = `${c.workspaceId} ${c.specPath} ${c.direction}`;
    const existing = groups.get(key);
    if (existing) {
      existing.rows.push(c);
    } else {
      groups.set(key, {
        workspaceId: c.workspaceId,
        workspaceName: c.workspaceName,
        specPath: c.specPath,
        direction: c.direction,
        rows: [c],
        oldestFirstSeen: 0,
        promotedMissionId: null,
        docFixTaskId: null,
        docFixTaskStatus: null,
        docFixPrLifecycleStatus: null,
        docFixMergedAt: null,
        inFlight: false,
        mergedDocFixTaskId: null,
        automation: null,
      });
    }
  }

  for (const group of groups.values()) {
    group.rows.sort((a, b) => new Date(a.firstSeenAt).getTime() - new Date(b.firstSeenAt).getTime());
    group.oldestFirstSeen = new Date(group.rows[0].firstSeenAt).getTime();
    group.promotedMissionId = group.rows.find((r) => r.promotedMissionId)?.promotedMissionId ?? null;
    // Any live, non-stale claim on any row in the group owns the whole spec
    // path — the doc fix reconciles the document, not one assertion at a
    // time. A claim the checker has already re-evaluated post-merge and
    // still found wanting (isDocFixClaimStale) does not count: the fix
    // demonstrably did not close this gap. When EVERY row on the path is held
    // that way the card comes back to the owner as "fix merged, still open" —
    // not as a fresh dispatch. If any row is unclaimed (or dead-claimed), a
    // doc fix is still owed for it, so Dispatch stays available; the dispatch
    // route leaves the merged-stale rows out of that task.
    //
    // Which of those states the card is in — and whether automation still owns
    // it — is deriveDocFixAutomation's call, the same function the hourly
    // sweep acts on. `inFlight` now means "agents handling": the card ranks
    // after every owner call and Home files it under the collapsed in-flight
    // list, not "needs you".
    const claimed = group.rows.find((r) => isDocFixInFlight(r) && !isDocFixClaimStale(r));
    const mergedStale = (r: DiscrepancyCandidate) => Boolean(r.docFixTaskId) && isDocFixClaimStale(r);
    group.mergedDocFixTaskId = !claimed && group.rows.every(mergedStale)
      ? group.rows[0].docFixTaskId ?? null
      : null;
    group.automation = deriveDocFixAutomation(group.rows, now);
    group.inFlight = isDocFixAutomationAgentHandled(group.automation);
    group.docFixTaskId = claimed?.docFixTaskId ?? null;
    group.docFixTaskStatus = claimed?.docFixTaskStatus ?? null;
    group.docFixPrLifecycleStatus = claimed?.docFixPrLifecycleStatus ?? null;
    group.docFixMergedAt = claimed?.docFixMergedAt ?? null;
  }

  const byWorkspace = new Map<string, DiscrepancyGroup[]>();
  for (const g of groups.values()) {
    const bucket = byWorkspace.get(g.workspaceId);
    if (bucket) bucket.push(g);
    else byWorkspace.set(g.workspaceId, [g]);
  }

  const items: WaitingOnYouRawItem[] = [];
  let overflowCount = 0;

  for (const bucket of byWorkspace.values()) {
    const ranked = [...bucket].sort((a, b) => {
      const flightDiff = Number(a.inFlight) - Number(b.inFlight);
      if (flightDiff !== 0) return flightDiff;
      const dirDiff = DISCREPANCY_DIRECTION_RANK[a.direction] - DISCREPANCY_DIRECTION_RANK[b.direction];
      if (dirDiff !== 0) return dirDiff;
      return a.oldestFirstSeen - b.oldestFirstSeen;
    });
    overflowCount += Math.max(0, ranked.length - cap);
    for (const g of ranked.slice(0, cap)) {
      items.push({
        kind: 'discrepancy',
        discrepancyId: g.rows[0].id,
        discrepancyIds: g.rows.map((r) => r.id),
        specPath: g.specPath,
        assertionId: g.rows[0].assertionId,
        assertionIds: g.rows.map((r) => r.assertionId),
        direction: g.direction,
        firstSeenAt: new Date(g.oldestFirstSeen),
        promotedMissionId: g.promotedMissionId,
        docFixTaskId: g.docFixTaskId,
        docFixTaskStatus: g.docFixTaskStatus,
        docFixPrLifecycleStatus: g.docFixPrLifecycleStatus,
        mergedDocFixTaskId: g.mergedDocFixTaskId,
        docFixAutomation: g.automation,
        docFixFollowUpTaskId: g.rows.find((r) => r.autoFollowUpTaskId)?.autoFollowUpTaskId ?? null,
        recheckDispatchedMinutesAgo: minutesSince(latest(g.rows.map((r) => r.recheckRequestedAt)), now),
        docFixMergedHoursAgo: hoursSince(g.docFixMergedAt ?? latest(g.rows.map((r) => r.docFixMergedAt)), now),
        lastCheckedHoursAgo: hoursSince(latest(g.rows.map((r) => r.lastCheckedAt)), now),
        declaredStatus: g.rows.find((r) => r.declaredStatus)?.declaredStatus ?? null,
        workspaceId: g.workspaceId,
        workspaceName: g.workspaceName ?? undefined,
      });
    }
  }

  return { items, overflowCount };
}

/**
 * Merges waitingOnYou items and escalationInbox items into a single
 * deduplicated action queue keyed by subject (PR URL, worker ID, or task ID).
 *
 * When the same PR appears in both lists, escalation data wins (taskId,
 * workspaceName, waitingMinutes) and waitingOnYou data enriches it
 * (unblockCount, missionTitle).
 *
 * TODO: replace interim (prUrl / task:id / worker:id) keys with subject-anchor
 * field once mission:subject-anchors 1-7 lands.
 *
 * ── Freshness invariant ──
 * A card that asks the human to merge is a claim about the PR's CURRENT state.
 * This function refuses to make that claim on stale input: a row whose
 * lifecycle has not been verified inside its tier SLA, or a PR that is
 * genuinely open but ancient, degrades to a STALE card carrying its age and
 * the reason. The degradation is one-directional — nothing here ever promotes
 * a card INTO a merge CTA — so the failure mode is "we told you we don't know",
 * never "we told you to merge something that merged 90 days ago".
 *
 * Rows already retired to terminal `unresolvable` are dropped entirely; they
 * are surfaced on /app/health instead, which honours facae217 AC-6 (never
 * silently dropped) without honouring it on the action queue.
 */
export function buildActionQueue(
  waitingOnYou: WaitingOnYouRawItem[],
  escalationInbox: EscalationRawItem[],
  options: BuildActionQueueOptions = {},
): ActionQueueItem[] {
  const map = new Map<string, ActionQueueItem>();
  const now = options.now ?? new Date();

  // Escalation items carry task links, workspace context, and merge buttons — add first
  for (const item of escalationInbox) {
    if (item.prLifecycleStatus === 'unresolvable') continue;
    const key = item.prUrl ?? `task:${item.taskId}`;
    // BLOCKED: conflict-resolution retries exhausted — human must decide.
    // RESOLVING: conflict retry is live — agent is handling it, not the human.
    // Otherwise: human-gate = MERGE, agent-review = REVIEW.
    // Precedence: a conflict outranks CI (an unmergeable branch is why CI
    // cannot pass), and any CI gate outranks the merge policy — a red PR is not
    // waiting on the human until no agent is left working on it.
    const ciGate = item.ciGate ?? null;
    const baseChip: ActionChip = item.deadZoneExhausted
      ? 'BLOCKED'
      : item.conflictRetryTaskId
        ? 'RESOLVING'
        : ciGate?.kind === 'fixing'
          ? 'FIXING_CI'
          : ciGate?.kind === 'running'
            ? 'CI_RUNNING'
            : ciGate?.kind === 'blocked'
              ? 'BLOCKED'
              : item.autoMerge
                ? 'AUTO_MERGE'
                : item.policyTier === 'agent-review' ? 'REVIEW' : 'MERGE';

    // Fail CLOSED. Only a merge CTA is gated — a BLOCKED or agent-handled card
    // makes no claim that the PR is still open, so staleness does not change
    // what it says.
    const staleGate = MERGE_CTA_CHIPS.has(baseChip)
      ? resolveStaleGate({
          prOpenedAt: item.prOpenedAt ?? null,
          prLifecycleVerifiedAt: item.prLifecycleVerifiedAt,
          now,
        })
      : null;
    const chip: ActionChip = staleGate ? 'STALE' : baseChip;

    map.set(key, {
      subjectKey: key,
      chip,
      staleGate,
      cardAgeHours: staleGate?.ageHours
        ?? (item.prOpenedAt
          ? Math.floor((now.getTime() - item.prOpenedAt.getTime()) / 3_600_000)
          : null),
      prUrl: item.prUrl ?? undefined,
      prNumber: item.prNumber ?? undefined,
      taskId: item.taskId,
      taskTitle: item.taskTitle,
      workspaceId: item.workspaceId || undefined,
      workspaceName: item.workspaceName || undefined,
      missionId: item.missionId ?? undefined,
      missionTitle: item.missionTitle ?? undefined,
      waitingMinutes: item.waitingMinutes,
      ciGate,
      // A CI block states its own reason; the merge-policy reason ("manual merge
      // required") would be misleading while the PR cannot merge at all. A stale
      // card outranks both: "manual merge required" on a PR that merged 90 days
      // ago is the exact lie this whole change exists to stop telling.
      escalationReason: staleGate
        ? staleGate.reason
        : ciGate?.kind === 'blocked' ? ciGate.reason : item.escalationReason,
      hasEscalationNote: item.hasEscalationNote ?? false,
      recommendation: ciGate?.kind === 'blocked'
        ? ciGate.recommendation
        : item.recommendation ?? null,
      verdictSummary: item.verdictSummary ?? null,
      approvedSha: item.approvedSha ?? null,
      headSha: item.headSha ?? null,
      conflictRetryTaskId: item.conflictRetryTaskId ?? undefined,
      conflictRetryIteration: item.conflictRetryIteration ?? undefined,
      deadZoneExhausted: item.deadZoneExhausted ?? undefined,
      deadZoneLastRetryTaskId: item.deadZoneLastRetryTaskId ?? undefined,
      missionMergeBlockedReason: item.missionMergeBlockedReason ?? null,
    });
  }

  for (const item of waitingOnYou) {
    if (item.kind === 'merge') {
      if (item.prLifecycleStatus === 'unresolvable') continue;
      const key = item.prUrl ?? `upstream:${item.upstreamTaskId}`;
      const existing = map.get(key);
      if (existing) {
        // Same PR is already in the map from escalation — enrich with unblock context
        map.set(key, {
          ...existing,
          upstreamTaskTitle: item.upstreamTaskTitle,
          unblockCount: (existing.unblockCount ?? 0) + (item.unblockCount ?? 0),
          missionId: existing.missionId ?? item.missionId,
          missionTitle: existing.missionTitle ?? item.missionTitle,
          unblockMissionTitle: item.missionTitle,
          prLifecycleStatus: item.prLifecycleStatus ?? existing.prLifecycleStatus,
        });
      } else {
        // Same fail-closed rule as the escalation branch: a blocker-derived
        // merge card is still a claim that this PR is open right now.
        const staleGate = resolveStaleGate({
          prOpenedAt: item.prOpenedAt ?? null,
          prLifecycleVerifiedAt: item.prLifecycleVerifiedAt,
          now,
        });
        map.set(key, {
          subjectKey: key,
          chip: staleGate ? 'STALE' : 'MERGE',
          staleGate,
          cardAgeHours: staleGate?.ageHours ?? null,
          escalationReason: staleGate?.reason ?? null,
          prUrl: item.prUrl,
          prNumber: item.prNumber,
          prLifecycleStatus: item.prLifecycleStatus ?? undefined,
          upstreamTaskTitle: item.upstreamTaskTitle,
          unblockCount: item.unblockCount,
          missionId: item.missionId,
          missionTitle: item.missionTitle,
          unblockMissionTitle: item.missionTitle,
        });
      }
    } else if (item.kind === 'answer') {
      const key = `worker:${item.workerId}`;
      map.set(key, {
        subjectKey: key,
        chip: 'QUESTION',
        workerId: item.workerId,
        taskId: item.taskId,
        taskTitle: item.taskTitle,
        question: item.question,
        missionId: item.missionId,
        missionTitle: item.missionTitle,
      });
    } else if (item.kind === 'reconnect') {
      const key = `connector:${item.connectorId}`;
      if (!map.has(key)) {
        map.set(key, {
          subjectKey: key,
          chip: 'RECONNECT',
          connectorId: item.connectorId,
          connectorName: item.connectorName,
        });
      }
    } else if (item.kind === 'approve') {
      const key = `task:${item.taskId}`;
      if (!map.has(key)) {
        map.set(key, {
          subjectKey: key,
          chip: 'APPROVE',
          taskId: item.taskId,
          taskTitle: item.taskTitle,
          missionId: item.missionId,
          missionTitle: item.missionTitle,
        });
      }
    } else if (item.kind === 'discrepancy') {
      // Subject key is the CARD's identity: the spec doc plus the direction
      // that decides its CTA set. Still structural, still derived from the
      // ledger's own identity fields (§7/§12) — just at the grain the card is
      // now rendered at, so one document is one row in the queue.
      const key = `discrepancy:${item.workspaceId}:${item.specPath}:${item.direction}`;
      if (!map.has(key)) {
        map.set(key, {
          subjectKey: key,
          // Agent-handled only while automation still owns the card. A row
          // the automation gave up on (stalled, or fix + follow-up merged and
          // still open) is an owner call again even though a task is linked.
          chip: (item.docFixAutomation !== undefined
            ? isDocFixAutomationAgentHandled(item.docFixAutomation)
            : Boolean(item.docFixTaskId))
            ? 'FIXING_SPEC'
            : 'DISCREPANCY',
          discrepancyId: item.discrepancyId,
          discrepancyIds: item.discrepancyIds,
          specPath: item.specPath,
          assertionId: item.assertionId,
          assertionIds: item.assertionIds,
          direction: item.direction,
          // Age in hours, not the raw Date — same boundary rule every other
          // card observes (compare STALE's cardAgeHours): a client component
          // never receives a raw Date prop from this module.
          cardAgeHours: item.firstSeenAt
            ? Math.floor((now.getTime() - item.firstSeenAt.getTime()) / 3_600_000)
            : null,
          promotedMissionId: item.promotedMissionId ?? null,
          docFixTaskId: item.docFixTaskId ?? null,
          docFixTaskStatus: item.docFixTaskStatus ?? null,
          docFixPrLifecycleStatus: item.docFixPrLifecycleStatus ?? null,
          mergedDocFixTaskId: item.mergedDocFixTaskId ?? null,
          docFixAutomation: item.docFixAutomation,
          docFixFollowUpTaskId: item.docFixFollowUpTaskId ?? null,
          recheckDispatchedMinutesAgo: item.recheckDispatchedMinutesAgo ?? null,
          docFixMergedHoursAgo: item.docFixMergedHoursAgo ?? null,
          lastCheckedHoursAgo: item.lastCheckedHoursAgo ?? null,
          declaredStatus: item.declaredStatus ?? null,
          workspaceId: item.workspaceId,
          workspaceName: item.workspaceName ?? undefined,
        });
      }
    } else if (item.kind === 'decide') {
      // Keyed on mission + fingerprint, not note id: the escalation note is a
      // single row that stays open until the owner acts or a verdict changes,
      // so this is really just the standard subject-key dedupe — but keying on
      // the fingerprint rather than the note id future-proofs against a caller
      // that (incorrectly) re-creates the note across cycles.
      const key = `decide:${item.missionId}:${item.criteriaFingerprint ?? 'none'}`;
      if (!map.has(key)) {
        map.set(key, {
          subjectKey: key,
          chip: 'DECIDE',
          missionId: item.missionId,
          missionTitle: item.missionTitle,
          noteId: item.noteId,
          noteTitle: item.noteTitle,
          question: item.question,
          recommendation: item.recommendation ?? null,
        });
      }
    }
  }

  const snoozed = options.snoozedSubjectKeys;
  return [...map.values()]
    .filter((item) => !snoozed?.has(item.subjectKey))
    .sort((a, b) => {
    const chipDiff = CHIP_ORDER.indexOf(a.chip) - CHIP_ORDER.indexOf(b.chip);
    if (chipDiff !== 0) return chipDiff;
    // Within MERGE: most impactful (unblocks more tasks) first, then arc-linked
    // ahead of orphans, then freshest — so a 90-day PR nobody is waiting on
    // never outranks the merge that unblocks a live mission.
    if (a.chip === 'MERGE') {
      const impactDiff = (b.unblockCount ?? 0) - (a.unblockCount ?? 0);
      if (impactDiff !== 0) return impactDiff;
      const arcDiff = Number(!!b.missionId) - Number(!!a.missionId);
      if (arcDiff !== 0) return arcDiff;
      return (a.waitingMinutes ?? 0) - (b.waitingMinutes ?? 0);
    }
    // Within DISCREPANCY: §12's ranking, re-applied here (not just trusted
    // from buildDiscrepancyItems' own per-workspace ordering) so a queue
    // merged across several workspaces still ranks correctly as one list.
    if (a.chip === 'DISCREPANCY' || a.chip === 'FIXING_SPEC') {
      const dirDiff = (DISCREPANCY_DIRECTION_RANK[a.direction ?? 'code_ahead'] ?? 2)
        - (DISCREPANCY_DIRECTION_RANK[b.direction ?? 'code_ahead'] ?? 2);
      if (dirDiff !== 0) return dirDiff;
      // Oldest (largest cardAgeHours) first within a direction.
      return (b.cardAgeHours ?? 0) - (a.cardAgeHours ?? 0);
    }
    // Within STALE: oldest first. These are cleanup decisions, and the 90-day
    // one is the least ambiguous.
    if (a.chip === 'STALE') {
      return (b.cardAgeHours ?? 0) - (a.cardAgeHours ?? 0);
    }
    return 0;
  });
}

export interface ActionQueueAgeMetrics {
  /** Cards carrying a known age — the denominator for everything below. */
  measured: number;
  /** p99 of card_age_hours. The alarm this change exists to make possible. */
  p99AgeHours: number;
  /** Cards whose PR is older than a week. Expected steady state: 0. */
  olderThan7dCount: number;
  /** Cards degraded to STALE, by reason. */
  staleUnverified: number;
  staleAncient: number;
}

/** Hours in a week — the reporting threshold for a card that should not exist. */
const WEEK_HOURS = 7 * 24;

/**
 * Age telemetry for a built queue.
 *
 * Emitted so the next regression pages instead of arriving as a phone
 * screenshot: four MERGE cards up to 90 days old were visible on Home for
 * months with nothing in the system counting them.
 */
export function summariseActionQueueAge(items: ActionQueueItem[]): ActionQueueAgeMetrics {
  const ages = items
    .map(i => i.cardAgeHours)
    .filter((h): h is number => typeof h === 'number' && Number.isFinite(h))
    .sort((a, b) => a - b);

  // Nearest-rank p99: on a queue of a handful of cards this is the max, which
  // is the honest answer — one 90-day card IS the tail.
  const p99AgeHours = ages.length === 0
    ? 0
    : ages[Math.min(ages.length - 1, Math.ceil(ages.length * 0.99) - 1)];

  return {
    measured: ages.length,
    p99AgeHours,
    olderThan7dCount: ages.filter(h => h > WEEK_HOURS).length,
    staleUnverified: items.filter(i => i.staleGate?.kind === 'unverified').length,
    staleAncient: items.filter(i => i.staleGate?.kind === 'ancient').length,
  };
}
