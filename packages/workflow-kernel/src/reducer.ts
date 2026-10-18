/**
 * The workflow kernel's transition table as a pure function
 * (docs/specs/workflow-state-kernel.md §6). `reduce(view, command)` reads a
 * snapshot of one delivery (row, rounds, ledger) and returns exactly one of
 * `apply` (with the CAS guard, patch, round/ledger writes and effects the
 * kernel commits in one statement), `duplicate`, `stale` or `rejected`.
 *
 * No I/O: every GitHub fact a transition needs arrives inside the command
 * (R2: the caller took a live read after the hint). Ids for rows the statement
 * inserts are drawn from `opts.newId` so the same statement can bind them.
 *
 * Live for the review and CI families (Slice A parts 1–2): routes reach it
 * through seam.ts.
 */
import type {
  ApplyDecision,
  AttemptOp,
  Command,
  CurrentView,
  Decision,
  DeliveryPatch,
  EffectSpec,
  FindingOp,
  LivePr,
  RoundOp,
} from './commands';
import { deltaApprovalEligibility, PUSH_TRIGGERS, type DeltaReading, type RoundTrigger } from './delta-approval';
import { addressFindings, applyVerdictToFindings, describeFinding, isTaskId, openRequiredFindings } from './findings';
import {
  isHumanActor,
  isTerminal,
  type AttemptFamily,
  type AttemptMode,
  type AttemptSnapshot,
  type CompositionAttestation,
  type ConstituentEvidence,
  type DeliverySnapshot,
  type DeliveryState,
  type KernelView,
  type PolicyEvidence,
  type RoundKind,
  type RoundSnapshot,
} from './types';
import {
  DEFAULT_TREADMILL_MAX_BASE_COMMITS,
  TREADMILL_EXHAUSTED_MAX_BASE_COMMITS,
  judgeBaseDelta,
  type BaseDeltaFact,
  type BaseDeltaVerdict,
} from './base-delta';

export interface ReduceOptions {
  newId?: () => string;
}

const NON_TERMINAL: DeliveryState[] = [
  'WORKING', 'AWAITING_PUSH', 'AWAITING_REVIEW', 'CHANGES_REQUESTED', 'FIXING', 'REPAIRING',
  'BLOCKED_ON_TRUNK', 'APPROVED', 'LANDING', 'ESCALATED', 'CLOSED_UNMERGED',
];

/** Default bound on mechanical attempts per head (§6.7). */
export const DEFAULT_MAX_MECHANICAL = 2;
/** Mechanical base refreshes a delivery may take across heads before landing needs a person (§16 S15; `treadmillMaxRefreshes`). */
export const DEFAULT_MAX_BEHIND_REFRESHES = 3;
/**
 * S15 cycles: how many treadmill cycles (each a fresh `DEFAULT_MAX_BEHIND_REFRESHES`
 * budget) a delivery gets before the escalation stays with a person. The first
 * is the original budget; each later one is opened by `TreadmillCycleRestarted`
 * after the landing cooldown.
 */
export const MAX_TREADMILL_CYCLES = 3;
/** The `trigger_reason` of the marker row that opens a new treadmill cycle. */
export const TREADMILL_CYCLE_MARKER = 'treadmill_cycle';
/**
 * §10.3 critical effects and the states they are owed in: a dead one escalates
 * the delivery while it is still in one of them (`any`: every non-terminal state).
 */
export const DEAD_EFFECT_OWED_IN: Partial<Record<EffectSpec['kind'], DeliveryState[] | 'any'>> = {
  merge_call: ['LANDING'],
  verify_merge: ['LANDING'],
  push_recovery: ['AWAITING_PUSH'],
  dispatch_fix: ['CHANGES_REQUESTED'],
  dispatch_review: ['AWAITING_REVIEW'],
  post_review: 'any',
  // A mechanical repair is REPAIRING's only exit while its row is queued (edc02148).
  refresh_branch: ['REPAIRING'],
  renumber_migration: ['REPAIRING'],
};

/** The mechanical repair effects: dead, they end their bound attempt (edc02148). */
const MECHANICAL_REPAIR_EFFECTS: ReadonlySet<EffectSpec['kind']> = new Set(['refresh_branch', 'renumber_migration']);

/** An escalation a further review round answers (T5 from ESCALATED without a person). */
export function isReviewEscalation(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && reason.startsWith('review_');
}

/**
 * Task 2ded4e88: a spent review budget is final for the delivery, not for one round. Once a
 * delivery escalates `review_exhausted`, nothing automatic queues another review: a push is
 * recorded, an agent's or the floor's request is refused, and a CI or conflict repair out of the
 * escalation (a90fc99b) hands the PR back to the person instead of to a reviewer. Only a person
 * acting lifts it: a forced round, a resolve, an approval.
 *
 * The repair carries the hold in `resumeState = 'ESCALATED'` (a value nothing else writes: T25
 * only ever resumes to AWAITING_REVIEW or APPROVED), because REPAIRING, BLOCKED_ON_TRUNK and
 * AWAITING_PUSH replace `stateReason` with their own.
 */
/**
 * States that keep a spent review budget's hold in `resumeState` while they run: the repair, a
 * red base during it, a repair whose push GitHub does not show yet (AWAITING_PUSH, and the
 * push_undeliverable escalation it can end in), an escalation stacked on top of it, and a closed
 * PR (task 79649a80: a close and a reopen is not a person lifting the budget, so T19 returns to
 * ESCALATED(review_exhausted) instead of starting a round).
 */
const HOLD_CARRIERS: ReadonlySet<DeliveryState> = new Set(['REPAIRING', 'BLOCKED_ON_TRUNK', 'AWAITING_PUSH', 'ESCALATED', 'CLOSED_UNMERGED']);

export function reviewBudgetHeld(d: Pick<DeliverySnapshot, 'state' | 'stateReason' | 'resumeState'>): boolean {
  if (d.state === 'ESCALATED' && d.stateReason === 'review_exhausted') return true;
  return d.resumeState === 'ESCALATED' && HOLD_CARRIERS.has(d.state);
}

/** The person's acts that end a spent review budget's hold (2ded4e88). */
function liftsReviewBudget(cmd: Command): boolean {
  if (!isHumanActor(cmd.actor)) return false;
  return (cmd.type === 'ReviewRequested' && cmd.forced === true) || cmd.type === 'HumanResolve';
}

/**
 * Task c1d66a6a: the review budget counts change-request cycles, not every round. A round started
 * after an approval at another head (`startRound` records `scope.deltaApproval` exactly then: a
 * re-check of what a repair or a push changed since the approval) is a verification and spends
 * nothing. A re-check that asks for changes gets one repair cycle before the delivery is a
 * person's, even with the counted budget spent; the review of that repair counts as usual. A
 * delivery that never had an approval spends exactly as before (2ded4e88).
 */
export function isRecheckAfterApproval(r: Pick<RoundSnapshot, 'scope'> | null | undefined): boolean {
  const da = r?.scope?.deltaApproval;
  return da != null && typeof da === 'object';
}

/** The rounds up to `upTo` (default the current one) that spend the review budget. */
export function spentReviewRounds(view: Pick<KernelView, 'delivery' | 'rounds'>, upTo?: number): number {
  const n = upTo ?? view.delivery?.currentRound ?? 0;
  const rechecks = new Set(view.rounds.filter((r) => r.round <= n && isRecheckAfterApproval(r)).map((r) => r.round));
  return n - rechecks.size;
}

/**
 * A re-check's one repair cycle is used once a fix was dispatched for it, or a later counted round
 * was decided (the delivery moved past it): re-entering its verdict then owes no second cycle.
 */
function recheckCycleUsed(view: Pick<KernelView, 'rounds' | 'attempts'>, round: Pick<RoundSnapshot, 'id' | 'round'>): boolean {
  if (view.attempts.some((a) => a.family === 'review_fix' && a.triggerReason === round.id)) return true;
  return view.rounds.some((r) => r.round > round.round && r.status === 'decided' && !isRecheckAfterApproval(r));
}

/** Whether a request for changes at `round` spends the last of the budget (escalates instead of a fix). */
function budgetSpentAt(view: Pick<KernelView, 'delivery' | 'rounds'>, round: Pick<RoundSnapshot, 'round' | 'scope'>, maxRounds: number): boolean {
  if (isRecheckAfterApproval(round)) return false;
  return spentReviewRounds(view, round.round) >= maxRounds;
}

/** The patch that carries a spent review budget into a repair that starts from its escalation. */
function holdThroughRepair(d: DeliverySnapshot): Pick<DeliveryPatch, 'resumeState'> {
  return d.state === 'ESCALATED' && d.stateReason === 'review_exhausted' ? { resumeState: 'ESCALATED' } : {};
}


/**
 * An escalation a machine repair may still move first (task a90fc99b): a
 * reviewer's or the policy's call on the change. A person can't merge a PR
 * whose CI is red or whose migration number collides, so the repair runs
 * first and the person decides on a mergeable head. Not a landing hand-off or
 * a spent budget: those already are the person's next move.
 */
export function isRepairableEscalation(reason: string | null | undefined): boolean {
  return isReviewEscalation(reason) || reason === 'policy_human';
}

/**
 * Attempts that ended `unproven` (reported success, nothing provable on
 * GitHub: no diff, no push) that a family may absorb before they count toward
 * its cap. A false success is not a try at the fix, so it does not spend the
 * budget; the allowance keeps an agent that always claims success from
 * looping forever.
 */
export const UNPROVEN_ATTEMPT_ALLOWANCE = 2;

/** `push_recovery` backoff (§9): 2m, 10m, 30m, then T22. */
export const PUSH_RECOVERY_BACKOFF_MS = [120_000, 600_000, 1_800_000] as const;

// ── Pure helpers exported for callers and tests ─────────────────────────────

/**
 * §9 `deliveryProof`: a local commit is never delivery. The remote must have
 * moved off the bound head AND contain the attempt's work.
 */
export function deliveryProof(i: {
  boundHeadSha: string | null;
  localHeadSha: string | null;
  liveHeadSha: string | null;
  liveContainsLocal?: boolean;
  contentDiffChanged?: boolean;
}): { holds: boolean; reason: string } {
  if (!i.liveHeadSha) return { holds: false, reason: 'no_live_head' };
  if (i.liveHeadSha === i.boundHeadSha) return { holds: false, reason: 'head_not_advanced' };
  if (i.localHeadSha) {
    if (i.liveHeadSha === i.localHeadSha || i.liveContainsLocal === true) return { holds: true, reason: 'live_head_contains_local' };
    return { holds: false, reason: 'live_head_missing_local' };
  }
  // Runner died before reporting L: proof is (1) plus a changed content diff,
  // or a caller-verified containment.
  if (i.contentDiffChanged === true || i.liveContainsLocal === true) return { holds: true, reason: 'head_advanced_content_changed' };
  return { holds: false, reason: 'local_head_unknown' };
}

/** What covers `head` for landing. Ordinary verdicts are exact-head (plus recorded equivalents). */
/**
 * The newest decided review round, when its verdict still stands against
 * landing (§13.13 rules 2 and 6, until the findings model of S5): it asked for
 * changes or escalated, and no later round has decided since.
 */
export function openVerdict(view: Pick<KernelView, 'rounds'>): RoundSnapshot | null {
  const newest = view.rounds.filter((r) => r.status === 'decided').sort((a, b) => b.round - a.round)[0];
  if (!newest) return null;
  const v = newest.effectiveVerdict ?? newest.verdict;
  return v === 'request_changes' || v === 'escalate' ? newest : null;
}

export function headCoverage(d: Pick<DeliverySnapshot, 'approvedHeads' | 'approvalBasis' | 'compositionHeads'> & { currentHeadSha?: string | null }, head: string | null):
  'verdict' | 'human' | 'composition' | 'policy' | 'none' {
  if (!head) return 'none';
  // Policy approval (no review required) covers whatever head is current; it is never a verdict.
  if (d.approvalBasis === 'policy') return head === d.currentHeadSha ? 'policy' : 'none';
  if (d.approvedHeads.includes(head)) return d.approvalBasis === 'human' ? 'human' : 'verdict';
  if (d.compositionHeads.includes(head)) return 'composition';
  return 'none';
}

/**
 * §5.7 rule 1: what a ledger family has spent and may spend. Allocation is
 * consumption: every dispatched row counts whoever authored the commit it
 * produced, except a `skipped` one (§10.5: revalidation found nothing to do,
 * so no work was dispatched). The cap is the configured one, raised only by a
 * person's BudgetExtended row (trigger=human, its own max_attempts).
 */
export function ledgerBudget(attempts: AttemptSnapshot[], family: AttemptFamily, configuredMax: number, mode: AttemptMode = 'agent'): { spent: number; max: number } {
  const rows = attempts.filter((a) => a.family === family && a.mode === mode);
  const dispatched = rows.filter((a) => a.status !== 'skipped');
  const unproven = dispatched.filter((a) => a.outcome === 'unproven').length;
  const spent = dispatched.length - Math.min(unproven, UNPROVEN_ATTEMPT_ALLOWANCE);
  const extended = rows.filter((a) => a.trigger === 'human').reduce((m, a) => Math.max(m, a.maxAttempts), 0);
  return { spent, max: Math.max(configuredMax, extended) };
}

/**
 * §5.7 rule 4 for one row (295486ba): its 1-based place among the family's attempts that were
 * dispatched, the N of its "attempt N of M". `attempt_no` is the row's identity and is never
 * reused, so after a skipped row it runs ahead of the count; a skipped row has no place (null).
 */
export function attemptOrdinal(attempts: AttemptSnapshot[], a: AttemptSnapshot): number | null {
  if (a.status === 'skipped') return null;
  return attempts.filter((r) => r.family === a.family && r.mode === a.mode && r.status !== 'skipped' && r.attemptNo <= a.attemptNo).length;
}

/** §5.7 rule 4: the one 1-based "attempt N of M" view of a ledger family. */
export function attemptView(attempts: AttemptSnapshot[], family: AttemptFamily, defaultMax = 3): { n: number; m: number } {
  const rows = attempts.filter((a) => a.family === family && a.mode === 'agent' && a.status !== 'skipped');
  if (rows.length === 0) return { n: 0, m: defaultMax };
  return { n: rows.length, m: rows.reduce((m, a) => Math.max(m, a.maxAttempts), 0) };
}

/**
 * Mechanical check of a composition attestation (release / integration PR).
 * Each constituent's verdict must be bound to the head it was made on, be a
 * decided approve, and the change must have landed at that head or at a head
 * its own delivery recorded as equivalent. Nothing here lets the aggregate
 * head borrow a verdict: the result can only ever mark the head as
 * composition-covered.
 */
export function verifyCompositionAttestation(
  att: CompositionAttestation,
  evidence: ConstituentEvidence[],
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!att.aggregateHeadSha || !att.baseSha) reasons.push('aggregate_head_missing');
  if (att.aggregateHeadSha && att.aggregateHeadSha === att.baseSha) reasons.push('aggregate_equals_base');
  if (att.method !== 'tree_equal' && att.method !== 'patch_set_equal') reasons.push('method_not_mechanical');
  if (att.constituents.length === 0) reasons.push('no_constituents');
  const seen = new Set<string>();
  for (const c of att.constituents) {
    if (seen.has(c.roundId)) { reasons.push(`duplicate_constituent:${c.roundId}`); continue; }
    seen.add(c.roundId);
    const ev = evidence.find((e) => e.roundId === c.roundId);
    if (!ev) { reasons.push(`constituent_unresolved:${c.roundId}`); continue; }
    // The cited round must be the constituent's own: its delivery, its PR, this repo.
    if (ev.deliveryId !== c.deliveryId || ev.prNumber !== c.prNumber || ev.repoFullName !== att.repoFullName) {
      reasons.push(`constituent_round_foreign:${c.roundId}`);
    }
    if (ev.roundHeadSha !== c.reviewedHeadSha) reasons.push(`constituent_head_mismatch:${c.roundId}`);
    if (ev.roundStatus !== 'decided' || ev.effectiveVerdict !== 'approve') reasons.push(`constituent_not_approved:${c.roundId}`);
    // §13.13 rule 1: an approve is the constituent's word only while it is its LATEST decided
    // round at that head, its delivery is not blocked there, and no finding of it is open.
    if (ev.latestDecidedVerdictAtHead != null && ev.latestDecidedVerdictAtHead !== 'approve') reasons.push(`constituent_approval_superseded:${c.roundId}`);
    if ((ev.deliveryState === 'CHANGES_REQUESTED' || ev.deliveryState === 'ESCALATED') && ev.deliveryHeadSha === c.reviewedHeadSha) reasons.push(`constituent_delivery_blocked:${c.roundId}`);
    if ((ev.openFindings ?? 0) > 0) reasons.push(`constituent_open_findings:${c.roundId}`);
    const unrecorded = c.equivalentHeadShas.filter((h) => !ev.deliveryApprovedHeads.includes(h));
    if (unrecorded.length > 0) reasons.push(`constituent_equivalence_unrecorded:${c.roundId}`);
    // GitHub merged the reviewed head or a head its delivery recorded as equivalent…
    const mergedOk = !!c.mergedHeadSha && (c.mergedHeadSha === c.reviewedHeadSha
      || (c.equivalentHeadShas.includes(c.mergedHeadSha) && ev.deliveryApprovedHeads.includes(c.mergedHeadSha)));
    if (!mergedOk) reasons.push(`constituent_landed_unproven:${c.roundId}`);
    // …and the composed commit carrying it makes exactly the reviewed change:
    // two patch-ids from two independent reads (the landed commit, the reviewed head).
    const hex = /^[0-9a-f]{64}$/;
    if (!c.landedSha || !hex.test(c.landedPatchId ?? '') || c.landedPatchId !== c.reviewedPatchId) {
      reasons.push(`constituent_patch_unproven:${c.roundId}`);
    }
  }
  if (att.novelDelta.result === 'present' && att.novelDelta.paths.length === 0) reasons.push('novel_delta_paths_missing');
  return { ok: reasons.length === 0, reasons };
}

/**
 * Idempotency keys that depend only on the command (and the delivery's
 * identity), so a replay is recognised even after `version` moved (§7.4).
 * Commands whose key embeds mutable state (the next round number) return
 * null; their replays are answered by the reducer's own preconditions.
 */
/** One CI reading per head, verdict and version: a replay is a duplicate, a re-run that flips it is not. */
const ciFactKey = (d: Pick<DeliverySnapshot, 'id' | 'version'>, headSha: string, verdict: 'red' | 'green' | 'running'): string =>
  `cifact:${d.id}:${headSha}:${verdict}@v${d.version}`;

export function stableIdempotencyKey(cmd: Command, d: DeliverySnapshot | null): string | null {
  const pr = d?.repoFullName && d.prNumber != null ? `${d.repoFullName}#${d.prNumber}` : null;
  switch (cmd.type) {
    case 'DeliveryOpened': return `open:${cmd.ownerTaskId}`;
    case 'PrBound': return `bind:${cmd.repoFullName}#${cmd.prNumber}`;
    case 'HeadObserved': return pr && d ? headObservationKey(pr, d.currentHeadSha, cmd.live.headSha, d.version) : null;
    case 'AttemptStarted': return `start:${cmd.taskId}:${cmd.claimedAt}`;
    case 'AttemptEnded': return `end:${cmd.workerId}`;
    case 'AttemptRequeued': return `requeue:${cmd.workerId}`;
    case 'AttemptReopened': return reopenKey(cmd);
    case 'AttemptWithdrawn': return withdrawKey(cmd);
    // An inconclusive verdict is its reviewer's failure of the round (T27's key), not the round's verdict:
    // the reviewer asked next at the same round still answers it.
    case 'ReviewVerdictRecorded':
      if (cmd.evidenceSha !== undefined && cmd.evidenceSha !== cmd.headBound) return cmd.reviewerTaskId ? roundFailKey(cmd.roundId, cmd.reviewerTaskId) : null;
      return `verdict:${cmd.roundId}`;
    case 'FixClaimed': return `claim:${cmd.attemptId}`;
    case 'FindingDisposed': return `dispose:${cmd.findingId}:${cmd.disposition}`;
    case 'HumanApproved': return pr ? `approve:${pr}:${cmd.reviewId}` : null;
    case 'PolicyMergeApproved': return pr ? `policymerge:${pr}:${cmd.headSha}` : null;
    // One landing request per (head, version): a replay is a duplicate, while a person re-landing
    // the same head after a refusal (the delivery moved on since) is a new request.
    case 'LandingRequested': return pr && d ? landingKey(pr, cmd.headSha, d.version) : null;
    case 'MergeCallResult': return pr ? mergeResultKey(pr, cmd) : null;
    case 'PrMerged': return pr ? `merged:${pr}` : null;
    case 'PrClosedUnmerged': return pr ? `closed:${pr}:${cmd.live.updatedAt ?? 'unknown'}` : null;
    case 'PrReopened': return pr ? `reopen:${pr}:${cmd.live.updatedAt ?? 'unknown'}` : null;
    case 'BaseChanged': return pr && d && cmd.live.baseRef ? baseChangeKey(pr, d.baseRef, cmd.live.baseRef, d.version) : null;
    // The target is part of the key: a second, different target must reach the reducer and be refused (edge_exists).
    case 'SupersessionRecorded': return pr ? `supersede:${pr}:${cmd.target.repoFullName}#${cmd.target.prNumber}` : null;
    case 'RepairNotNeeded': return `notneeded:${cmd.attemptId}`;
    case 'CiGreenObserved': return d?.boundAttemptId ? `cigreen:${d.boundAttemptId}` : null;
    case 'CiObserved': return d ? ciFactKey(d, cmd.headSha, cmd.verdict) : null;
    case 'MechanicalRepairFailed': return `mechfail:${cmd.attemptId}`;
    case 'TreadmillCycleRestarted': return d ? `treadmill:${d.id}:v${d.version}` : null;
    case 'EffectDead': return `effectdead:${cmd.effectId}`;
    case 'Abandon': return pr ? `abandon:${pr}` : null;
    case 'DeliveryFailed': return d ? `fail:${d.ownerTaskId}` : null;
    case 'TrunkRedObserved': return d ? `trunk:${cmd.incidentId}:${d.id}` : null;
    case 'TrunkRecovered': return d ? `trunkok:${cmd.incidentId}:${d.id}` : null;
    case 'CompositionAttested': return d ? `compose:${d.id}:${cmd.attestation.aggregateHeadSha}` : null;
    // The version it was read at: a replay is answered by the finding the delivery already holds
    // (T28's `evidence_recorded`), and the same finding after the delivery dropped it applies again.
    case 'PolicyEvidenceRecorded': return d ? policyKey(d.id, cmd.evidence, d.version) : null;
    // One failure per reviewer: a repeated report (a retried PATCH, the reaper) is a duplicate.
    case 'ReviewRoundFailed': return cmd.reviewerTaskId ? roundFailKey(cmd.roundId, cmd.reviewerTaskId) : null;
    default: return null;
  }
}

/**
 * T3's key names the move, not just the head it lands on: the head it moved
 * from and the version it was read at. A head that returns to an earlier SHA
 * (A→B→A) is a new observation; a redelivery of the same move reads the same
 * version and is a duplicate, and one read after the move landed sees an
 * unchanged head (`head_unchanged`).
 */
export function headObservationKey(pr: string, fromHead: string | null, toHead: string, version: number): string {
  return `head:${pr}:${fromHead ?? 'none'}->${toHead}@v${version}`;
}

/** A base retarget's key names the move (from → to) and the version it was read at, like T3's. */
export function baseChangeKey(pr: string, fromBase: string | null, toBase: string, version: number): string {
  return `base:${pr}:${fromBase ?? 'none'}->${toBase}@v${version}`;
}

/** T27's key for a reviewer's failure: the reviewer task, never the round's running count. */
export function roundFailKey(roundId: string, reviewerTaskId: string): string {
  return `roundfail:${roundId}:${reviewerTaskId}`;
}

/**
 * T28's key (10658a4c): the finding, and the version it was read at. Keyed on the
 * head and outcome alone, the key was spent for good, so the same finding could
 * never apply again at that head even after the delivery dropped it (a base
 * retarget). A replay is still a duplicate: the delivery holds that finding.
 */
export function policyKey(deliveryId: string, ev: { headSha: string; outcome: string }, version: number): string {
  return `policy:${deliveryId}:${ev.headSha}:${ev.outcome}@v${version}`;
}

/**
 * §9 (10658a4c): one push_recovery chain per visit to AWAITING_PUSH. The first
 * visit keeps the bare local head, as every chain did before; a later visit (a
 * person resolved the escalation and the work came back unpushed at the same
 * L) adds the version it entered at, so its tries and its T22 are never the
 * first visit's spent keys.
 */
export function pushChainId(local: string | null, entryVersion: number | null): string {
  return `${local ?? 'none'}${entryVersion != null ? `@v${entryVersion}` : ''}`;
}

/** The chain of the visit to AWAITING_PUSH the delivery is in now (null: the first visit, or not in it). */
export function currentPushEntry(d: Pick<DeliverySnapshot, 'pushEntries' | 'pushPendingSince'>): number | null {
  return (d.pushEntries ?? 0) > 1 ? d.pushPendingSince ?? null : null;
}

function landingKey(pr: string, headSha: string, version: number): string {
  return `merge:${pr}:${headSha}:v${version}`;
}

function mergeResultKey(pr: string, cmd: Extract<Command, { type: 'MergeCallResult' }>): string {
  return `mergeresult:${pr}:${cmd.headSha}:${cmd.landingVersion ?? 'x'}:${cmd.outcome}`;
}

// ── Reducer ─────────────────────────────────────────────────────────────────

export function currentOf(view: KernelView): CurrentView {
  const d = view.delivery;
  return { state: d?.state ?? null, version: d?.version ?? 0, head: d?.currentHeadSha ?? null, round: d?.currentRound ?? 0 };
}

const OPEN_ROUND = new Set(['queued', 'reviewing']);
const OPEN_ATTEMPT = new Set(['queued', 'running']);

/** The task role each repair family files under (the host's `Work` roles). */
const REPAIR_ROLE: Partial<Record<AttemptFamily, string>> = { review_fix: 'fix', ci: 'ci_fix', conflict: 'conflict_fix', migration: 'conflict_fix' };
const RESOLUTION_FAMILIES: AttemptFamily[] = ['review_fix', 'ci', 'conflict', 'migration'];

/**
 * What a close (T18) or a merge (T17) makes moot, for its `cancel_open_attempts` (b6cfdbb9): the
 * tasks of every open repair and of every open round's reviewer, by id. A repair row not yet
 * linked to its task names its role instead, so the host can cancel that role's unstarted tasks.
 * The ledger rows are cancelled by the transition itself; the tasks are the host's, and without
 * this a queued repair stayed pending on a PR that no longer existed.
 */
function mootOnResolution(view: KernelView): { taskIds: string[]; unlinkedRoles?: string[] } {
  const open = view.attempts.filter((a) => RESOLUTION_FAMILIES.includes(a.family) && OPEN_ATTEMPT.has(a.status));
  const taskIds = [...open.flatMap((a) => (a.taskId ? [a.taskId] : [])), ...view.rounds.flatMap((r) => (OPEN_ROUND.has(r.status) && r.reviewerTaskId ? [r.reviewerTaskId] : []))];
  const unlinkedRoles = [...new Set(open.filter((a) => !a.taskId).map((a) => REPAIR_ROLE[a.family]!))];
  return { taskIds: [...new Set(taskIds)], ...(unlinkedRoles.length ? { unlinkedRoles } : {}) };
}

class Ctx {
  readonly d: DeliverySnapshot | null;
  readonly did: string;
  constructor(readonly view: KernelView, readonly cmd: Command, readonly newId: () => string) {
    this.d = view.delivery;
    this.did = this.d?.id ?? `task:${(cmd as { ownerTaskId?: string }).ownerTaskId ?? (cmd as { adoption?: { ownerTaskId: string } }).adoption?.ownerTaskId ?? 'unknown'}`;
  }
  cur(): CurrentView { return currentOf(this.view); }
  rejected(reason: string, extra: { missing?: string[]; record?: { rounds: RoundOp[]; attempts: AttemptOp[] } } = {}): Decision {
    return { result: 'rejected', reason, current: this.cur(), ...extra };
  }
  stale(reason: string, record?: { rounds: RoundOp[]; attempts: AttemptOp[] }): Decision {
    return record ? { result: 'stale', reason, current: this.cur(), record } : { result: 'stale', reason, current: this.cur() };
  }
  duplicate(reason: string): Decision { return { result: 'duplicate', reason, current: this.cur() }; }

  get prKey(): string { return `${this.d?.repoFullName}#${this.d?.prNumber}`; }

  roundById(id: string): RoundSnapshot | undefined { return this.view.rounds.find((r) => r.id === id); }
  currentRound(): RoundSnapshot | undefined {
    const d = this.d; if (!d) return undefined;
    return this.view.rounds.find((r) => r.round === d.currentRound);
  }
  openRounds(): RoundSnapshot[] { return this.view.rounds.filter((r) => OPEN_ROUND.has(r.status)); }
  openRoundAt(head: string): RoundSnapshot | undefined { return this.openRounds().find((r) => r.headSha === head); }
  decidedAt(head: string): RoundSnapshot | undefined { return this.view.rounds.find((r) => r.headSha === head && r.status === 'decided'); }
  lastDecided(): RoundSnapshot | undefined {
    return this.view.rounds.filter((r) => r.status === 'decided').sort((a, b) => b.round - a.round)[0];
  }
  attempt(id: string | null | undefined): AttemptSnapshot | undefined { return id ? this.view.attempts.find((a) => a.id === id) : undefined; }
  ledger(family: AttemptFamily, mode: AttemptMode): AttemptSnapshot[] {
    return this.view.attempts.filter((a) => a.family === family && a.mode === mode);
  }
  nextNo(family: AttemptFamily, mode: AttemptMode): number {
    return this.ledger(family, mode).reduce((m, a) => Math.max(m, a.attemptNo), 0) + 1;
  }
  budget(family: AttemptFamily, configuredMax: number, mode: AttemptMode = 'agent'): { spent: number; max: number } {
    return ledgerBudget(this.view.attempts, family, configuredMax, mode);
  }
  openAttempt(families: AttemptFamily[], head?: string | null): AttemptSnapshot | undefined {
    return this.view.attempts.find((a) => families.includes(a.family) && OPEN_ATTEMPT.has(a.status) && (head === undefined || a.boundHeadSha === head));
  }

  /**
   * Supersede every open round and queue round r+1 bound to `head` (T5 / §6.4).
   *
   * 58c8961e: the round records why it started (`trigger`), and a round it
   * supersedes records how it ended (`superseded_by_push` when a push did it).
   * A round after a reviewer's approval is a delta review only when
   * `deltaApprovalEligibility` says so for the host's read of the delta
   * (`opts.delta`); anything else, including an unread delta, is a full review.
   * A round after a request for changes stays a delta review of the fix.
   */
  startRound(head: string, opts: { kind?: RoundKind; scope?: Record<string, unknown> | null; trigger?: RoundTrigger; delta?: DeltaReading | null } = {}): {
    rounds: RoundOp[]; effects: EffectSpec[]; patch: DeliveryPatch; roundNo: number; roundId: string;
  } {
    const d = this.d!;
    const last = this.lastDecided();
    const n = d.currentRound + 1;
    const trigger: RoundTrigger = opts.trigger ?? (last ? 'new_commits' : 'first_pass');
    let kind: RoundKind | undefined = opts.kind;
    let scope: Record<string, unknown> | null = opts.scope ?? null;
    if (!kind) {
      if (last && last.headSha !== head && last.effectiveVerdict === 'approve') {
        const el = deltaApprovalEligibility(this.view, head, opts.delta);
        kind = el.eligible ? 'delta' : 'full';
        scope = { ...(scope ?? {}), deltaApproval: el };
      } else {
        kind = last && last.headSha !== head ? 'delta' : 'full';
      }
    }
    const id = this.newId();
    const endReason = PUSH_TRIGGERS.has(trigger) ? 'superseded_by_push' : `superseded_by_${trigger}`;
    const rounds: RoundOp[] = this.openRounds().map((r) => ({ op: 'update', roundId: r.id, whenStatus: ['queued', 'reviewing'], set: { status: 'superseded', endReason } }));
    rounds.push({ op: 'insert', id, round: n, headSha: head, kind, priorRound: last?.round ?? null, scope, trigger });
    return {
      rounds,
      effects: [{ kind: 'dispatch_review', dedupeKey: `dispatch_review:${d.id}:${n}`, payload: { roundId: id, round: n, headSha: head, kind, priorRound: last?.round ?? null, scope, trigger } }],
      patch: { currentRound: n },
      roundNo: n,
      roundId: id,
    };
  }

  apply(key: string, toState: DeliveryState, o: {
    states?: DeliveryState[]; guardHead?: boolean; guardRound?: boolean;
    patch?: DeliveryPatch; rounds?: RoundOp[]; attempts?: AttemptOp[]; effects?: EffectSpec[];
    findings?: FindingOp[];
    evidence?: Record<string, unknown>; bypass?: Record<string, unknown> | null;
    create?: ApplyDecision['create'];
    /** What the `buildd/landing` status should name for this version (a lasting rail's refusal). */
    statusDetail?: string;
  } = {}): ApplyDecision {
    const d = this.d;
    const version = d?.version ?? 0;
    if (d && toState === 'AWAITING_REVIEW' && reviewBudgetHeld(d) && !liftsReviewBudget(this.cmd)) {
      // 2ded4e88: every path that would queue a round on a delivery whose review budget is spent
      // (a repair's end or push, a recovered base, a head after a repair's own escalation) ends at
      // the person instead. The head and the attempt bookkeeping still apply; no round, no reviewer.
      return this.apply(key, 'ESCALATED', {
        ...o,
        patch: { ...withoutRound(o.patch ?? {}), stateReason: 'review_exhausted', resumeState: null, boundAttemptId: null },
        rounds: (o.rounds ?? []).filter((r) => r.op !== 'insert' || !!r.decided),
        effects: (o.effects ?? []).filter((e) => e.kind !== 'dispatch_review'),
        evidence: { ...(o.evidence ?? {}), reviewBudgetSpent: true, heldFrom: d.state },
      });
    }
    let patch = o.patch ?? {};
    // The hold rides only on the states that carry it; anything else (a person's act, a merge, a
    // close) ends it, so a later repair from an unrelated state never inherits it.
    // Back at the spent escalation itself, the reason holds it and the marker has done its job.
    const backAtPerson = toState === 'ESCALATED' && (patch.stateReason ?? d?.stateReason) === 'review_exhausted';
    if (d?.resumeState === 'ESCALATED' && patch.resumeState === undefined && (!HOLD_CARRIERS.has(toState) || backAtPerson)) patch = { ...patch, resumeState: null };
    const effects = [...(o.effects ?? [])];
    const prBound = (patch.prNumber ?? d?.prNumber) != null;
    if (prBound) {
      // §12.1: the activity comment is regenerated from canonical state; one
      // render per version, the handler drops all but the newest.
      effects.push({ kind: 'render_activity', dedupeKey: `render:${this.did}:${version + 1}`, payload: { version: version + 1 } });
      // §4: the `buildd/landing` status follows every version of a PR delivery (a head change, a
      // base refresh, a verdict, a waiver, an owner replacement are all transitions); the handler
      // publishes the newest version's answer and drops the rest.
      effects.push({ kind: 'publish_landing_status', dedupeKey: `landing_status:${this.did}:${version + 1}`, payload: { version: version + 1, ...(o.statusDetail ? { detail: o.statusDetail } : {}) } });
    }
    return {
      result: 'apply',
      command: this.cmd.type,
      idempotencyKey: key,
      create: o.create,
      fromState: d?.state ?? null,
      toState,
      guard: {
        version,
        states: o.states ?? (d ? [d.state] : []),
        ...(o.guardHead ? { headSha: d?.currentHeadSha ?? null } : {}),
        ...(o.guardRound ? { round: d?.currentRound ?? 0 } : {}),
      },
      patch,
      rounds: o.rounds ?? [],
      attempts: o.attempts ?? [],
      ...(o.findings && o.findings.length ? { findings: o.findings } : {}),
      effects,
      evidence: { actor: this.cmd.actor, ...(o.evidence ?? {}) },
      bypass: o.bypass ?? null,
    };
  }

  /** The chain id for `local`: the visit the delivery is in, or the one this transition starts. */
  pushChain(local: string | null): string {
    const d = this.d;
    if (!d) return pushChainId(local, null);
    if (d.state === 'AWAITING_PUSH') return pushChainId(local, currentPushEntry(d));
    return pushChainId(local, (d.pushEntries ?? 0) >= 1 ? d.version + 1 : null);
  }

  pushRecovery(local: string | null, tryNo = 1): EffectSpec {
    return {
      kind: 'push_recovery',
      dedupeKey: `push_recovery:${this.did}:${this.pushChain(local)}:${tryNo}`,
      payload: { localHeadSha: local, try: tryNo, maxTries: PUSH_RECOVERY_BACKOFF_MS.length },
      delayMs: PUSH_RECOVERY_BACKOFF_MS[Math.min(tryNo, PUSH_RECOVERY_BACKOFF_MS.length) - 1],
    };
  }
}

/** `patch` without the round counter: a round that is not started does not advance it. */
function withoutRound(patch: DeliveryPatch): DeliveryPatch {
  const { currentRound: _, ...rest } = patch;
  return rest;
}

function livePrOpen(live: LivePr | null | undefined): boolean {
  return !!live && live.state === 'open' && !live.merged;
}

export function reduce(view: KernelView, cmd: Command, opts: ReduceOptions = {}): Decision {
  const c = new Ctx(view, cmd, opts.newId ?? (() => crypto.randomUUID()));
  const d = c.d;

  if (cmd.type !== 'DeliveryOpened' && !(cmd.type === 'PrBound' && cmd.adoption && !d)) {
    if (!d) return c.rejected('no_delivery');
    if (cmd.expectedVersion !== undefined && cmd.expectedVersion !== d.version) return c.stale('version_moved');
  }

  switch (cmd.type) {
    // T1
    case 'DeliveryOpened': {
      if (d) return c.duplicate('delivery_exists');
      if (!cmd.requiresPr) return c.rejected('not_pr_deliverable');
      return c.apply(`open:${cmd.ownerTaskId}`, 'WORKING', {
        create: { workspaceId: cmd.workspaceId, ownerTaskId: cmd.ownerTaskId, maxRounds: cmd.maxRounds ?? 3 },
        states: [],
      });
    }

    // T2
    case 'PrBound': {
      const key = `bind:${cmd.repoFullName}#${cmd.prNumber}`;
      if (d && d.prNumber != null) {
        if (d.prNumber === cmd.prNumber && d.repoFullName === cmd.repoFullName) return c.duplicate('pr_already_bound_same');
        return c.rejected('pr_already_bound');
      }
      if (!livePrOpen(cmd.live)) return c.rejected('pr_not_open');
      if (cmd.live.headRepoFullName && cmd.live.headRepoFullName !== cmd.repoFullName) return c.rejected('fork_pr');
      const bindPatch: DeliveryPatch = { repoFullName: cmd.repoFullName, prNumber: cmd.prNumber, baseRef: cmd.live.baseRef };
      if (!d) {
        // Adoption: a PR buildd did not open gets a delivery and a first round.
        const a = cmd.adoption!;
        const roundId = c.newId();
        return c.apply(key, 'AWAITING_REVIEW', {
          create: { workspaceId: a.workspaceId, ownerTaskId: a.ownerTaskId, maxRounds: a.maxRounds ?? 3 },
          states: [],
          patch: { ...bindPatch, currentHeadSha: cmd.live.headSha, currentRound: 1 },
          rounds: [{ op: 'insert', id: roundId, round: 1, headSha: cmd.live.headSha, kind: 'full', priorRound: null, trigger: 'first_pass' }],
          effects: [{ kind: 'dispatch_review', dedupeKey: `dispatch_review:task:${a.ownerTaskId}:1`, payload: { roundId, round: 1, headSha: cmd.live.headSha, kind: 'full', trigger: 'first_pass' } }],
          evidence: { live: cmd.live, adoption: true },
        });
      }
      if (d.state !== 'WORKING' && d.state !== 'AWAITING_PUSH') return c.rejected('state_not_allowed');
      return c.apply(key, d.state, { patch: bindPatch, evidence: { live: cmd.live } });
    }

    // T3 / T11 / T13 — §6.4
    case 'HeadObserved': return headObserved(c, cmd);

    // AC-1 slice 7 (workflow-kernel-library.md §9)
    case 'AttemptStarted': return attemptStarted(c, cmd);

    // T4 — §6.5
    case 'AttemptEnded': return attemptEnded(c, cmd);

    // AC-1 slice 6 (workflow-kernel-library.md §9)
    case 'AttemptRequeued': return attemptRequeued(c, cmd);

    // AC-1 slice 9 (workflow-kernel-library.md §9)
    case 'AttemptReopened': return attemptReopened(c, cmd);
    case 'AttemptWithdrawn': return attemptWithdrawn(c, cmd);

    // T5
    case 'ReviewRequested': {
      const dd = d!;
      const allowed: DeliveryState[] = ['WORKING', 'AWAITING_REVIEW', 'CHANGES_REQUESTED', 'APPROVED', 'ESCALATED'];
      if (!allowed.includes(dd.state)) return c.rejected('state_not_allowed');
      if (dd.state === 'WORKING' && dd.prNumber == null) return c.rejected('pr_not_bound');
      if (cmd.headSha !== dd.currentHeadSha || cmd.live.headSha !== cmd.headSha) return c.rejected('round_head_not_current');
      if (c.openRoundAt(cmd.headSha)) return c.rejected('review_in_flight');
      // A forced round (a second look at a head that already has a verdict) is a person's call.
      if (cmd.forced && !isHumanActor(cmd.actor)) return c.rejected('force_requires_human');
      // 2ded4e88: a spent review budget is the delivery's, so only a person forcing a round asks again.
      if (reviewBudgetHeld(dd) && !cmd.forced) return c.rejected('review_budget_spent');
      // ESCALATED is a person's (§4). Anyone may ask again after a review escalation; every
      // other reason (unpushed work, a policy finding, a dead effect, landing) waits for a person.
      if (dd.state === 'ESCALATED' && !isHumanActor(cmd.actor) && !isReviewEscalation(dd.stateReason)) {
        return c.rejected('escalation_needs_human');
      }
      if (c.decidedAt(cmd.headSha) && !cmd.forced) return c.rejected('head_already_reviewed');
      const r = c.startRound(cmd.headSha, cmd.forced || isHumanActor(cmd.actor) ? { trigger: 'manual_force' } : {});
      const attempts: AttemptOp[] = dd.state === 'CHANGES_REQUESTED' ? [{ op: 'cancel_open', families: ['review_fix'], status: 'cancelled' }] : [];
      return c.apply(`round:${dd.id}:${cmd.headSha}:${r.roundNo}`, 'AWAITING_REVIEW', {
        guardHead: true, guardRound: true, patch: r.patch, rounds: r.rounds, attempts, effects: r.effects,
        bypass: cmd.forced ? { forced: true, actor: cmd.actor } : null,
      });
    }

    // T6
    case 'ReviewVerdictRecorded': {
      const dd = d!;
      const round = c.roundById(cmd.roundId);
      if (!round) return c.rejected('unknown_round');
      if (round.status === 'decided') {
        return round.verdict === cmd.verdict ? c.duplicate('verdict_already_recorded') : c.stale('round_closed');
      }
      if (cmd.headBound !== round.headSha) return c.rejected('verdict_head_mismatch');
      if (round.status === 'superseded' && round.verdict == null) {
        // The head moved while the reviewer ran: keep the verdict on its own round for audit.
        return c.stale('round_superseded', { rounds: [{
          op: 'update', roundId: round.id, whenStatus: ['superseded'],
          set: { verdict: cmd.verdict, effectiveVerdict: cmd.effectiveVerdict, confidence: cmd.confidence ?? null, decided: true },
        }], attempts: [] });
      }
      if (!OPEN_ROUND.has(round.status)) return c.stale('round_closed');
      const keep: RoundOp = {
        op: 'update', roundId: round.id, whenStatus: ['queued', 'reviewing'],
        set: { status: 'superseded', verdict: cmd.verdict, effectiveVerdict: cmd.effectiveVerdict, confidence: cmd.confidence ?? null, decided: true },
      };
      const current = round.headSha === dd.currentHeadSha && round.round === dd.currentRound;
      const held = current && (dd.state === 'REPAIRING' || dd.state === 'BLOCKED_ON_TRUNK');
      if (!held && (dd.state !== 'AWAITING_REVIEW' || !current)) {
        // A verdict for a superseded head/round: kept for audit, never applied (nor its findings).
        return c.stale('round_superseded', { rounds: [keep], attempts: [] });
      }
      if (cmd.evidenceSha !== undefined && cmd.evidenceSha !== round.headSha) {
        // The reviewer judged another commit than the round's head (its checkout sat at the base,
        // say): the verdict is inconclusive. It decides nothing and approves nothing; the round
        // fails as T27 does, so a reviewer is asked again at the head, then a person.
        if (held) return c.stale('verdict_evidence_not_at_head');
        if (cmd.reviewerTaskId && round.reviewerTaskId && round.reviewerTaskId !== cmd.reviewerTaskId) return c.stale('reviewer_not_current');
        return roundFailed(c, round, {
          reason: 'evidence_not_at_head', reviewerTaskId: cmd.reviewerTaskId, maxContractRetries: cmd.maxContractRetries ?? 0,
          inconclusive: { verdict: cmd.verdict, effectiveVerdict: cmd.effectiveVerdict, evidenceSha: cmd.evidenceSha, headSha: round.headSha },
        });
      }
      return verdictDecided(c, round, cmd, { held });
    }

    // 00d288fd: a verdict from a reviewer outside the kernel's rounds, at the current head.
    case 'ReviewVerdictAdopted': {
      const dd = d!;
      const head = cmd.headBound;
      if (head !== dd.currentHeadSha) return c.stale('verdict_head_not_current');
      // Read at another commit than the head it names: inconclusive, never kept as that head's review.
      if (cmd.evidenceSha !== undefined && cmd.evidenceSha !== head) return c.stale('verdict_evidence_not_at_head');
      const mine = c.view.rounds.find((r) => r.reviewerTaskId === cmd.reviewerTaskId && r.headSha === head);
      if (mine?.status === 'decided') return c.duplicate('verdict_already_recorded');
      if (c.decidedAt(head)) return c.stale('head_already_reviewed');
      // The kernel's own round at this head is the review that counts: its reviewer answers it.
      if (c.openRoundAt(head)) return c.stale('round_in_flight');
      // The owner is still working (or a repair or a red trunk holds the head) and the kernel has asked
      // nobody yet: the verdict is kept as a decided round at this head, and the hand-off (T4,
      // resumeAfterRepair, T26) applies it rather than asking for a second review of the same content.
      const keeps: DeliveryState[] = ['WORKING', 'AWAITING_PUSH', 'REPAIRING', 'BLOCKED_ON_TRUNK'];
      if (!keeps.includes(dd.state)) return c.stale('state_not_allowed');
      const id = c.newId();
      const n = dd.currentRound + 1;
      const last = c.lastDecided();
      const round: RoundSnapshot = { id, round: n, headSha: head, kind: 'full', status: 'decided', verdict: cmd.verdict, effectiveVerdict: cmd.effectiveVerdict, failureCount: 0, reviewerTaskId: cmd.reviewerTaskId, scope: null };
      const f = applyVerdictToFindings(c.view, round, cmd.effectiveVerdict, cmd, cmd.actor);
      // Nothing is posted to GitHub and nothing lands here: the hand-off applies the verdict, and only a
      // kernel round's verdict is ever posted as a review.
      return c.apply(`adopt:${dd.id}:${cmd.reviewerTaskId}`, dd.state, {
        guardHead: true, guardRound: true,
        patch: { currentRound: n },
        rounds: [{
          op: 'insert', id, round: n, headSha: head, kind: 'full', priorRound: last?.round ?? null,
          decided: { verdict: cmd.verdict, effectiveVerdict: cmd.effectiveVerdict, confidence: cmd.confidence ?? null, reviewerTaskId: cmd.reviewerTaskId },
        }],
        findings: f.ops,
        evidence: { adopted: true, reviewerTaskId: cmd.reviewerTaskId, roundId: id, headSha: head, verdict: cmd.verdict, effectiveVerdict: cmd.effectiveVerdict, heldBy: dd.state, ...(f.raised.length ? { findings: { raised: f.raised } } : {}) },
      });
    }
    // §5: a person waives a finding, or defers it to a named task.
    case 'FindingDisposed': {
      const dd = d!;
      if (!isHumanActor(cmd.actor)) return c.rejected('human_required');
      if (!cmd.reason.trim()) return c.rejected('reason_required');
      if (cmd.disposition === 'deferred' && !cmd.deferredToTaskId) return c.rejected('deferral_needs_task');
      // The host resolves a short id to the task first; anything else is not a task this can name.
      if (cmd.disposition === 'deferred' && !isTaskId(cmd.deferredToTaskId)) return c.rejected('deferral_task_unresolved');
      const f = (c.view.findings ?? []).find((x) => x.id === cmd.findingId);
      if (!f) return c.rejected('unknown_finding');
      if (f.status === cmd.disposition) return c.duplicate('finding_already_disposed');
      if (f.status !== 'open' && f.status !== 'addressed') return c.rejected('finding_closed');
      return c.apply(`dispose:${f.id}:${cmd.disposition}`, dd.state, {
        findings: [{
          op: 'update', findingId: f.id, whenStatus: ['open', 'addressed'],
          set: { status: cmd.disposition, closedBy: cmd.actor, closedReason: cmd.reason.trim(), deferredToTaskId: cmd.deferredToTaskId ?? null },
        }],
        evidence: { findingId: f.id, disposition: cmd.disposition, reason: cmd.reason.trim(), ...(cmd.deferredToTaskId ? { deferredToTaskId: cmd.deferredToTaskId } : {}) },
        bypass: { finding: f.id, disposition: cmd.disposition, actor: cmd.actor, reason: cmd.reason.trim() },
      });
    }

    // T7
    case 'ReviewBudgetExhausted': {
      const dd = d!;
      if (dd.state !== 'CHANGES_REQUESTED' && dd.state !== 'FIXING') return c.stale('state_moved');
      const cur = c.currentRound();
      if (cur ? !budgetSpentAt(c.view, cur, dd.maxRounds) : spentReviewRounds(c.view) < dd.maxRounds) return c.rejected('budget_not_exhausted');
      // The version it was read at (10658a4c): a person who resolves back to this head and
      // sees it exhaust again is a second escalation, not a replay of the first.
      const key = `exhaust:${dd.id}:${dd.currentHeadSha}@v${dd.version}`;
      return c.apply(key, 'ESCALATED', {
        patch: { stateReason: 'review_exhausted', boundAttemptId: null },
        effects: [{ kind: 'escalate_exhaustion', dedupeKey: key, payload: { family: 'review_fix', rounds: dd.currentRound } }],
      });
    }

    // T8
    case 'FixDispatched': {
      const dd = d!;
      if (dd.state !== 'CHANGES_REQUESTED') return c.stale('state_moved');
      const human = cmd.trigger === 'human';
      const round = c.roundById(cmd.roundId);
      // A person's T23 fix answers the escalated round itself, whatever its verdict.
      if (!round || round.round !== dd.currentRound || round.headSha !== dd.currentHeadSha || (!human && round.effectiveVerdict !== 'request_changes')) {
        return c.rejected('newer_verdict_supersedes_fix');
      }
      // §10.5 dispatch-time revalidation: nothing is allocated for a target that no longer needs work.
      if (!livePrOpen(cmd.revalidation.live)) return c.rejected('fix_not_needed', { missing: ['pr_open'] });
      if (cmd.revalidation.live.headSha !== round.headSha) return c.rejected('fix_not_needed', { missing: ['head_current'] });
      if (cmd.revalidation.newerApprove) return c.rejected('fix_not_needed', { missing: ['not_approved'] });
      const inflight = c.view.attempts.find((a) => a.family === 'review_fix' && a.triggerReason === round.id && OPEN_ATTEMPT.has(a.status));
      if (inflight) return c.duplicate('fix_in_flight');
      const n = c.nextNo('review_fix', 'agent');
      // c1d66a6a: a re-check after an approval that asks for changes is owed one repair cycle, past
      // a spent fix ledger too. Exactly one: a second fix for the same round is not free.
      const recheckCycle = n > cmd.maxAttempts && !human && isRecheckAfterApproval(round)
        && !c.view.attempts.some((a) => a.family === 'review_fix' && a.triggerReason === round.id);
      if (n > cmd.maxAttempts && !human && !recheckCycle) {
        // AC-14: a spent fix ledger is an escalation, never a silent refusal. T6 escalates on
        // rounds; failed fixes spend attempts faster than rounds, so this is where they run out
        // (67d34094: fix 1 and 2 failed, fix 3 delivered, round 2 requested changes).
        return c.apply(`fixbudget:${dd.id}:${round.id}`, 'ESCALATED', {
          guardHead: true, guardRound: true,
          patch: { stateReason: 'review_exhausted', boundAttemptId: null },
          effects: [{ kind: 'escalate_exhaustion', dedupeKey: `exhaust:${dd.id}:review_fix:budget:${round.id}`, payload: { family: 'review_fix', attempts: n - 1, max: cmd.maxAttempts } }],
          evidence: { roundId: round.id, attemptNo: n, max: cmd.maxAttempts, reason: 'fix_budget_spent' },
        });
      }
      // §5.7 rule 5: a person past the cap extends it by exactly this one dispatch, visibly.
      const extended = (human || recheckCycle) && n > cmd.maxAttempts;
      const max = extended ? n : cmd.maxAttempts;
      const id = c.newId();
      return c.apply(`fix:${dd.id}:${round.id}:${n}`, 'CHANGES_REQUESTED', {
        guardHead: true, guardRound: true,
        attempts: [{ op: 'insert', id, family: 'review_fix', attemptNo: n, mode: 'agent', boundHeadSha: round.headSha, triggerReason: round.id, taskId: cmd.taskId, trigger: human ? 'human' : 'automatic', status: 'queued', maxAttempts: max }],
        evidence: { roundId: round.id, attemptId: id, attemptNo: n, live: cmd.revalidation.live, ...(human ? { trigger: 'human' } : {}), ...(recheckCycle ? { recheckCycle: true } : {}) },
        bypass: extended ? { family: 'review_fix', budgetFrom: cmd.maxAttempts, budgetTo: max, trigger: human ? 'human' : 'recheck_after_approval' } : null,
      });
    }

    // T9
    case 'FixClaimed': {
      const dd = d!;
      const a = c.attempt(cmd.attemptId);
      if (a?.family === 'ci' || a?.family === 'conflict' || a?.family === 'migration') return repairClaimed(c, cmd, a);
      if (!a || a.family !== 'review_fix') return c.rejected('unknown_attempt');
      if (dd.state === 'FIXING' && dd.boundAttemptId === a.id) return c.duplicate('already_claimed');
      if (dd.state !== 'CHANGES_REQUESTED') return c.stale('state_moved');
      if (a.status !== 'queued') return c.rejected('attempt_not_queued');
      const skip = (reason: string): Decision => c.rejected(reason, {
        record: { rounds: [], attempts: [{ op: 'update', attemptId: a.id, whenStatus: ['queued'], set: { status: 'skipped', outcome: 'noop', ended: true } }] },
      });
      const round = c.currentRound();
      if (!round || a.triggerReason !== round.id || a.boundHeadSha !== dd.currentHeadSha) return skip('fix_superseded');
      if (!livePrOpen(cmd.revalidation.live) || cmd.revalidation.live.headSha !== a.boundHeadSha || cmd.revalidation.approved) return skip('fix_not_needed');
      return c.apply(`claim:${a.id}`, 'FIXING', {
        guardHead: true, guardRound: true,
        patch: { boundAttemptId: a.id },
        attempts: [{ op: 'update', attemptId: a.id, whenStatus: ['queued'], set: { status: 'running' } }],
        evidence: { attemptId: a.id, roundId: round.id, live: cmd.revalidation.live },
      });
    }

    // T10
    case 'CiFailedObserved': {
      const dd = d!;
      const human = cmd.trigger === 'human';
      if (cmd.headSha !== dd.currentHeadSha) return c.stale('head_not_current');
      const allowed: DeliveryState[] = ['AWAITING_REVIEW', 'APPROVED', 'LANDING', 'CHANGES_REQUESTED'];
      // A person's "Fix CI" may restart a family that escalated, while the (possibly raised) cap allows.
      const reopen = human && dd.state === 'ESCALATED' && dd.stateReason === 'ci_exhausted';
      // §6.10: a delivery already repairing this CI joins the incident too; its
      // queued per-PR attempt is skipped (spends nothing) and T25 decides.
      const repairingCi = dd.state === 'REPAIRING' && dd.stateReason === 'ci';
      // a90fc99b: a review or policy escalation with red CI gets its CI fix first.
      const escalatedRed = dd.state === 'ESCALATED' && isRepairableEscalation(dd.stateReason);
      if (!allowed.includes(dd.state) && !reopen && !escalatedRed && !(repairingCi && cmd.openTrunkIncidentId)) return c.stale('state_not_allowed');
      // §6.3 T10 guard "live check-suite read": a stale or redelivered hint for a
      // head that is not red now (re-run green, or re-running) moves nothing.
      if (cmd.liveChecks && cmd.liveChecks.failing.length === 0) return c.rejected('ci_not_red');
      if (cmd.openTrunkIncidentId && dd.state !== 'CHANGES_REQUESTED') {
        return reduce(view, { type: 'TrunkRedObserved', actor: cmd.actor, incidentId: cmd.openTrunkIncidentId, signature: cmd.signature, headSha: cmd.headSha, thresholdMet: true }, opts);
      }
      const key = `ci:${dd.id}:${cmd.headSha}`;
      // §6.10 tier 3 (S31): a failure a preflight should have caught is tagged, never acted on.
      const miss = {
        ...(cmd.preflightMiss ? { preflightMiss: cmd.preflightMiss } : {}),
        ...(cmd.liveChecks ? { liveChecks: cmd.liveChecks } : {}),
      };
      const ciPatch: DeliveryPatch = { ci: 'red', ciHeadSha: cmd.headSha };
      if (dd.state === 'CHANGES_REQUESTED') {
        // The owed review fix will push a new head; record the CI fact only.
        return c.apply(`${key}:review_fix_owed`, 'CHANGES_REQUESTED', { guardHead: true, patch: ciPatch, evidence: { signature: cmd.signature, deferral: 'fix_in_flight', ...miss } });
      }
      if (c.openAttempt(['ci'])) return c.rejected('fix_in_flight');
      const { spent, max } = c.budget('ci', cmd.maxAttempts);
      if (spent >= max) {
        // A person past the cap extends the budget explicitly (BudgetExtended), never as "iteration 0".
        if (human) return c.rejected('budget_exhausted', { missing: [`ci ${spent} of ${max}`] });
        // Already a person's: a spent CI budget does not replace why it escalated.
        if (escalatedRed) return c.rejected('budget_exhausted', { missing: [`ci ${spent} of ${max}`] });
        return c.apply(`${key}:exhausted`, 'ESCALATED', {
          guardHead: true, patch: { ...ciPatch, stateReason: 'ci_exhausted', boundAttemptId: null },
          effects: [{ kind: 'escalate_exhaustion', dedupeKey: `exhaust:${dd.id}:ci:${cmd.headSha}@v${dd.version}`, payload: { family: 'ci', attempts: spent, max, headSha: cmd.headSha, signature: cmd.signature } }],
          evidence: { signature: cmd.signature, spent, max, ...miss },
        });
      }
      const n = c.nextNo('ci', 'agent');
      const id = c.newId();
      return c.apply(`${key}:${n}`, 'REPAIRING', {
        guardHead: true,
        patch: { ...ciPatch, stateReason: 'ci', boundAttemptId: id, ...holdThroughRepair(dd) },
        attempts: [{ op: 'insert', id, family: 'ci', attemptNo: n, mode: 'agent', boundHeadSha: cmd.headSha, triggerReason: cmd.signature, triggerFactId: cmd.triggerFactId ?? null, taskId: null, trigger: human ? 'human' : 'automatic', status: 'queued', maxAttempts: max }],
        effects: [{ kind: 'dispatch_ci_fix', dedupeKey: `dispatch_ci_fix:${dd.id}:${cmd.headSha}:${n}`, payload: { attemptId: id, attemptNo: n, maxAttempts: max, headSha: cmd.headSha, signature: cmd.signature, trigger: human ? 'human' : 'automatic' } }],
        evidence: { signature: cmd.signature, attemptNo: n, spent: spent + 1, max, ...miss },
      });
    }

    // 38442d17: the head that went red is green again.
    case 'CiGreenObserved': {
      const dd = d!;
      if (cmd.headSha !== dd.currentHeadSha) return c.stale('head_not_current');
      if (cmd.allPassing !== true || !cmd.liveChecks.complete || cmd.liveChecks.failing.length > 0) return c.rejected('ci_not_green');
      const a = c.attempt(dd.boundAttemptId);
      if (dd.state !== 'REPAIRING' || dd.stateReason !== 'ci' || !a || a.family !== 'ci') return c.stale('no_ci_repair');
      if (!OPEN_ATTEMPT.has(a.status)) return c.stale('attempt_not_open');
      if (a.boundHeadSha !== cmd.headSha) return c.stale('repair_at_other_head');
      // A repair that never started spent nothing (skipped); one an agent picked up is cancelled,
      // and its task is stopped by the cancellation effect.
      const end: AttemptOp = { op: 'update', attemptId: a.id, whenStatus: [a.status], set: a.status === 'queued' ? { status: 'skipped', outcome: 'noop', ended: true } : { status: 'cancelled', outcome: 'noop', ended: true } };
      const r = resumeAfterRepair(c, `cigreen:${a.id}`, cmd.headSha, {
        attempts: [end],
        patch: { ci: 'green', ciHeadSha: cmd.headSha },
        evidence: { attemptId: a.id, family: 'ci', skipped: 'ci_green', attemptStatus: a.status, liveChecks: cmd.liveChecks },
      });
      if (r.result !== 'apply') return r;
      return { ...r, effects: [...r.effects, { kind: 'cancel_open_attempts', dedupeKey: `cancel_open_attempts:${dd.id}:ci_green:${a.id}`, payload: { families: ['ci'], reason: 'ci_green', attemptId: a.id, taskId: a.taskId } }] };
    }

    // 6900a317: the CI reading on the current head as a fact, no state change.
    case 'CiObserved': {
      const dd = d!;
      if (cmd.headSha !== dd.currentHeadSha) return c.stale('head_not_current');
      if (isTerminal(dd.state) || dd.state === 'CLOSED_UNMERGED' || dd.state === 'LANDING') return c.stale('state_not_allowed');
      if (cmd.verdict === 'red' && cmd.liveChecks.failing.length === 0) return c.rejected('ci_not_red');
      if (cmd.verdict === 'green' && (cmd.allPassing !== true || !cmd.liveChecks.complete || cmd.liveChecks.failing.length > 0)) return c.rejected('ci_not_green');
      if (cmd.verdict === 'running' && (cmd.liveChecks.complete || cmd.liveChecks.failing.length > 0)) return c.rejected('ci_not_running');
      // A CI repair reads red by its state; its green is CiGreenObserved's, which also ends it.
      if (dd.state === 'REPAIRING' && dd.stateReason === 'ci') return c.stale('ci_repair_owns_head');
      // 295486ba: a spent CI budget is the person's only while CI is red. A green head (a re-run,
      // a push from elsewhere) has nothing left to fix: back to the review/landing path, as a CI
      // repair that ends green does (resumeAfterRepair). A spent review budget under it is still
      // the person's (2ded4e88), so the escalation stays and names that budget instead.
      if (cmd.verdict === 'green' && dd.state === 'ESCALATED' && dd.stateReason === 'ci_exhausted') {
        const ev = { verdict: cmd.verdict, liveChecks: cmd.liveChecks, allPassing: true, cleared: 'ci_exhausted' };
        if (dd.resumeState === 'ESCALATED') {
          return c.apply(ciFactKey(dd, cmd.headSha, cmd.verdict), 'ESCALATED', {
            guardHead: true, patch: { ci: 'green', ciHeadSha: cmd.headSha, stateReason: 'review_exhausted', resumeState: null }, evidence: ev,
          });
        }
        return resumeAfterRepair(c, ciFactKey(dd, cmd.headSha, cmd.verdict), cmd.headSha, { attempts: [], patch: { ci: 'green', ciHeadSha: cmd.headSha }, evidence: ev });
      }
      if (dd.ci === cmd.verdict && dd.ciHeadSha === cmd.headSha) return c.stale('already_recorded');
      // Running only withdraws a red on this head; with no red here there is nothing to withdraw.
      if (cmd.verdict === 'running' && !(dd.ci === 'red' && dd.ciHeadSha === cmd.headSha)) return c.stale('already_recorded');
      // Same state, same hold: a reading never re-enters review or clears a resume marker.
      if (dd.state === 'AWAITING_REVIEW' && reviewBudgetHeld(dd)) return c.stale('state_not_allowed');
      return c.apply(ciFactKey(dd, cmd.headSha, cmd.verdict), dd.state, {
        guardHead: true,
        patch: cmd.verdict === 'running'
          ? { ci: null, ciHeadSha: null, resumeState: dd.resumeState }
          : { ci: cmd.verdict, ciHeadSha: cmd.headSha, resumeState: dd.resumeState },
        evidence: { verdict: cmd.verdict, liveChecks: cmd.liveChecks, ...(cmd.allPassing !== undefined ? { allPassing: cmd.allPassing } : {}) },
      });
    }

    // §5.7 rule 5 / AC-14
    case 'BudgetExtended': {
      const dd = d!;
      if (!isHumanActor(cmd.actor)) return c.rejected('human_required');
      if (!cmd.reason.trim()) return c.rejected('reason_required');
      if (cmd.headSha !== dd.currentHeadSha) return c.stale('head_not_current');
      // An open CI attempt answers first: a second click stacks nothing (and says why).
      if (c.openAttempt(['ci'])) return c.rejected('fix_in_flight');
      const ok = dd.state === 'AWAITING_REVIEW' || dd.state === 'APPROVED' || dd.state === 'LANDING'
        || (dd.state === 'ESCALATED' && dd.stateReason === 'ci_exhausted');
      if (!ok) return c.rejected('state_not_allowed');
      const { spent, max } = c.budget('ci', cmd.maxAttempts);
      if (spent < max) return c.rejected('budget_not_exhausted', { missing: [`ci ${spent} of ${max}`] });
      const n = c.nextNo('ci', 'agent');
      const id = c.newId();
      const to = spent + 1;
      return c.apply(`budget:${dd.id}:ci:${n}`, 'REPAIRING', {
        guardHead: true,
        patch: { ci: 'red', ciHeadSha: cmd.headSha, stateReason: 'ci', boundAttemptId: id },
        attempts: [{ op: 'insert', id, family: 'ci', attemptNo: n, mode: 'agent', boundHeadSha: cmd.headSha, triggerReason: cmd.signature, taskId: null, trigger: 'human', status: 'queued', maxAttempts: to }],
        effects: [{ kind: 'dispatch_ci_fix', dedupeKey: `dispatch_ci_fix:${dd.id}:${cmd.headSha}:${n}`, payload: { attemptId: id, attemptNo: n, maxAttempts: to, headSha: cmd.headSha, signature: cmd.signature, trigger: 'human' } }],
        evidence: { family: cmd.family, signature: cmd.signature, attemptNo: n, budgetFrom: max, budgetTo: to },
        bypass: { actor: cmd.actor, reason: cmd.reason, family: cmd.family, budgetFrom: max, budgetTo: to },
      });
    }

    // §10.5 dispatch-time revalidation of a repair attempt
    case 'RepairNotNeeded': {
      const dd = d!;
      const a = c.attempt(cmd.attemptId);
      if (!a) return c.rejected('unknown_attempt');
      const skip: AttemptOp = { op: 'update', attemptId: a.id, whenStatus: ['queued'], set: { status: 'skipped', outcome: 'noop', ended: true } };
      if (dd.state !== 'REPAIRING' || dd.boundAttemptId !== a.id) {
        return a.status === 'queued' ? c.rejected('repair_superseded', { record: { rounds: [], attempts: [skip] } }) : c.stale('attempt_not_bound');
      }
      if (a.status !== 'queued') return c.rejected('attempt_not_queued');
      if (!dd.currentHeadSha) return c.rejected('no_head');
      return resumeAfterRepair(c, `notneeded:${a.id}`, dd.currentHeadSha, {
        attempts: [skip],
        patch: cmd.reason === 'ci_green' ? { ci: 'green', ciHeadSha: dd.currentHeadSha }
          : (cmd.reason === 'up_to_date' || cmd.reason === 'conflict_resolved') ? { mergeable: 'clean', mergeableHeadSha: dd.currentHeadSha } : {},
        evidence: { attemptId: a.id, family: a.family, skipped: cmd.reason, live: cmd.live ?? null },
      });
    }

    // T12
    case 'ConflictObserved': {
      const dd = d!;
      if (cmd.headSha !== dd.currentHeadSha) return c.stale('head_not_current');
      const allowed: DeliveryState[] = ['AWAITING_REVIEW', 'APPROVED', 'LANDING', 'CHANGES_REQUESTED', 'REPAIRING'];
      // a90fc99b: a review or policy escalation that conflicts or collides is repaired first. A
      // behind-only refresh is not: nothing lands an escalated PR, so keeping it fresh buys nothing.
      const escalatedRepair = dd.state === 'ESCALATED' && isRepairableEscalation(dd.stateReason)
        && (cmd.migrationCollision === true || cmd.mergeable !== 'behind');
      if (!allowed.includes(dd.state) && !escalatedRepair) return c.stale('state_not_allowed');
      if (dd.state === 'REPAIRING' && !cmd.mechanicalRefused) return c.rejected('fix_in_flight');
      if (cmd.isDependencyBot) return c.rejected('dependency_bot_pr');
      const kind = cmd.migrationCollision ? 'migration' : cmd.mergeable === 'behind' ? 'behind' : 'conflict';
      return conflictRepair(c, cmd.headSha, kind, {
        key: `conflict:${dd.id}:${cmd.headSha}`,
        mechanicalRefused: cmd.mechanicalRefused === true,
        maxMechanical: cmd.maxMechanical ?? DEFAULT_MAX_MECHANICAL,
        maxAgent: cmd.maxAgentAttempts,
        patch: { mergeable: cmd.mergeable, mergeableHeadSha: cmd.headSha, ...holdThroughRepair(dd) },
        refusal: cmd.refusal ?? null,
        detail: cmd.detail ?? null,
        baseDelta: kind === 'behind' ? cmd.baseDelta ?? null : null,
        maxBaseCommits: cmd.maxBaseCommits,
      });
    }

    // §6.7: a mechanical repair that failed operationally. Not a conflict, so no agent.
    case 'MechanicalRepairFailed': {
      const dd = d!;
      const a = c.attempt(cmd.attemptId);
      if (!a || a.mode !== 'mechanical') return c.rejected('unknown_attempt');
      if (dd.state !== 'REPAIRING' || dd.boundAttemptId !== a.id) return c.stale('attempt_not_bound');
      if (!OPEN_ATTEMPT.has(a.status)) return c.stale('attempt_not_open');
      return c.apply(`mechfail:${a.id}`, 'ESCALATED', {
        patch: { stateReason: 'landing_needs_human', boundAttemptId: null },
        attempts: [{ op: 'update', attemptId: a.id, whenStatus: ['queued', 'running'], set: { status: 'ended', outcome: 'failed', ended: true } }],
        effects: [{ kind: 'notify', dedupeKey: `notify:${dd.id}:mechfail:${a.id}`, payload: { event: 'landing_needs_human', detail: cmd.reason, family: a.family } }],
        evidence: { attemptId: a.id, family: a.family, reason: cmd.reason },
      });
    }

    // S15 cycles: a spent treadmill, past its cooldown, gets a fresh refresh budget.
    case 'TreadmillCycleRestarted': {
      const dd = d!;
      if (dd.state !== 'ESCALATED' || dd.stateReason !== 'landing_needs_human') return c.stale('state_not_allowed');
      const head = dd.currentHeadSha;
      if (headCoverage(dd, head) === 'none') return c.rejected('head_not_approved');
      const cyc = treadmillCycle(c.ledger('conflict', 'mechanical'));
      if (cyc.refreshes < DEFAULT_MAX_BEHIND_REFRESHES) return c.rejected('treadmill_cycle_not_spent');
      if (cyc.cycle >= MAX_TREADMILL_CYCLES) return c.rejected('treadmill_cycles_exhausted');
      const id = c.newId();
      const n = c.nextNo('conflict', 'mechanical');
      return c.apply(`treadmill:${dd.id}:v${dd.version}`, 'APPROVED', {
        guardHead: true,
        patch: { stateReason: null, boundAttemptId: null },
        attempts: [{ op: 'insert', id, family: 'conflict', attemptNo: n, mode: 'mechanical', boundHeadSha: null, triggerReason: TREADMILL_CYCLE_MARKER, taskId: null, trigger: 'automatic', status: 'skipped', maxAttempts: DEFAULT_MAX_BEHIND_REFRESHES }],
        evidence: { cycle: cyc.cycle + 1, maxCycles: MAX_TREADMILL_CYCLES, headSha: head },
      });
    }

    // T14
    case 'HumanApproved': {
      const dd = d!;
      if (!['ESCALATED', 'CHANGES_REQUESTED', 'AWAITING_REVIEW'].includes(dd.state)) return c.stale('state_not_allowed');
      if (cmd.commitId !== dd.currentHeadSha) return c.stale('review_on_older_commit');
      if (!cmd.hasMergePermission) return c.rejected('no_merge_permission');
      return c.apply(`approve:${c.prKey}:${cmd.reviewId}`, 'APPROVED', {
        guardHead: true,
        patch: { approvedHeads: [cmd.commitId], approvalBasis: 'human', stateReason: null },
        attempts: [{ op: 'cancel_open', families: ['review_fix'], status: 'cancelled' }],
        effects: [{ kind: 'notify', dedupeKey: `notify:${dd.id}:approve:${cmd.reviewId}`, payload: { event: 'human_approved', reviewId: cmd.reviewId } }],
        evidence: { reviewId: cmd.reviewId, commitId: cmd.commitId },
      });
    }

    // a90fc99b: the escalation gate's policy-merge rule (rule-only, never a model).
    case 'PolicyMergeApproved': {
      const dd = d!;
      if (!cmd.actor.startsWith('rule:')) return c.rejected('rule_actor_required');
      if (dd.state !== 'ESCALATED') return c.stale('state_not_allowed');
      if (!isRepairableEscalation(dd.stateReason)) return c.rejected('escalation_not_policy_mergeable');
      if (cmd.headSha !== dd.currentHeadSha) return c.stale('head_not_current');
      // A destructive migration is a person's whatever the paths say.
      if (dd.policyEvidence?.destructive) return c.rejected('destructive_migration');
      // §13.13 rule 6: a rule never lifts a required finding; only a person's waiver or a verifying round does.
      const blocking = openRequiredFindings(c.view);
      if (blocking.length) return c.rejected('open_findings', { missing: blocking.map(describeFinding) });
      return c.apply(`policymerge:${c.prKey}:${cmd.headSha}`, 'APPROVED', {
        guardHead: true,
        patch: { approvedHeads: [...dd.approvedHeads.filter((h) => h !== cmd.headSha), cmd.headSha], approvalBasis: 'policy_rule', stateReason: null },
        attempts: [{ op: 'cancel_open', families: ['review_fix'], status: 'cancelled' }],
        evidence: { headSha: cmd.headSha, rule: cmd.actor, reason: cmd.reason, fromReason: dd.stateReason },
        bypass: { actor: cmd.actor, reason: cmd.reason, overrodeState: dd.state, overrodeReason: dd.stateReason },
      });
    }

    // T15
    case 'LandingRequested': {
      const dd = d!;
      // A second door asking while the first one's merge call is in flight: one LANDING, one merge call.
      if (dd.state === 'LANDING' && dd.currentHeadSha === cmd.headSha) return c.duplicate('landing_in_flight');
      if (cmd.headSha !== dd.currentHeadSha || cmd.live.headSha !== cmd.headSha) return c.stale('head_moved');
      if (!livePrOpen(cmd.live)) return c.rejected('pr_not_open');
      // e89035b6: GitHub refuses to merge a draft. Holding a PR as a draft is a wait, not a
      // refusal: no merge call, the approval stands, and a door lands it once it is ready.
      if (cmd.live.draft || cmd.live.mergeableState === 'draft') return c.rejected('pr_is_draft');
      // 24e1cfad: the live read targets another base than the delivery knows; the base-change
      // fact decides the approval first (the door records it before asking).
      if (cmd.live.baseRef && dd.baseRef && cmd.live.baseRef !== dd.baseRef) return c.stale('base_moved');
      // The override door: a person merging past a rail (the dashboard's "Merge anyway"), or
      // an agent run under a grant a person put on its task (recorded as grantedBy).
      const ov = cmd.override ?? null;
      const overrideDoor = !!ov && (cmd.door === 'dashboard_override' || isHumanActor(cmd.actor) || (!!ov.grantedBy && isHumanActor(ov.grantedBy)));
      const overridable: DeliveryState[] = ['APPROVED', 'AWAITING_REVIEW', 'CHANGES_REQUESTED', 'ESCALATED'];
      if (dd.state !== 'APPROVED' && !(overrideDoor && overridable.includes(dd.state))) return c.rejected('state_not_allowed');
      // A freshness / size override is not a verdict override: it lifts a landing escalation only.
      if (overrideDoor && ov?.kinds && !ov.kinds.includes('verdict') && dd.state !== 'APPROVED'
        && !(dd.state === 'ESCALATED' && dd.stateReason === 'landing_needs_human')) {
        return c.rejected('override_does_not_cover_state');
      }
      // A door's own rail reading is never trusted as a pass (the merge effect reads the rails
      // itself, §4); a door that reports a refusal is refused here all the same.
      const rails = cmd.rails ?? null;
      if (rails?.redCi || rails?.denyPaths) return c.rejected('rail_not_overridable', { missing: rails.reasons });
      if (rails && !rails.passed && !overrideDoor) return c.rejected('rails_failed', { missing: rails.reasons });
      const coverage = headCoverage(dd, cmd.headSha);
      if (dd.state === 'APPROVED' && coverage === 'none' && !overrideDoor) return c.rejected('head_not_approved');
      // AC-13: an open required finding refuses every door, named; a person's verdict override or their own approval passes it.
      const verdictOverride = overrideDoor && (!ov?.kinds || ov.kinds.includes('verdict'));
      const blocking = openRequiredFindings(c.view);
      if (blocking.length && !verdictOverride && coverage !== 'human') return c.rejected('open_finding', { missing: blocking.map(describeFinding) });
      // S15: a door landing a head that is behind its base, under the disjoint-delta rule. The base
      // delta was read now, so the rule is checked again at merge time; a freshness override skips it.
      let freshness: Record<string, unknown> | null = null;
      if (cmd.baseDelta && !(overrideDoor && ov?.kinds?.includes('freshness')) && cmd.baseDelta.baseCommits !== 0) {
        const fact: BaseDeltaFact = { ...cmd.baseDelta, requiresUpToDate: cmd.baseDelta.requiresUpToDate === true || cmd.live.mergeableState === 'behind' };
        const v = behindTolerance(dd, c.ledger('conflict', 'mechanical'), cmd.headSha, fact, cmd.maxBaseCommits);
        if (!v.tolerated) return c.rejected('behind_not_tolerated', { missing: [v.reason] });
        freshness = { optimistic: true, behindBy: v.baseCommits, baseFiles: v.baseFileCount, rule: v.rule };
      }
      const landingVersion = dd.version + 1;
      return c.apply(landingKey(c.prKey, cmd.headSha, dd.version), 'LANDING', {
        guardHead: true,
        states: [dd.state],
        patch: { stateReason: null },
        effects: [{
          kind: 'merge_call', dedupeKey: `merge_call:${dd.id}:${cmd.headSha}:v${landingVersion}`,
          payload: {
            headSha: cmd.headSha, door: cmd.door, mergeMethod: cmd.mergeMethod ?? 'squash', landingVersion, fromState: dd.state,
            // A person's own door keeps a person's rails at merge time (red CI, protected paths).
            // Only a human actor: an agent under a person's grant is held to every rail, and the
            // grant lifts only what it names (`override.kinds`: freshness at T15, size in the size check).
            ...(isHumanActor(cmd.actor) ? { person: true } : {}),
            // What the gate at merge time may pass, and only because a person said so (§13.13 rule 6).
            ...(overrideDoor ? { override: { verdict: !ov!.kinds || ov!.kinds.includes('verdict'), kinds: ov!.kinds ?? ['verdict'] } } : {}),
          },
        }],
        evidence: { door: cmd.door, coverage, ...(rails ? { rails } : {}), fromState: dd.state, ...(freshness ? { freshness } : {}) },
        bypass: overrideDoor
          ? { door: cmd.door, reason: ov!.reason, actor: cmd.actor, overrodeState: dd.state, ...(ov!.kinds ? { kinds: ov!.kinds } : {}), ...(ov!.grantedBy ? { grantedBy: ov!.grantedBy } : {}) }
          : null,
      });
    }

    // T16
    case 'MergeCallResult': {
      const dd = d!;
      if (dd.state !== 'LANDING') return c.stale('state_moved');
      if (cmd.headSha !== dd.currentHeadSha) return c.stale('head_not_current');
      const key = mergeResultKey(c.prKey, cmd);
      const evidence = { outcome: cmd.outcome, detail: cmd.detail ?? null, landingVersion: cmd.landingVersion ?? null, ...(cmd.retryAt ? { retryAt: cmd.retryAt } : {}) };
      if (cmd.outcome === 'merged' || cmd.outcome === 'indeterminate') {
        // The merged fact comes from a live read (verify_merge → PrMerged), never from this response.
        return c.apply(key, 'LANDING', {
          guardHead: true,
          effects: [{
            kind: 'verify_merge', dedupeKey: `verify_merge:${dd.id}:${cmd.headSha}:${cmd.landingVersion ?? 'x'}:${cmd.outcome}`,
            payload: { headSha: cmd.headSha, outcome: cmd.outcome, landingVersion: cmd.landingVersion ?? null, ...(cmd.retryAt ? { retryAt: cmd.retryAt } : {}) },
          }],
          evidence,
        });
      }
      if (cmd.outcome === 'not_merged') {
        // Nothing landed: the approval still stands, a door or the sweep may land it again.
        return c.apply(key, 'APPROVED', { guardHead: true, patch: { stateReason: null }, evidence });
      }
      if (cmd.outcome === 'gate_refused') {
        // §4: the gate, asked again when the merge effect ran, refused before any merge call.
        // A rail (CI, protected paths, size, a hold) leaves a standing approval standing: a door
        // or the sweep asks again once the rail passes. Anything else is a person's to look at.
        const gate = { half: cmd.gate?.half ?? 'rails', reasons: cmd.gate?.reasons ?? [], ...(cmd.gate?.lasting ? { lasting: true } : {}) };
        // A rail that clears on its own (pending CI, a hold) waits with the approval standing;
        // a lasting one (protected path, migration, size) is a person's, named in the notice.
        if (gate.half === 'rails' && !gate.lasting && headCoverage(dd, cmd.headSha) !== 'none') {
          return c.apply(key, 'APPROVED', { guardHead: true, patch: { stateReason: null }, evidence: { ...evidence, gate } });
        }
        return c.apply(key, 'ESCALATED', {
          guardHead: true, patch: { stateReason: 'landing_needs_human' },
          effects: [{ kind: 'notify', dedupeKey: `notify:${dd.id}:landing_gate:${cmd.headSha}:${cmd.landingVersion ?? 'x'}`, payload: { event: 'landing_needs_human', detail: cmd.detail ?? gate.reasons.join('; ') } }],
          evidence: { ...evidence, gate },
          ...(gate.reasons[0] ? { statusDetail: gate.reasons[0] } : {}),
        });
      }
      if (cmd.outcome === 'held') {
        // §4 merge holds: GitHub waits on a required check that has not passed yet. The merge
        // effect waits on it itself; it says so here only when it stops waiting.
        const hold = { check: cmd.hold?.check ?? null, heldForMs: cmd.hold?.heldForMs ?? null, ...(cmd.hold?.lasting ? { lasting: true } : {}) };
        if (!hold.lasting) return c.apply(key, 'APPROVED', { guardHead: true, patch: { stateReason: null }, evidence: { ...evidence, hold } });
        const detail = cmd.detail ?? `GitHub kept the merge waiting on ${hold.check ? `required check "${hold.check}"` : 'a required check'}`;
        return c.apply(key, 'ESCALATED', {
          guardHead: true, patch: { stateReason: 'landing_needs_human' },
          effects: [{ kind: 'notify', dedupeKey: `notify:${dd.id}:landing_hold:${cmd.headSha}:${cmd.landingVersion ?? 'x'}`, payload: { event: 'landing_needs_human', detail, check: hold.check } }],
          evidence: { ...evidence, hold },
          statusDetail: detail,
        });
      }
      if (cmd.outcome === 'refused') {
        return c.apply(key, 'ESCALATED', {
          guardHead: true, patch: { stateReason: 'landing_needs_human' },
          effects: [{ kind: 'notify', dedupeKey: `notify:${dd.id}:landing:${cmd.headSha}:${cmd.landingVersion ?? 'x'}`, payload: { event: 'landing_needs_human', detail: cmd.detail ?? null } }],
          evidence,
        });
      }
      return conflictRepair(c, cmd.headSha, cmd.outcome, {
        key, mechanicalRefused: false, maxMechanical: DEFAULT_MAX_MECHANICAL, maxAgent: 3, patch: {},
      });
    }

    // T17
    case 'PrMerged': {
      const dd = d!;
      if (dd.state === 'MERGED') return c.duplicate('already_merged');
      if (isTerminal(dd.state)) return c.stale('terminal');
      if (!cmd.live.merged) return c.rejected('not_merged');
      const mergedHead = cmd.live.headSha;
      const coverage = headCoverage(dd, mergedHead);
      const rc = c.view.rounds.some((r) => r.headSha === mergedHead && r.status === 'decided' && r.effectiveVerdict === 'request_changes');
      const reviewClass = coverage !== 'none' ? `covered:${coverage}` : rc ? 'merged_over_verdict' : 'merged_unreviewed';
      const fx = (kind: EffectSpec['kind']): EffectSpec => ({ kind, dedupeKey: `${kind}:${dd.id}:merged`, payload: { mergeCommitSha: cmd.live.mergeCommitSha ?? null } });
      // §13.13 rule 10: every buildd door lands a kernel PR through LANDING, so a merge that
      // arrives from any other state is one no buildd door made. It is recorded as it happened
      // (who, at which head, over which verdict) and approves nothing; an open verdict it merged
      // over is owed a fix against the base, filed once.
      const external = dd.state !== 'LANDING';
      const open = external ? openVerdict(c.view) : null;
      // §5: the findings still open at the merge stay open and attached to the merged PR.
      const openFindings = external ? openRequiredFindings(c.view) : [];
      const mergedOverOpenFindings = !!open || openFindings.length > 0;
      // The fix is owed only for changes asked of the head that merged: an escalation a person
      // resolved by merging is their decision, and a verdict on an older head was not about it.
      const owesFix = !!open && (open.effectiveVerdict ?? open.verdict) === 'request_changes' && open.headSha === mergedHead;
      const externalEffects: EffectSpec[] = owesFix && open
        ? [{
            kind: 'dispatch_external_merge_fix', dedupeKey: `dispatch_external_merge_fix:${dd.id}:merged`,
            payload: {
              roundId: open.id, round: open.round, reviewedHeadSha: open.headSha, mergedHeadSha: mergedHead, mergeCommitSha: cmd.live.mergeCommitSha ?? null, mergedBy: cmd.live.mergedBy ?? null,
              ...(openFindings.length ? { findings: openFindings.map((x) => ({ id: x.id, path: x.path, line: x.line, title: x.title })) } : {}),
            },
          }]
        : [];
      return c.apply(`merged:${c.prKey}`, 'MERGED', {
        states: NON_TERMINAL,
        patch: { mergedAt: cmd.live.mergedAt ?? null, mergeCommitSha: cmd.live.mergeCommitSha ?? null, boundAttemptId: null, resumeState: null },
        rounds: c.openRounds().map((r) => ({ op: 'update', roundId: r.id, whenStatus: ['queued', 'reviewing'], set: { status: 'superseded' } })),
        attempts: [{ op: 'cancel_open', families: ['review_fix', 'ci', 'conflict', 'migration'], status: 'cancelled' }],
        // The mission wake and the release attribution are subscribers of the one `task.pr_merged`
        // fan-out `emit_pr_merged` makes, so they see the task transition this merge produced.
        effects: [fx('stamp_pr_rows'), { ...fx('cancel_open_attempts'), payload: { mergeCommitSha: cmd.live.mergeCommitSha ?? null, reason: 'merged', ...mootOnResolution(c.view) } }, fx('emit_pr_merged'), fx('finalize_mission_pr'), ...externalEffects],
        evidence: {
          live: cmd.live, reviewClass,
          ...(external ? { external: true, mergedBy: cmd.live.mergedBy ?? null, mergedHead, fromState: dd.state, merged_over_open_findings: mergedOverOpenFindings } : {}),
          ...(open ? { openVerdict: { roundId: open.id, round: open.round, headSha: open.headSha, verdict: open.effectiveVerdict ?? open.verdict } } : {}),
          ...(openFindings.length ? { openFindings: openFindings.map((x) => x.id) } : {}),
        },
      });
    }

    // T18
    case 'PrClosedUnmerged': {
      const dd = d!;
      if (dd.state === 'CLOSED_UNMERGED') return c.duplicate('already_closed');
      if (isTerminal(dd.state)) return c.stale('terminal');
      if (cmd.live.state !== 'closed' || cmd.live.merged) return c.rejected('not_closed_unmerged');
      const fx = (kind: EffectSpec['kind']): EffectSpec => ({ kind, dedupeKey: `${kind}:${dd.id}:closed:${cmd.live.updatedAt ?? 'unknown'}`, payload: { closeCause: cmd.closeCause } });
      return c.apply(`closed:${c.prKey}:${cmd.live.updatedAt ?? 'unknown'}`, 'CLOSED_UNMERGED', {
        states: NON_TERMINAL,
        // Any other resume (a red base's APPROVED) ends with the close; a spent review budget
        // does not (79649a80), so the reopen still goes to the person.
        patch: { stateReason: cmd.closeCause, boundAttemptId: null, resumeState: reviewBudgetHeld(dd) ? 'ESCALATED' : null },
        rounds: c.openRounds().map((r) => ({ op: 'update', roundId: r.id, whenStatus: ['queued', 'reviewing'], set: { status: 'superseded' } })),
        attempts: [{ op: 'cancel_open', families: ['review_fix', 'ci', 'conflict', 'migration'], status: 'cancelled' }],
        effects: [{ ...fx('cancel_open_attempts'), payload: { closeCause: cmd.closeCause, reason: 'closed', ...mootOnResolution(c.view) } }, fx('scan_supersession'), fx('mission_note'), fx('stamp_pr_rows')],
        evidence: { live: cmd.live },
      });
    }

    // T19. On a delivery closed with its review budget spent, `apply` turns the round into
    // ESCALATED(review_exhausted) at the reopened head (79649a80).
    case 'PrReopened': {
      const dd = d!;
      if (dd.state !== 'CLOSED_UNMERGED') return isTerminal(dd.state) ? c.stale('terminal') : c.duplicate('not_closed');
      if (!livePrOpen(cmd.live)) return c.rejected('pr_not_open');
      const head = cmd.live.headSha;
      const r = c.startRound(head);
      // `apply` redirects the round to the person; the person is told it is back with them, once
      // per reopen (the version read), as the original exhaustion told them.
      const told: EffectSpec[] = reviewBudgetHeld(dd)
        ? [{ kind: 'escalate_exhaustion', dedupeKey: `exhaust:${dd.id}:${head}@v${dd.version}`, payload: { family: 'review_fix', rounds: dd.currentRound, reopened: true } }]
        : [];
      return c.apply(`reopen:${c.prKey}:${cmd.live.updatedAt ?? 'unknown'}`, 'AWAITING_REVIEW', {
        patch: { ...r.patch, currentHeadSha: head, stateReason: null }, rounds: r.rounds, effects: [...r.effects, ...told], evidence: { live: cmd.live },
      });
    }

    // T29 — §6.4 base row (24e1cfad)
    case 'BaseChanged': {
      const dd = d!;
      if (isTerminal(dd.state)) return c.stale('terminal');
      if (!livePrOpen(cmd.live)) return c.rejected('pr_not_open');
      const to = cmd.live.baseRef;
      if (!to || to === dd.baseRef) return c.duplicate('base_unchanged');
      const key = baseChangeKey(c.prKey, dd.baseRef, to, dd.version);
      const evidence = { live: cmd.live, fromBase: dd.baseRef, toBase: to, diffEquivalent: cmd.diffEquivalent === true };
      // GitHub keeps the head and recomputes the diff: the delivery follows the base it lands on.
      if (cmd.diffEquivalent === true) return c.apply(key, dd.state, { patch: { baseRef: to }, evidence });
      const head = dd.currentHeadSha;
      // Every verdict so far reviewed the diff against the old base. None covers the new diff:
      // approvals are dropped and the rounds decided at this head stop counting as its review.
      const patch: DeliveryPatch = { baseRef: to, approvedHeads: [], compositionHeads: [], approvalBasis: null, policyEvidence: null };
      const retire: RoundOp[] = head
        ? c.view.rounds.filter((r) => r.headSha === head && r.status === 'decided')
          .map((r) => ({ op: 'update', roundId: r.id, whenStatus: ['decided'], set: { status: 'superseded' } }))
        : [];
      const review = (extra: { attempts?: AttemptOp[]; effects?: EffectSpec[] } = {}): Decision => {
        const r = c.startRound(head!, { trigger: 'base_refresh' });
        return c.apply(key, 'AWAITING_REVIEW', {
          patch: { ...patch, ...r.patch, stateReason: null }, rounds: [...retire, ...r.rounds],
          attempts: extra.attempts, effects: [...r.effects, ...(extra.effects ?? [])], evidence,
        });
      };
      switch (dd.state) {
        case 'APPROVED':
        case 'LANDING': // the queued merge call skips once the delivery leaves LANDING
        case 'AWAITING_REVIEW':
          if (head) return review();
          return c.apply(key, dd.state, { patch, rounds: retire, evidence });
        case 'BLOCKED_ON_TRUNK':
          return c.apply(key, dd.state, {
            patch: { ...patch, ...(dd.resumeState === 'APPROVED' ? { resumeState: 'AWAITING_REVIEW' as const } : {}) }, rounds: retire, evidence,
          });
        default:
          // WORKING, AWAITING_PUSH, CHANGES_REQUESTED, FIXING, REPAIRING, ESCALATED, CLOSED_UNMERGED:
          // the state's owner keeps the next move; leaving it reviews the head against the new base.
          return c.apply(key, dd.state, { patch, rounds: retire, evidence });
      }
    }

    // T20
    case 'SupersessionRecorded': {
      const dd = d!;
      if (dd.state === 'SUPERSEDED') {
        return dd.supersededByPr === cmd.target.prNumber ? c.duplicate('edge_exists_same') : c.rejected('edge_exists');
      }
      if (dd.state !== 'CLOSED_UNMERGED') return c.rejected('not_closed_unmerged');
      if (cmd.target.prNumber === dd.prNumber && cmd.target.repoFullName === dd.repoFullName) return c.rejected('same_pr');
      if (!cmd.target.merged) return c.rejected('target_not_merged');
      if (!cmd.authorised) return c.rejected('not_authorised');
      if (!cmd.reason.trim()) return c.rejected('reason_required');
      return c.apply(`supersede:${c.prKey}:${cmd.target.repoFullName}#${cmd.target.prNumber}`, 'SUPERSEDED', {
        patch: { supersededByPr: cmd.target.prNumber, supersededByUrl: cmd.target.url, supersededReason: cmd.reason, recordedBy: cmd.actor },
        effects: [
          { kind: 'project_supersession', dedupeKey: `project_supersession:${dd.id}`, payload: { target: cmd.target } },
          { kind: 'wake_mission', dedupeKey: `wake_mission:${dd.id}:superseded`, payload: {} },
        ],
        evidence: { target: cmd.target, reason: cmd.reason },
      });
    }

    // T21
    case 'Abandon': {
      const dd = d!;
      if (dd.state === 'ABANDONED') return c.duplicate('already_abandoned');
      if (dd.state !== 'CLOSED_UNMERGED') return c.rejected('not_closed_unmerged');
      if (!isHumanActor(cmd.actor)) return c.rejected('human_required');
      if (!cmd.reason.trim()) return c.rejected('reason_required');
      return c.apply(`abandon:${c.prKey}`, 'ABANDONED', {
        patch: { stateReason: cmd.reason, recordedBy: cmd.actor },
        // One projection effect for both resolutions (§12: `supersededBy*` and `abandoned*` are
        // the one edge); the handler reads which from the delivery's terminal state.
        effects: [
          { kind: 'project_supersession', dedupeKey: `project_supersession:${dd.id}`, payload: {} },
          { kind: 'wake_mission', dedupeKey: `wake_mission:${dd.id}:abandoned`, payload: {} },
        ],
        evidence: { reason: cmd.reason },
      });
    }

    // T22
    case 'PushRecoveryExhausted': {
      const dd = d!;
      if (dd.state !== 'AWAITING_PUSH') return c.stale('state_moved');
      // One per visit (10658a4c): a second visit at the same L escalates under its own key.
      const chain = pushChainId(cmd.localHeadSha, currentPushEntry(dd));
      return c.apply(`pushdead:${dd.id}:${chain}`, 'ESCALATED', {
        patch: { stateReason: 'push_undeliverable' },
        effects: [{ kind: 'notify', dedupeKey: `notify:${dd.id}:pushdead:${chain}`, payload: { event: 'push_undeliverable', localHeadSha: cmd.localHeadSha, baseRef: dd.baseRef } }],
      });
    }

    // §10.3: a critical effect went dead. The state it was owed in hands over to a person.
    case 'EffectDead': {
      const dd = d!;
      if (isTerminal(dd.state)) return c.stale('terminal');
      if (dd.state === 'ESCALATED') return c.duplicate('already_escalated');
      const owedIn = DEAD_EFFECT_OWED_IN[cmd.effectKind];
      if (!owedIn) return c.rejected('not_critical');
      if (owedIn !== 'any' && !owedIn.includes(dd.state)) return c.stale('state_moved');
      // A mechanical repair hands over only for the repair the delivery is waiting on: its key is
      // `<kind>:<delivery>:<head>:mechanical:<n>` (a trunk-recovery refresh carries no ledger row).
      const mechanical = MECHANICAL_REPAIR_EFFECTS.has(cmd.effectKind);
      const [, , deadHead, deadMode] = cmd.dedupeKey.split(':');
      if (mechanical && deadMode !== 'mechanical') return c.stale('not_bound_repair');
      if (mechanical && deadHead !== dd.currentHeadSha) return c.stale('head_moved');
      const bound = mechanical ? c.attempt(dd.boundAttemptId) : undefined;
      const endBound: AttemptOp[] = bound?.mode === 'mechanical'
        ? [{ op: 'update', attemptId: bound.id, whenStatus: ['queued', 'running'], set: { status: 'ended', outcome: 'failed', ended: true } }]
        : [];
      // A dead dispatch_review is the round not being served, T27's outcome: `review_unavailable`,
      // which anyone may ask again (T5). A dead behind refresh is a landing hand-off: the person
      // may land past freshness (T15's override) or retry. Every other dead effect waits for a person.
      const reason = cmd.effectKind === 'push_recovery' ? 'push_undeliverable'
        : cmd.effectKind === 'merge_call' || cmd.effectKind === 'verify_merge' ? 'landing_needs_human'
          : cmd.effectKind === 'refresh_branch' && dd.stateReason === 'behind' ? 'landing_needs_human'
            : cmd.effectKind === 'dispatch_review' ? 'review_unavailable' : 'effect_dead';
      const local = dd.pushPendingLocalHead ?? null;
      const notice: EffectSpec = reason === 'push_undeliverable'
        ? { kind: 'notify', dedupeKey: `notify:${dd.id}:effectdead:${cmd.effectId}`, payload: { event: 'push_undeliverable', localHeadSha: local, baseRef: dd.baseRef } }
        : { kind: 'notify', dedupeKey: `notify:${dd.id}:effectdead:${cmd.effectId}`, payload: { event: 'effect_dead', effectKind: cmd.effectKind, reason, fromState: dd.state } };
      // The round that dispatch was serving is not being served: close it as T27 does, or the
      // next request for this head would read it as a review in flight.
      const rounds: RoundOp[] = cmd.effectKind === 'dispatch_review'
        ? c.openRounds().map((r) => ({ op: 'update', roundId: r.id, whenStatus: ['queued', 'reviewing'], set: { status: 'failed' } }))
        : [];
      return c.apply(`effectdead:${cmd.effectId}`, 'ESCALATED', {
        patch: { stateReason: reason, boundAttemptId: null },
        rounds,
        attempts: endBound,
        effects: [notice],
        evidence: { effectId: cmd.effectId, effectKind: cmd.effectKind, dedupeKey: cmd.dedupeKey, lastError: cmd.lastError ?? null, fromState: dd.state, reason },
      });
    }

    // T23
    case 'HumanResolve': {
      const dd = d!;
      if (dd.state !== 'ESCALATED') return c.stale('state_moved');
      if (!isHumanActor(cmd.actor)) return c.rejected('human_required');
      if (cmd.expectedVersion === undefined) return c.rejected('expected_version_required');
      const key = `resolve:${dd.id}:${dd.version}`;
      const bypass = { choice: cmd.choice, reason: cmd.reason ?? null, actor: cmd.actor, escalation: dd.stateReason };
      if (cmd.choice === 'approve') {
        if (!dd.currentHeadSha) return c.rejected('no_head');
        // The same evidence T14 requires: an approval of the live head by someone who may merge.
        if (!cmd.commitId) return c.rejected('commit_id_required');
        if (cmd.commitId !== dd.currentHeadSha) return c.stale('review_on_older_commit');
        if (cmd.hasMergePermission !== true) return c.rejected('no_merge_permission');
        return c.apply(key, 'APPROVED', {
          guardHead: true,
          patch: { approvedHeads: [cmd.commitId], approvalBasis: 'human', stateReason: null },
          evidence: { commitId: cmd.commitId },
          bypass,
        });
      }
      if (cmd.choice === 'dismiss') {
        if (!cmd.reason?.trim()) return c.rejected('reason_required');
        if (!dd.currentHeadSha) return c.rejected('no_head');
        const r = c.startRound(dd.currentHeadSha, { kind: 'full', trigger: 'manual_force' });
        return c.apply(key, 'AWAITING_REVIEW', { patch: { ...r.patch, stateReason: null }, rounds: r.rounds, effects: r.effects, bypass });
      }
      // apply_recommendation / request_changes: a new review_fix attempt against the round the
      // person is looking at. With no review of the current head there is nothing to fix against,
      // and CHANGES_REQUESTED with no dispatchable fix would strand the delivery.
      const round = c.currentRound();
      if (!dd.currentHeadSha || !round || round.headSha !== dd.currentHeadSha) return c.rejected('no_review_at_head');
      const instructions = cmd.instructions?.trim() || null;
      return c.apply(key, 'CHANGES_REQUESTED', {
        patch: { stateReason: null, boundAttemptId: null },
        effects: [{
          kind: 'dispatch_fix', dedupeKey: `dispatch_fix:${dd.id}:${round.id}:human:${dd.version}`,
          payload: { roundId: round.id, round: dd.currentRound, headSha: dd.currentHeadSha, trigger: 'human', choice: cmd.choice, actor: cmd.actor, humanInstructions: instructions },
        }],
        bypass,
      });
    }

    // T24
    case 'DeliveryFailed': {
      const dd = d!;
      if (dd.state === 'FAILED') return c.duplicate('already_failed');
      if (dd.state !== 'WORKING' && dd.state !== 'AWAITING_PUSH') return c.rejected('state_not_allowed');
      if (dd.prNumber != null) return c.rejected('pr_bound');
      return c.apply(`fail:${dd.ownerTaskId}`, 'FAILED', { patch: { stateReason: cmd.reason, boundAttemptId: null } });
    }

    // T25
    case 'TrunkRedObserved': {
      const dd = d!;
      if (dd.state === 'BLOCKED_ON_TRUNK') return dd.trunkIncidentId === cmd.incidentId ? c.duplicate('already_blocked') : c.stale('blocked_on_other_incident');
      if (cmd.headSha !== dd.currentHeadSha) return c.stale('head_not_current');
      const allowed = dd.state === 'AWAITING_REVIEW' || dd.state === 'APPROVED' || dd.state === 'LANDING' || (dd.state === 'REPAIRING' && dd.stateReason === 'ci');
      if (!allowed) return c.stale('state_not_allowed');
      if (!cmd.thresholdMet) return c.rejected('threshold_not_met');
      const covered = headCoverage(dd, dd.currentHeadSha) !== 'none';
      // 2ded4e88: a repair out of a spent review budget resumes at the person, never at a reviewer.
      const resume: DeliveryState = dd.state === 'LANDING' ? 'APPROVED'
        : dd.state === 'REPAIRING' ? (reviewBudgetHeld(dd) ? 'ESCALATED' : covered ? 'APPROVED' : 'AWAITING_REVIEW')
          : dd.state;
      return c.apply(`trunk:${cmd.incidentId}:${dd.id}`, 'BLOCKED_ON_TRUNK', {
        guardHead: true,
        patch: { resumeState: resume, trunkIncidentId: cmd.incidentId, stateReason: cmd.signature, boundAttemptId: null, ci: 'red', ciHeadSha: cmd.headSha },
        attempts: [{ op: 'cancel_open', families: ['ci'], status: 'skipped' }],
        effects: [
          // One trunk fix per incident, never per PR: the key carries no delivery.
          { kind: 'dispatch_trunk_fix', dedupeKey: `dispatch_trunk_fix:${cmd.incidentId}`, payload: { incidentId: cmd.incidentId, signature: cmd.signature } },
          { kind: 'cancel_open_attempts', dedupeKey: `cancel_open_attempts:${dd.id}:trunk:${cmd.incidentId}`, payload: { families: ['ci'], reason: 'blocked_on_trunk' } },
        ],
        evidence: { incidentId: cmd.incidentId, signature: cmd.signature },
      });
    }

    // T26
    case 'TrunkRecovered': {
      const dd = d!;
      if (dd.state !== 'BLOCKED_ON_TRUNK' || dd.trunkIncidentId !== cmd.incidentId) return c.stale('not_blocked_on_incident');
      if (cmd.baseStillRed) return c.rejected('trunk_still_red');
      const resume = dd.resumeState ?? 'AWAITING_REVIEW';
      const head = dd.currentHeadSha;
      // A head nothing will land (it resumes at a spent review budget's person) is not refreshed.
      const effects: EffectSpec[] = cmd.headPredatesFix && head && resume !== 'ESCALATED'
        ? [{ kind: 'refresh_branch', dedupeKey: `refresh_branch:${dd.id}:${head}:trunk:${cmd.incidentId}`, payload: { headSha: head, reason: 'trunk_recovered' } }]
        : [];
      let patch: DeliveryPatch = { resumeState: null, trunkIncidentId: null, stateReason: null, ci: null, ciHeadSha: null };
      let rounds: RoundOp[] = [];
      const key = `trunkok:${cmd.incidentId}:${dd.id}`;
      const evidence = { incidentId: cmd.incidentId };
      // 47be5f6c: re-enter at the CURRENT head. APPROVED is a resume only while a verdict
      // (or carried evidence) covers that head; a head pushed while blocked that nothing
      // covers is owed a review, exactly as §6.4's APPROVED row would have owed one.
      const uncovered = !!head && dd.approvalBasis !== 'policy' && headCoverage(dd, head) === 'none';
      if (head && uncovered && (resume === 'AWAITING_REVIEW' || resume === 'APPROVED')) {
        if (c.openRoundAt(head)) return c.apply(key, 'AWAITING_REVIEW', { patch, effects, evidence });
        const decided = c.decidedAt(head);
        if (decided) {
          // b666505e: the verdict that landed while blocked is applied now, never re-asked.
          const r = reenterVerdict(c, key, decided, head, evidence);
          return r.result === 'apply' ? { ...r, patch: { ...patch, ...r.patch }, effects: [...effects, ...r.effects] } : r;
        }
        const r = c.startRound(head, { trigger: 'base_refresh' });
        patch = { ...patch, ...r.patch }; rounds = r.rounds; effects.push(...r.effects);
        return c.apply(key, 'AWAITING_REVIEW', { patch, rounds, effects, evidence: { ...evidence, ...(resume === 'APPROVED' ? { approvalNotCovering: head } : {}) } });
      }
      // 2ded4e88: back to the person a spent review budget left it with.
      if (resume === 'ESCALATED') return c.apply(key, 'ESCALATED', { patch: { ...patch, stateReason: 'review_exhausted' }, effects, evidence: { ...evidence, reviewBudgetSpent: true } });
      return c.apply(key, resume, { patch, rounds, effects, evidence });
    }

    // T27
    case 'ReviewRoundFailed': {
      const dd = d!;
      if (dd.state !== 'AWAITING_REVIEW') return c.stale('state_moved');
      const round = c.roundById(cmd.roundId);
      if (!round || !OPEN_ROUND.has(round.status) || round.round !== dd.currentRound) return c.stale('round_not_current');
      // A reviewer the round no longer (or never) waits on cannot spend the budget of the one it does.
      if (cmd.reviewerTaskId && round.reviewerTaskId && round.reviewerTaskId !== cmd.reviewerTaskId) return c.stale('reviewer_not_current');
      return roundFailed(c, round, cmd);
    }

    // T28: a preflight finding for one head, imported as policy evidence.
    case 'PolicyEvidenceRecorded': {
      const dd = d!;
      const ev = cmd.evidence;
      if (isTerminal(dd.state)) return c.stale('terminal');
      // Head-bound: a finding about an older head never escalates the head now current.
      if (ev.headSha !== dd.currentHeadSha) return c.stale('head_not_current');
      const prior = dd.policyEvidence;
      if (prior && prior.headSha === ev.headSha && prior.outcome === ev.outcome) return c.duplicate('evidence_recorded');
      const key = policyKey(dd.id, ev, dd.version);
      // Only a delivery waiting on nobody's work can act on it now. Everywhere else the platform
      // (a running owner, an open repair, a queued fix, a landing) already owns the PR: record the
      // finding on the head and let that work's own hand-off apply it (WORKING), or let the head
      // move make it stale. Landing's rails still gate the merge.
      if (!QUIESCENT_FOR_POLICY.has(dd.state) || c.openAttempt(['review_fix', 'ci', 'conflict', 'migration', 'trunk'])) {
        const owner = c.openAttempt(['review_fix', 'ci', 'conflict', 'migration', 'trunk']);
        return c.apply(key, dd.state, { guardHead: true, patch: { policyEvidence: ev }, evidence: { policyEvidence: ev, recordedOnly: true, mergedIntoAttempt: owner?.id ?? null } });
      }
      return policyDecision(c, key, ev, {});
    }

    // Composition attestation (release / integration PR built from reviewed changes)
    case 'CompositionAttested': {
      const dd = d!;
      const att = cmd.attestation;
      if (att.repoFullName !== dd.repoFullName || att.prNumber !== dd.prNumber) return c.rejected('attestation_pr_mismatch');
      if (att.aggregateHeadSha !== dd.currentHeadSha) return c.stale('head_not_current');
      if (dd.state !== 'AWAITING_REVIEW') return c.stale('state_not_allowed');
      // §13.13 rule 2 / AC-24: an attestation covers a head, it never closes a finding. A whole-PR
      // composition approval over one is refused; a delta round still runs and leaves it open.
      const standing = att.novelDelta.result === 'none' ? openRequiredFindings(c.view) : [];
      if (standing.length) return c.rejected('open_findings', { missing: standing.map(describeFinding) });
      if (att.novelDelta.result === 'unverifiable') return c.rejected('composition_unverifiable', { missing: [att.novelDelta.reason] });
      const v = verifyCompositionAttestation(att, cmd.constituents);
      if (!v.ok) return c.rejected('composition_not_verified', { missing: v.reasons });
      const evidence = {
        factId: cmd.factId ?? null,
        method: att.method,
        baseSha: att.baseSha,
        aggregateHeadSha: att.aggregateHeadSha,
        constituents: att.constituents.map((x) => ({
          roundId: x.roundId, prNumber: x.prNumber, reviewedHeadSha: x.reviewedHeadSha, mergedHeadSha: x.mergedHeadSha, landedSha: x.landedSha, patchId: x.landedPatchId,
        })),
        novelDelta: att.novelDelta,
      };
      const key = `compose:${dd.id}:${att.aggregateHeadSha}`;
      if (att.novelDelta.result === 'none') {
        // Covered by composition, NOT by a verdict: approved_heads is untouched
        // and no round is decided at this head.
        return c.apply(key, 'APPROVED', {
          guardHead: true,
          patch: { compositionHeads: [...dd.compositionHeads, att.aggregateHeadSha], approvalBasis: 'composition', stateReason: null },
          rounds: c.openRounds().map((r) => ({ op: 'update', roundId: r.id, whenStatus: ['queued', 'reviewing'], set: { status: 'superseded' } })),
          evidence,
        });
      }
      const r = c.startRound(att.aggregateHeadSha, { kind: 'delta', scope: { novelDeltaPaths: att.novelDelta.paths, composition: true }, trigger: 'composition' });
      return c.apply(key, 'AWAITING_REVIEW', { guardHead: true, guardRound: true, patch: r.patch, rounds: r.rounds, effects: r.effects, evidence });
    }
  }
}

// ── T6: a decided round's verdict, with its findings (§5) ───────────────────

/**
 * Decide `round` with `cmd`'s verdict and apply what it means. `held`: a repair
 * or a red trunk holds the delivery at this head (b666505e), so the round is
 * decided now and leaving the hold re-enters it (reenterVerdict); the state
 * does not move. Every path writes the verdict's findings in the same
 * statement: what it raised, restated, resolved and deferred.
 *
 * An approval that leaves a required finding unverified is not an approval of
 * the head (§5, rule 2): the round is decided as the reviewer said, and a
 * verification round at the same head is owed instead, while rounds remain.
 */
function verdictDecided(
  c: Ctx,
  round: RoundSnapshot,
  cmd: Extract<Command, { type: 'ReviewVerdictRecorded' }>,
  o: { held: boolean },
): Decision {
  const dd = c.d!;
  const decide: RoundOp = {
    op: 'update', roundId: round.id, whenStatus: ['queued', 'reviewing'],
    set: { status: 'decided', verdict: cmd.verdict, effectiveVerdict: cmd.effectiveVerdict, confidence: cmd.confidence ?? null, decided: true },
  };
  const key = `verdict:${round.id}`;
  const f = applyVerdictToFindings(c.view, round, cmd.effectiveVerdict, cmd, cmd.actor);
  const findingsEvidence = (f.raised.length || f.resolved.length || f.restated.length || f.deferred.length || f.unresolvedDeferrals.length)
    ? { findings: {
        raised: f.raised, resolved: f.resolved, restated: f.restated, deferred: f.deferred, open: f.stillOpen.map((x) => x.id),
        // A deferral that named no resolvable task closes nothing; recorded so it is visible why.
        ...(f.unresolvedDeferrals.length ? { unresolvedDeferrals: f.unresolvedDeferrals } : {}),
      } }
    : {};
  const common = {
    guardHead: true, guardRound: true, findings: f.ops,
    evidence: { roundId: round.id, headSha: round.headSha, verdict: cmd.verdict, effectiveVerdict: cmd.effectiveVerdict, ...findingsEvidence },
  };
  const postReview = (event: 'APPROVE' | 'REQUEST_CHANGES'): EffectSpec => ({
    kind: 'post_review', dedupeKey: `post_review:${dd.id}:${round.id}`, payload: { commitId: round.headSha, event, roundId: round.id },
  });
  const unverified = cmd.effectiveVerdict === 'approve' && f.stillOpen.length > 0;
  // A verdict that blocks contradicts a reviewer's approval standing at the same commit (a forced
  // re-review that found what the first missed): that approval is withdrawn, not left covering the
  // head beside the request for changes. A person's own approval (`human`) is theirs to withdraw.
  const withdrawal: { patch: DeliveryPatch; evidence: Record<string, unknown> } =
    cmd.effectiveVerdict !== 'approve' && dd.approvalBasis === 'verdict' && dd.approvedHeads.includes(round.headSha)
      ? { patch: { approvedHeads: [], approvalBasis: null }, evidence: { withdrewApproval: { headSha: round.headSha, heads: dd.approvedHeads, byRoundId: round.id } } }
      : { patch: {}, evidence: {} };
  if (o.held) {
    // The GitHub review is the reviewer's word on this commit; the kernel still gates landing.
    const ev = cmd.effectiveVerdict === 'approve' && !unverified ? 'APPROVE' : cmd.effectiveVerdict === 'request_changes' ? 'REQUEST_CHANGES' : null;
    return c.apply(key, dd.state, {
      ...common,
      evidence: { ...common.evidence, heldBy: dd.state, deferred: true },
      rounds: [decide],
      effects: ev && round.scope?.composition !== true ? [postReview(ev)] : [],
    });
  }
  if (unverified) return verificationRound(c, key, round, f.stillOpen, { ...common, rounds: [decide] });
  if (cmd.effectiveVerdict === 'approve' && round.scope?.composition === true) {
    // §5.9 / S33: the delta round of a composition reviewed only the novel
    // paths; every other change rests on its own constituent's verdict. The
    // approval stays a composition one (head in composition_heads, never in
    // approved_heads), and its GitHub review says it covers the delta only.
    const paths = Array.isArray(round.scope.novelDeltaPaths) ? (round.scope.novelDeltaPaths as unknown[]).map(String) : [];
    const scope = { compositionDelta: true, paths };
    return c.apply(key, 'APPROVED', {
      ...common,
      evidence: { ...common.evidence, compositionDelta: { roundId: round.id, paths } },
      patch: {
        compositionHeads: dd.compositionHeads.includes(round.headSha) ? dd.compositionHeads : [...dd.compositionHeads, round.headSha],
        approvalBasis: 'composition', stateReason: null,
      },
      rounds: [decide],
      attempts: [{ op: 'cancel_open', families: ['review_fix'], status: 'cancelled' }],
      effects: [{ ...postReview('APPROVE'), payload: { ...postReview('APPROVE').payload, scope } }, { kind: 'cancel_open_attempts', dedupeKey: `cancel_open_attempts:${dd.id}:${round.id}`, payload: { families: ['review_fix'], reason: 'approved' } }],
    });
  }
  if (cmd.effectiveVerdict === 'approve') {
    // 58c8961e: a delta round that followed an approval carries it: approval at A plus this
    // passing review of A..B is the approval at B. Recorded with the round that judged the delta.
    const carried = deltaApprovalOf(round);
    return c.apply(key, 'APPROVED', {
      ...common,
      ...(carried ? { evidence: { ...common.evidence, deltaApproval: { fromHeadSha: carried.fromHeadSha, toHeadSha: round.headSha, roundId: round.id } } } : {}),
      patch: { approvedHeads: [round.headSha], approvalBasis: 'verdict', stateReason: null },
      rounds: [decide],
      attempts: [{ op: 'cancel_open', families: ['review_fix'], status: 'cancelled' }],
      effects: [postReview('APPROVE'), { kind: 'cancel_open_attempts', dedupeKey: `cancel_open_attempts:${dd.id}:${round.id}`, payload: { families: ['review_fix'], reason: 'approved' } }],
    });
  }
  if (cmd.effectiveVerdict === 'escalate') {
    return c.apply(key, 'ESCALATED', {
      ...common,
      evidence: { ...common.evidence, ...withdrawal.evidence },
      patch: { stateReason: 'review_escalated', ...withdrawal.patch },
      rounds: [decide],
      effects: [{ kind: 'mission_note', dedupeKey: `mission_note:${dd.id}:${round.id}`, payload: { reason: 'review_escalated', roundId: round.id } }],
    });
  }
  if (budgetSpentAt(c.view, round, dd.maxRounds)) {
    // Rule 9: at the limit a repeated request for changes stays blocking, with its findings attached.
    // A re-check after an approval is never at the limit: it gets its repair cycle (c1d66a6a).
    return c.apply(key, 'ESCALATED', {
      ...common,
      evidence: { ...common.evidence, ...withdrawal.evidence },
      patch: { stateReason: 'review_exhausted', ...withdrawal.patch },
      rounds: [decide],
      effects: [postReview('REQUEST_CHANGES'), { kind: 'escalate_exhaustion', dedupeKey: `exhaust:${dd.id}:${round.headSha}@v${dd.version}`, payload: { family: 'review_fix', rounds: dd.currentRound, findings: f.stillOpen.map((x) => x.id) } }],
    });
  }
  return c.apply(key, 'CHANGES_REQUESTED', {
    ...common,
    evidence: { ...common.evidence, ...withdrawal.evidence },
    patch: { stateReason: null, ...withdrawal.patch },
    rounds: [decide],
    effects: [postReview('REQUEST_CHANGES'), {
      kind: 'dispatch_fix', dedupeKey: `dispatch_fix:${dd.id}:${round.id}:${c.nextNo('review_fix', 'agent')}`,
      payload: { roundId: round.id, round: round.round, headSha: round.headSha, attemptNo: c.nextNo('review_fix', 'agent') },
    }],
  });
}

/**
 * T27: the current round's reviewer failed it (no verdict, a prose one, or one read at
 * another commit than the head). Re-queued at the same head and round number while
 * `maxContractRetries` lasts, then ESCALATED(review_unavailable). Keyed on the reviewer
 * that failed; only a kernel-side failure with no reviewer counts by number.
 */
function roundFailed(
  c: Ctx,
  round: RoundSnapshot,
  f: {
    reason: Extract<Command, { type: 'ReviewRoundFailed' }>['reason'];
    reviewerTaskId?: string;
    maxContractRetries: number;
    retryDelayMs?: number;
    /** What an inconclusive verdict said, and the commit it was read at: kept on the transition for audit. */
    inconclusive?: { verdict: string; effectiveVerdict: string; evidenceSha: string | null; headSha: string };
  },
): Decision {
  const dd = c.d!;
  const n = round.failureCount + 1;
  const key = f.reviewerTaskId ? roundFailKey(round.id, f.reviewerTaskId) : `roundfail:${round.id}:${n}`;
  const ev = {
    roundId: round.id, reason: f.reason,
    ...(f.reviewerTaskId ? { reviewerTaskId: f.reviewerTaskId } : {}),
    ...(f.inconclusive ? { inconclusive: f.inconclusive } : {}),
  };
  const gate: EffectSpec = { kind: 'gate_event', dedupeKey: `gate_event:${round.id}:${n}`, payload: { slug: 'review_round_failed', reason: f.reason, failure: n } };
  // A person's takeover is not a contract failure to retry: it escalates now.
  if (n <= f.maxContractRetries && f.reason !== 'human_takeover') {
    // Re-queued at the same head with the same round number — never a new round.
    return c.apply(key, 'AWAITING_REVIEW', {
      guardRound: true,
      rounds: [{ op: 'update', roundId: round.id, whenStatus: ['queued', 'reviewing'], set: { status: 'queued', failureCount: n, clearReviewer: true } }],
      effects: [{ kind: 'dispatch_review', dedupeKey: `dispatch_review:${dd.id}:${round.round}:retry${n}`, payload: { roundId: round.id, round: round.round, headSha: round.headSha, kind: round.kind, retry: n }, ...(f.retryDelayMs ? { delayMs: f.retryDelayMs * n } : {}) }, gate],
      evidence: ev,
    });
  }
  return c.apply(key, 'ESCALATED', {
    guardRound: true,
    patch: { stateReason: 'review_unavailable' },
    rounds: [{ op: 'update', roundId: round.id, whenStatus: ['queued', 'reviewing'], set: { status: 'failed', failureCount: n } }],
    effects: [gate],
    evidence: ev,
  });
}

/**
 * §5: an approval at `head` that left required findings unverified. A round at
 * the same head is owed, scoped to verifying exactly those findings, while the
 * round budget lasts; past it the delivery is a person's (review_exhausted),
 * with the findings attached. Nothing approves the head meanwhile.
 */
function verificationRound(
  c: Ctx, key: string, decided: Pick<RoundSnapshot, 'id' | 'headSha' | 'kind'>, open: Array<{ id: string }>,
  o: { rounds?: RoundOp[]; findings?: FindingOp[]; evidence?: Record<string, unknown>; patch?: DeliveryPatch; attempts?: AttemptOp[]; effects?: EffectSpec[]; guardHead?: boolean; guardRound?: boolean },
): Decision {
  const dd = c.d!;
  const head = decided.headSha;
  const ids = open.map((x) => x.id);
  const evidence = { ...(o.evidence ?? {}), unverifiedFindings: ids };
  // The verification round to come is a counted one: it follows a verdict at the same head.
  if (spentReviewRounds(c.view) >= dd.maxRounds) {
    return c.apply(key, 'ESCALATED', {
      ...o, evidence,
      patch: { ...(o.patch ?? {}), stateReason: 'review_exhausted' },
      effects: [...(o.effects ?? []), { kind: 'escalate_exhaustion', dedupeKey: `exhaust:${dd.id}:${head}@v${dd.version}`, payload: { family: 'review_fix', rounds: dd.currentRound, findings: ids } }],
    });
  }
  // The other kind than the round it follows at this head: one open round per (head, kind) is a
  // unique index, and the decided round leaves it in the same statement. A round at a head that
  // already has a decided one reviews in full whatever its kind (no prior verdict at another head).
  const r = c.startRound(head, { kind: decided.kind === 'full' ? 'delta' : 'full', scope: { verifyFindings: ids }, trigger: 'verify_findings' });
  // The round being decided is written once, by the caller's op, never superseded by the new one.
  const written = new Set((o.rounds ?? []).filter((x) => x.op === 'update').map((x) => (x as { roundId: string }).roundId));
  const fresh = r.rounds.filter((x) => x.op !== 'update' || !written.has(x.roundId));
  return c.apply(key, 'AWAITING_REVIEW', {
    ...o, evidence,
    patch: { ...(o.patch ?? {}), ...r.patch, stateReason: null },
    rounds: [...(o.rounds ?? []), ...fresh],
    effects: [...(o.effects ?? []), ...r.effects],
  });
}

// ── Round triggers (58c8961e) ───────────────────────────────────────────────

/** The approval a delta round was eligible to carry, when it is one. */
export function deltaApprovalOf(round: Pick<RoundSnapshot, 'kind' | 'scope'>): { fromHeadSha: string } | null {
  if (round.kind !== 'delta') return null;
  const el = round.scope?.deltaApproval as { eligible?: unknown; fromHeadSha?: unknown } | undefined;
  return el?.eligible === true && typeof el.fromHeadSha === 'string' ? { fromHeadSha: el.fromHeadSha } : null;
}

/** Why a repair attempt's head is reviewed: a review fix, a CI fix, or the base merged in. */
function attemptTrigger(a: AttemptSnapshot | undefined): RoundTrigger {
  if (!a) return 'new_commits';
  if (a.family === 'review_fix') return 'changes_requested_fix';
  if (a.family === 'ci') return 'ci_fix';
  return 'base_refresh';
}

/** Why a head observed in the delivery's current state is reviewed. */
function headTrigger(c: Ctx): RoundTrigger {
  const d = c.d!;
  const a = c.attempt(d.boundAttemptId);
  switch (d.state) {
    case 'CHANGES_REQUESTED':
    case 'FIXING':
      return 'changes_requested_fix';
    case 'REPAIRING':
    case 'AWAITING_PUSH':
      return a ? attemptTrigger(a) : 'new_commits';
    case 'AWAITING_REVIEW':
      // A push while a review is still open: that review ends superseded by it.
      return c.openRounds().length > 0 ? 'superseded_by_push' : (c.lastDecided() ? 'new_commits' : 'first_pass');
    default:
      return c.lastDecided() ? 'new_commits' : 'first_pass';
  }
}

// ── T3 ──────────────────────────────────────────────────────────────────────

/**
 * T3, then §5: a push whose diff touched an open finding's path marks it
 * `addressed` by the new head, in the same statement. Not the platform's own
 * refresh (rule 5: a refresh push is never a fix).
 */
function headObserved(c: Ctx, cmd: Extract<Command, { type: 'HeadObserved' }>): Decision {
  const d = c.d!;
  // A head a mechanical repair (the base merged in, a migration renumbered) is bound to is the
  // platform's own write, never a fix, whoever's push it turns out to be.
  const mechanical = d.state === 'REPAIRING' && c.attempt(d.boundAttemptId)?.mode === 'mechanical';
  const dec = headObservedInner(c, cmd);
  if (dec.result !== 'apply' || mechanical || dec.evidence.carryForward === 'own_refresh') return dec;
  return withAddressed(c, dec, cmd.live.headSha, cmd.changedPaths);
}

/** `dec` plus the `addressed` marks a push of `changedPaths` at `head` makes (no finding is written twice). */
function withAddressed(c: Ctx, dec: ApplyDecision, head: string, changedPaths: string[] | null | undefined): ApplyDecision {
  const written = new Set((dec.findings ?? []).map((f) => (f.op === 'insert' ? f.id : f.findingId)));
  const addr = addressFindings(c.view, head, changedPaths).filter((f) => f.op === 'update' && !written.has(f.findingId));
  if (addr.length === 0) return dec;
  return {
    ...dec,
    findings: [...(dec.findings ?? []), ...addr],
    evidence: { ...dec.evidence, addressedFindings: addr.map((f) => (f as { findingId: string }).findingId) },
  };
}

function headObservedInner(c: Ctx, cmd: Extract<Command, { type: 'HeadObserved' }>): Decision {
  const d = c.d!;
  if (isTerminal(d.state)) return c.stale('terminal');
  if (d.prNumber == null) return c.rejected('pr_not_bound');
  if (!livePrOpen(cmd.live)) return c.rejected('pr_not_open');
  const h = cmd.live.headSha; // §6.3: the live head, never the payload head.
  if (h === d.currentHeadSha) return c.duplicate('head_unchanged');
  const key = headObservationKey(c.prKey, d.currentHeadSha, h, d.version);
  const evidence = { live: cmd.live, hintedHeadSha: cmd.hintedHeadSha ?? null, previousHead: d.currentHeadSha };
  const record = (): Decision => c.apply(key, d.state, { patch: { currentHeadSha: h }, evidence });
  const toReview = (extra: { attempts?: AttemptOp[]; effects?: EffectSpec[]; patch?: DeliveryPatch; evidence?: Record<string, unknown> } = {}): Decision => {
    const r = c.startRound(h, { trigger: headTrigger(c), delta: cmd.delta });
    return c.apply(key, 'AWAITING_REVIEW', {
      patch: { ...r.patch, currentHeadSha: h, stateReason: null, boundAttemptId: null, ...(extra.patch ?? {}) },
      rounds: r.rounds, attempts: extra.attempts, effects: [...r.effects, ...(extra.effects ?? [])], evidence: extra.evidence ?? evidence,
    });
  };
  const carry = (implied?: 'own_refresh'): Decision | null => {
    const basis = cmd.carryForward ?? implied;
    if (!basis) return null;
    const p: DeliveryPatch = d.approvalBasis === 'composition'
      ? { compositionHeads: [...d.compositionHeads, h] }
      : { approvedHeads: [...d.approvedHeads, h] };
    return c.apply(key, 'APPROVED', { patch: { ...p, currentHeadSha: h, stateReason: null }, evidence: { ...evidence, carryForward: basis } });
  };

  switch (d.state) {
    case 'WORKING':
      return record();
    case 'ESCALATED':
      // A spent conflict budget asked a person only to resolve the conflict. A head that is not
      // conflicted answers that, whoever pushed it, so it is reviewed like any new head: the
      // review gate decides the landing, and a dirty head is only recorded.
      if (d.stateReason === 'conflict_exhausted') return cmd.live.mergeableState === 'dirty' ? record() : toReview();
      // 2ded4e88: a spent review budget stays spent: the push is recorded, a person decides.
      if (d.stateReason === 'review_exhausted') return record();
      if (d.stateReason !== 'push_undeliverable') return d.stateReason?.startsWith('review_') ? toReview() : record();
      // T22: a head with §9 proof observed after the escalation wins over it.
    // falls through
    case 'AWAITING_PUSH': {
      const a = c.attempt(d.boundAttemptId);
      // An owner attempt has no ledger row: its L is the one it reported when it
      // entered AWAITING_PUSH, and its Hb is the head the delivery holds now.
      const local = a?.reportedShas.at(-1) ?? d.pushPendingLocalHead ?? null;
      const proof = deliveryProof({
        boundHeadSha: a?.boundHeadSha ?? d.currentHeadSha,
        localHeadSha: local,
        liveHeadSha: h,
        liveContainsLocal: cmd.proof?.liveContainsLocal,
        contentDiffChanged: cmd.proof?.contentDiffChanged,
      });
      if (!proof.holds) {
        if (d.state === 'ESCALATED') return record();
        // Record the head, stay, and re-arm recovery from this head: the push that
        // arrived is not the work, so the next try re-reads and re-asks (§6.4).
        const next: EffectSpec = { ...c.pushRecovery(local, 1), dedupeKey: `push_recovery:${d.id}:${c.pushChain(local)}:head:${h}` };
        return c.apply(key, 'AWAITING_PUSH', { patch: { currentHeadSha: h }, effects: [next], evidence: { ...evidence, proof } });
      }
      const attempts: AttemptOp[] = a ? [{ op: 'update', attemptId: a.id, whenStatus: ['queued', 'running', 'ended'], set: { outcome: 'delivered', pushedHeadSha: h } }] : [];
      return toReview({ attempts });
    }
    case 'REPAIRING': {
      const a = c.attempt(d.boundAttemptId);
      const by = attributeHead(a, h, cmd.attribution);
      if (by === 'attempt' && a) {
        // §6.9 rule 2: the bound attempt's own push. §9 proof: it moved off the bound head and contains its work.
        const known = a.reportedShas.includes(h);
        const proof = deliveryProof({
          boundHeadSha: a.boundHeadSha,
          localHeadSha: known ? h : a.reportedShas.at(-1) ?? null,
          liveHeadSha: h,
          liveContainsLocal: known || cmd.proof?.liveContainsLocal,
          // Descends from the bound head and differs from it: the PR's content moved.
          contentDiffChanged: cmd.proof?.contentDiffChanged ?? true,
        });
        if (!proof.holds) return c.apply(key, 'REPAIRING', { patch: { currentHeadSha: h }, evidence: { ...evidence, proof, attributedTo: a.id } });
        // A mechanical attempt has no worker to end it: the head it pushed is its end.
        const attempts: AttemptOp[] = [{ op: 'update', attemptId: a.id, whenStatus: ['queued', 'running', 'ended'], set: { outcome: 'delivered', pushedHeadSha: h, appendReportedSha: h, ...(a.mode === 'mechanical' ? { status: 'ended' as const, ended: true } : {}) } }];
        if (d.approvalBasis === 'policy') {
          // A repaired head under a no-review policy goes straight back to APPROVED by policy.
          return c.apply(key, 'APPROVED', { patch: { currentHeadSha: h, stateReason: 'policy_no_review', boundAttemptId: null }, attempts, evidence: { ...evidence, proof, policy: 'no_review', attributedTo: a.id } });
        }
        if (headCoverage(d, d.currentHeadSha) !== 'none') {
          // §6.3 T13: a head moved only by the platform's own refresh_branch (the base merged in
          // server-side, expected_head pinned) keeps the approval. A renumber changes content: reviewed.
          // edc02148: a queued refresh is credited with any push that descends from its pinned head
          // (a person's, a live owner's), so attribution alone proves nothing about the diff. A
          // compare that read the diff as changed is reviewed; an unread one keeps the own refresh.
          const ownRefresh = a.mode === 'mechanical' && a.family === 'conflict' && !cmd.diffChanged;
          const cf = carry(ownRefresh ? 'own_refresh' : undefined);
          if (cf && cf.result === 'apply') return { ...cf, patch: { ...cf.patch, boundAttemptId: null }, attempts };
        }
        return toReview({ attempts });
      }
      if (by === 'foreign_running') {
        // §6.9 rule 3: a push the running attempt cannot claim. Recorded; it consumes no ledger row,
        // and the attempt's own end still decides.
        return c.apply(key, 'REPAIRING', { patch: { currentHeadSha: h }, evidence: { ...evidence, foreignPush: true } });
      }
      // The repair never started (or already ended), or it is a mechanical one the head has left
      // behind: the new head makes it moot. The row is skipped, so it spends nothing, and the head
      // is handled as it would have been before the repair.
      const moot = !!a && (a.status === 'queued' || (a.mode === 'mechanical' && a.status === 'running'));
      const attempts: AttemptOp[] = a && moot
        ? [{ op: 'update', attemptId: a.id, whenStatus: [a.status], set: { status: 'skipped', outcome: 'noop', ended: true } }]
        : [];
      const effects: EffectSpec[] = a && moot
        // The task it made moot, named. A mechanical row has no task, so nothing is cancelled (a81a100f);
        // an agent row not yet linked to its task leaves the role-wide cancel.
        ? [{ kind: 'cancel_open_attempts', dedupeKey: `cancel_open_attempts:${d.id}:head:${h}`, payload: { families: [a.family], reason: 'head_moved', ...(a.taskId ? { taskIds: [a.taskId] } : a.mode === 'mechanical' ? { taskIds: [] } : {}) } }]
        : [];
      const ev = { ...evidence, foreignPush: true, repairSkipped: attempts.length > 0 };
      if (d.approvalBasis === 'policy') {
        return c.apply(key, 'APPROVED', { patch: { currentHeadSha: h, stateReason: 'policy_no_review', boundAttemptId: null }, attempts, effects, evidence: ev });
      }
      if (headCoverage(d, d.currentHeadSha) !== 'none') {
        const cf = carry();
        if (cf && cf.result === 'apply') return { ...cf, patch: { ...cf.patch, boundAttemptId: null }, attempts, effects: [...cf.effects, ...effects], evidence: { ...ev, carryForward: cf.evidence.carryForward } };
      }
      return toReview({ attempts, effects, evidence: ev });
    }
    case 'AWAITING_REVIEW':
      return toReview();
    case 'CHANGES_REQUESTED': {
      // The fix tasks this head makes moot, named, so the cancellation never reaches a later one.
      // A row not yet linked to its task (filed, link pending) leaves the role-wide cancel, as before.
      const open = c.view.attempts.filter((x) => x.family === 'review_fix' && OPEN_ATTEMPT.has(x.status));
      const taskIds = open.every((x) => x.taskId) ? open.map((x) => x.taskId!) : undefined;
      return toReview({
        attempts: [{ op: 'cancel_open', families: ['review_fix'], status: 'cancelled' }],
        effects: [{ kind: 'cancel_open_attempts', dedupeKey: `cancel_open_attempts:${d.id}:head:${h}`, payload: { families: ['review_fix'], reason: 'head_moved', ...(taskIds ? { taskIds } : {}) } }],
      });
    }
    case 'FIXING': {
      // Mid-fix pushes are normal; the round advances at AttemptEnded. A push
      // the running attempt can claim is recorded as its provenance (§6.9).
      const a = c.attempt(d.boundAttemptId);
      const by = attributeHead(a, h, cmd.attribution);
      return c.apply(key, 'FIXING', {
        patch: { currentHeadSha: h },
        attempts: a && by === 'attempt' ? [{ op: 'update', attemptId: a.id, whenStatus: ['queued', 'running'], set: { appendReportedSha: h } }] : [],
        evidence: by === 'attempt' ? evidence : { ...evidence, foreignPush: true },
      });
    }
    case 'APPROVED':
      if (d.approvalBasis === 'policy') {
        return c.apply(key, 'APPROVED', { patch: { currentHeadSha: h }, evidence: { ...evidence, policy: 'no_review' } });
      }
      return carry() ?? toReview();
    case 'LANDING':
      if (d.approvalBasis === 'policy') {
        return c.apply(key, 'APPROVED', { patch: { currentHeadSha: h }, evidence: { ...evidence, policy: 'no_review', landingAborted: true } });
      }
      return carry() ?? toReview();
    case 'BLOCKED_ON_TRUNK': {
      // §6.4 BLOCKED_ON_TRUNK row (47be5f6c): stay blocked, T26 decides. A resume of
      // APPROVED survives the new head only on carry-forward evidence; otherwise the
      // resume becomes AWAITING_REVIEW, so recovery reviews the head instead of landing it.
      if (d.approvalBasis === 'policy' || d.resumeState !== 'APPROVED') return record();
      const cf = carry();
      if (cf && cf.result === 'apply') return { ...cf, toState: 'BLOCKED_ON_TRUNK', patch: { ...cf.patch, stateReason: d.stateReason } };
      return c.apply(key, 'BLOCKED_ON_TRUNK', { patch: { currentHeadSha: h, resumeState: 'AWAITING_REVIEW' }, evidence: { ...evidence, approvalNotCarried: true } });
    }
    default:
      // CLOSED_UNMERGED: record the head; T19 re-evaluates.
      return record();
  }
}

// ── AC-1 slice 6: an attempt's task goes back to the queue ──────────────────

/**
 * AttemptRequeued: the attempt the delivery is bound to is retried on the same task (a retry, a
 * loop hold, a budget or credential wall, a stalled repair recovered). The delivery keeps its
 * state; the transition records the requeue (`requeue:<workerId>`, so a re-sent requeue is a
 * duplicate) and its statement moves the task back to `pending` (the host's projection, guarded
 * on the task's current attempt). An owner requeue binds while the delivery is `WORKING` on that
 * owner task; a repair requeue while `FIXING` / `REPAIRING` is bound to that open attempt.
 * Anything else is `attempt_not_bound`: the delivery has nothing to record, and the host's own
 * guarded projection decides whether the task still moves.
 */
function attemptRequeued(c: Ctx, cmd: Extract<Command, { type: 'AttemptRequeued' }>): Decision {
  const d = c.d!;
  const key = `requeue:${cmd.workerId}`;
  const evidence = { requeue: true, reason: cmd.reason, workerId: cmd.workerId, ...(cmd.attemptId ? { attemptId: cmd.attemptId } : { taskId: cmd.taskId }) };
  if (!cmd.taskId && !cmd.attemptId) return c.rejected('attempt_not_named');
  if (cmd.attemptId) {
    const a = c.attempt(cmd.attemptId);
    if ((d.state !== 'FIXING' && d.state !== 'REPAIRING') || !a || a.id !== d.boundAttemptId || !OPEN_ATTEMPT.has(a.status)) return c.stale('attempt_not_bound');
    return c.apply(key, d.state, { evidence });
  }
  if (d.state !== 'WORKING' || cmd.taskId !== d.ownerTaskId) return c.stale('attempt_not_bound');
  return c.apply(key, 'WORKING', { evidence });
}

// ── AC-1 slice 7: a claim starts the owner attempt ──────────────────────────

/**
 * AttemptStarted: a claim of the owner task starts its next attempt. The claim route's
 * compare-and-set decided the race before this command exists, so the kernel never picks a winner:
 * it records the start (`start:<taskId>:<claimedAt>`, so a re-send is a duplicate and the next
 * claim is a new key) and its statement moves the task to `assigned`, guarded on that exact claim.
 * It binds while the delivery is `WORKING` on that owner task (a retry the kernel kept in WORKING).
 * Anything else is `attempt_not_bound`: the delivery has nothing to record, and the host's guarded
 * projection still starts the claim it decided.
 */
function attemptStarted(c: Ctx, cmd: Extract<Command, { type: 'AttemptStarted' }>): Decision {
  const d = c.d!;
  if (!cmd.claimedBy || !cmd.claimedAt) return c.rejected('claim_not_named');
  if (d.state !== 'WORKING' || cmd.taskId !== d.ownerTaskId) return c.stale('attempt_not_bound');
  return c.apply(`start:${cmd.taskId}:${cmd.claimedAt}`, 'WORKING', {
    evidence: { start: true, taskId: cmd.taskId, claimedBy: cmd.claimedBy, claimedAt: cmd.claimedAt },
  });
}

// ── AC-1 slice 9: a settled owner task reopens; a claim withdraws its start ──

/** One reopen per ended attempt: a re-send is a duplicate, the next end of the same worker is a new key. */
const reopenKey = (cmd: Extract<Command, { type: 'AttemptReopened' }>): string =>
  `reopen:${cmd.taskId}:${cmd.workerId ?? 'none'}:${cmd.endedAt ?? 'none'}`;
/** One withdrawal per claim and outcome (a queued task no claim holds is `queued`). */
const withdrawKey = (cmd: Extract<Command, { type: 'AttemptWithdrawn' }>): string =>
  `withdraw:${cmd.taskId}:${cmd.claim?.claimedAt ?? 'queued'}:${cmd.outcome}`;

/**
 * AttemptReopened: the owner task's ended attempt is opened again, for a new attempt (`pending`) or
 * the same worker running again (`assigned`). No end and no state change, as AttemptStarted: while
 * the delivery is `WORKING` on that owner task the transition records it (`reopen:...`) and its
 * statement moves the task, guarded on the named worker still being the task's latest attempt.
 * Anything else (the delivery handed on, or is terminal) is `attempt_not_bound`: the host's guarded
 * projection still decides whether the task moves.
 */
function attemptReopened(c: Ctx, cmd: Extract<Command, { type: 'AttemptReopened' }>): Decision {
  const d = c.d!;
  if (!cmd.taskId || (cmd.to !== 'pending' && cmd.to !== 'assigned') || (cmd.to === 'assigned' && !cmd.workerId)) return c.rejected('reopen_not_named');
  if (d.state !== 'WORKING' || cmd.taskId !== d.ownerTaskId) return c.stale('attempt_not_bound');
  return c.apply(reopenKey(cmd), 'WORKING', {
    evidence: { reopen: true, taskId: cmd.taskId, workerId: cmd.workerId, endedAt: cmd.endedAt, to: cmd.to, reason: cmd.reason },
  });
}

/**
 * AttemptWithdrawn: a claim that does not run the owner attempt gives its start back (`requeued`)
 * or ends the task for good (`failed`); with no claim, a queued task is refused for good. No attempt
 * ran, so it is no end and moves no state: while the delivery is `WORKING` on that owner task the
 * transition records it (`withdraw:...`) and its statement moves the task, guarded on exactly that
 * claim. Anything else is `attempt_not_bound`, and the host's guarded projection decides.
 */
function attemptWithdrawn(c: Ctx, cmd: Extract<Command, { type: 'AttemptWithdrawn' }>): Decision {
  const d = c.d!;
  if (!cmd.taskId || (cmd.outcome !== 'requeued' && cmd.outcome !== 'failed')) return c.rejected('withdrawal_not_named');
  if (cmd.claim ? !cmd.claim.claimedBy || !cmd.claim.claimedAt : cmd.outcome !== 'failed') return c.rejected('claim_not_named');
  if (d.state !== 'WORKING' || cmd.taskId !== d.ownerTaskId) return c.stale('attempt_not_bound');
  return c.apply(withdrawKey(cmd), 'WORKING', {
    evidence: { withdraw: true, taskId: cmd.taskId, claim: cmd.claim, outcome: cmd.outcome, reason: cmd.reason },
  });
}

// ── T4 ──────────────────────────────────────────────────────────────────────

/** T4, then §5: a repair whose delivered head changed an open finding's path marks it `addressed`. */
function attemptEnded(c: Ctx, cmd: Extract<Command, { type: 'AttemptEnded' }>): Decision {
  const fromState = c.d!.state;
  const dec = attemptEndedInner(c, cmd);
  if (dec.result !== 'apply' || (fromState !== 'FIXING' && fromState !== 'REPAIRING') || !cmd.live || dec.toState === 'AWAITING_PUSH') return dec;
  if (dec.patch.currentHeadSha !== cmd.live.headSha) return dec;
  return withAddressed(c, dec, cmd.live.headSha, cmd.changedPaths);
}

/**
 * 295486ba: a CI repair attempt cancelled while still queued, with nothing local: no agent
 * claimed it (a claim moves the row to `running`), so no work was done and nothing is lost.
 * Only a cancel says so; the reaper's `lost` end of a queued row keeps counting.
 */
function cancelledUnstarted(cmd: Extract<Command, { type: 'AttemptEnded' }>, a: AttemptSnapshot): boolean {
  return cmd.cancelled === true && a.family === 'ci' && a.status === 'queued' && cmd.outcome !== 'success'
    && cmd.commitCount === 0 && !cmd.localHeadSha && a.reportedShas.length === 0;
}

function skipUnstarted(a: AttemptSnapshot): AttemptOp {
  return { op: 'update', attemptId: a.id, whenStatus: ['queued'], set: { status: 'skipped', outcome: 'noop', ended: true } };
}

function attemptEndedInner(c: Ctx, cmd: Extract<Command, { type: 'AttemptEnded' }>): Decision {
  const d = c.d!;
  const key = `end:${cmd.workerId}`;
  // An attempt the delivery has moved past (its head was delivered, the PR merged) still ends:
  // its row records the end for audit, the delivery does not move.
  const unbound = (): Decision => {
    const a = c.attempt(cmd.attemptId);
    if (!a || !OPEN_ATTEMPT.has(a.status)) return c.stale('attempt_not_bound');
    if (cancelledUnstarted(cmd, a)) return c.stale('attempt_not_bound', { rounds: [], attempts: [skipUnstarted(a)] });
    return c.stale('attempt_not_bound', { rounds: [], attempts: [{
      op: 'update', attemptId: a.id, whenStatus: ['queued', 'running'],
      set: { status: 'ended', ended: true, ...(a.outcome ? {} : { outcome: cmd.outcome === 'success' ? 'unproven' : 'failed' }), ...(cmd.localHeadSha ? { appendReportedSha: cmd.localHeadSha } : {}) },
    }] });
  };
  if (!['WORKING', 'FIXING', 'REPAIRING'].includes(d.state)) return unbound();
  const L = cmd.localHeadSha;
  const live = cmd.live;
  // 58c8961e: the delta read is recorded with the decision it fed, so a replay rebuilds the same round.
  const evidence = { outcome: cmd.outcome, localHeadSha: L, commitCount: cmd.commitCount, live, ...(cmd.ci ? { liveChecks: cmd.ci.liveChecks } : {}), ...(cmd.delta ? { delta: cmd.delta } : {}) };

  if (d.state === 'WORKING') {
    if (cmd.taskId !== d.ownerTaskId) return c.stale('attempt_not_bound');
    const prOpen = d.prNumber != null && livePrOpen(live);
    // An unknown local head counts as contained only when nothing local exists to lose: a reaped
    // (lost) or failed attempt that reported commits but no SHA is not proof (§9, AC-10, S9).
    const unknownLocalIsSafe = cmd.outcome === 'success' || cmd.commitCount === 0;
    const contains = prOpen && ((!L && unknownLocalIsSafe) || (!!L && live!.headSha === L) || cmd.proof?.liveContainsLocal === true);
    const success = cmd.outcome === 'success';
    // §6.5 row 1 (§15 step 2): the owner attempt ended and its head is on
    // GitHub, so the worker no longer owns the next move — hand it on.
    const handOn = (h: string): Decision => {
      // T28: a finding recorded for exactly this head while the owner worked decides the hand-off.
      if (d.policyEvidence && d.policyEvidence.headSha === h) {
        return policyDecision(c, key, d.policyEvidence, { currentHeadSha: h }, evidence);
      }
      // e9f1674b: a CI failure hint that arrived while the owner worked was refused by T10
      // (state_not_allowed). The hand-off is where the platform takes the move, so a head the
      // live read shows red goes to REPAIRING(ci) through T10's ledger, never to a reviewer.
      // A verdict kept while the owner worked (an adopted round, the only decided round a WORKING
      // delivery can hold) does not skip the repair: a red head is repaired first, and leaving the
      // repair re-enters that verdict (resumeAfterRepair).
      if (cmd.ci && cmd.ci.liveChecks.failing.length > 0 && !c.openAttempt(['ci'])) {
        return ciRepairAtHandOff(c, key, h, cmd.ci, cmd.reviewRequired === false ? { approvalBasis: 'policy' } : {}, evidence);
      }
      if (cmd.reviewRequired === false) {
        // The policy needs no review: approved BY POLICY. No round, no verdict,
        // approved_heads untouched (§8 exact-head binding); T15's rails still gate landing.
        return c.apply(key, 'APPROVED', { patch: { currentHeadSha: h, approvalBasis: 'policy', stateReason: 'policy_no_review' }, evidence: { ...evidence, policy: 'no_review' } });
      }
      if (c.openRoundAt(h)) return c.apply(key, 'AWAITING_REVIEW', { patch: { currentHeadSha: h }, evidence });
      const decided = c.decidedAt(h);
      if (decided) return reenterVerdict(c, key, decided, h, evidence);
      const r = c.startRound(h);
      return c.apply(key, 'AWAITING_REVIEW', { patch: { ...r.patch, currentHeadSha: h }, rounds: r.rounds, effects: r.effects, evidence });
    };
    // §6.6 (S30): a hand-off failure with nothing local is a requeue while the task's own retry
    // is queued — never a review round at a head the retry is about to move.
    if (cmd.outcome === 'unproven' && cmd.commitCount === 0 && cmd.taskRetryBudgetLeft) {
      return c.apply(key, 'WORKING', { evidence: { ...evidence, requeue: true } });
    }
    if ((success || cmd.outcome === 'unproven') && contains) return handOn(live!.headSha);
    if (success || (cmd.outcome === 'unproven' && cmd.commitCount > 0)) {
      // A local commit is never delivery (§9).
      return c.apply(key, 'AWAITING_PUSH', { effects: [c.pushRecovery(L)], evidence });
    }
    // The only WORKING outcome of an ended owner attempt: a requeue the task still has budget for.
    if (cmd.taskRetryBudgetLeft) return c.apply(key, 'WORKING', { evidence: { ...evidence, requeue: true } });
    if (d.prNumber == null) return c.apply(key, 'FAILED', { patch: { stateReason: `attempt_${cmd.outcome}` }, evidence });
    if (cmd.commitCount > 0 && !contains) {
      // Local commits that are not on GitHub: push recovery first, a person after its tries (T22).
      return c.apply(key, 'AWAITING_PUSH', { effects: [c.pushRecovery(L)], evidence });
    }
    if (livePrOpen(live)) return handOn(live!.headSha);
    // Budget spent, PR bound, but no open PR head to hand on (closed, merged, or
    // unreadable): a person owns it. A later PrMerged/PrClosedUnmerged fact still
    // applies from ESCALATED.
    return c.apply(key, 'ESCALATED', { patch: { stateReason: 'push_undeliverable' }, evidence: { ...evidence, note: 'no_open_pr_head' } });
  }

  // FIXING / REPAIRING: the bound repair attempt.
  const a = c.attempt(cmd.attemptId);
  if (!a || a.id !== d.boundAttemptId) return unbound();
  const end = (outcome: 'delivered' | 'unproven' | 'failed' | 'noop', pushed?: string | null): AttemptOp => ({
    op: 'update', attemptId: a.id, whenStatus: ['queued', 'running'],
    set: { status: 'ended', outcome, ended: true, ...(pushed ? { pushedHeadSha: pushed } : {}), ...(L ? { appendReportedSha: L } : {}) },
  });

  // 295486ba: a CI repair whose task was cancelled before anyone claimed it did no work. It is
  // skipped (spends nothing, §5.7 rule 1's dispatch never ran) and the repair ends without filing
  // the next one: the cancel was someone deciding this fix should not run (on #5021 the PR's own
  // builder was fixing CI). The red reading stays; "Fix CI" or a new red head starts one again.
  if (d.state === 'REPAIRING' && cancelledUnstarted(cmd, a)) {
    return resumeAfterRepair(c, key, d.currentHeadSha ?? a.boundHeadSha ?? '', {
      attempts: [skipUnstarted(a)], patch: {},
      evidence: { ...evidence, attemptId: a.id, family: a.family, skipped: 'cancelled_before_start' },
    });
  }

  // §13.13 rule 4, verified no-op: a review fix that read the findings' condition as already absent
  // at the bound head and pushed nothing. The claim is evidence, never a resolution: the attempt ends
  // "no change" (it spends the budget) and a round at the same head verifies the named findings.
  const noop = cmd.noopEvidence;
  if (d.state === 'FIXING' && cmd.outcome === 'success' && noop && noop.evidence.trim() && livePrOpen(live) && live!.headSha === a.boundHeadSha) {
    const open = (c.view.findings ?? []).filter((f) => (f.status === 'open' || f.status === 'addressed') && noop.findingIds.includes(f.id));
    if (open.length > 0) {
      const round = c.currentRound();
      return verificationRound(c, key, round ?? { id: 'none', headSha: live!.headSha, kind: 'full' }, open, {
        patch: { boundAttemptId: null },
        attempts: [end('noop')],
        evidence: { ...evidence, noopEvidence: { findingIds: open.map((f) => f.id), evidence: noop.evidence.slice(0, 2000) } },
      });
    }
  }

  if (cmd.outcome === 'success' || (cmd.outcome === 'unproven' && cmd.commitCount > 0)) {
    // abe42d1b: an agent that pushed from its own session leaves the runner nothing local to
    // report, but its push was attributed to it mid-attempt (§6.9). That push is its L, as the
    // AWAITING_PUSH head path and the floor already read it. Only when nothing local can be lost
    // (the WORKING rule, §9 AC-10): an unproven end with unreported commits is still not proof.
    const unknownLocalIsSafe = cmd.outcome === 'success' || cmd.commitCount === 0;
    const proofLocal = L ?? (unknownLocalIsSafe ? a.reportedShas.at(-1) ?? null : null);
    const proof = deliveryProof({
      boundHeadSha: a.boundHeadSha,
      localHeadSha: proofLocal,
      liveHeadSha: livePrOpen(live) ? live!.headSha : null,
      liveContainsLocal: cmd.proof?.liveContainsLocal,
      contentDiffChanged: cmd.proof?.contentDiffChanged,
    });
    if (!proof.holds) {
      // #3754: FIXING → AWAITING_REVIEW is not reachable without §9 proof.
      return c.apply(key, 'AWAITING_PUSH', { attempts: [end('unproven')], effects: [c.pushRecovery(L)], evidence: { ...evidence, proof } });
    }
    const h = live!.headSha;
    if (d.state === 'REPAIRING' && d.approvalBasis === 'policy') {
      return c.apply(key, 'APPROVED', {
        patch: { currentHeadSha: h, boundAttemptId: null, stateReason: 'policy_no_review' },
        attempts: [end('delivered', h)], evidence: { ...evidence, proof, policy: 'no_review' },
      });
    }
    if (d.state === 'REPAIRING' && cmd.carryForward && headCoverage(d, a.boundHeadSha) !== 'none') {
      const p: DeliveryPatch = d.approvalBasis === 'composition'
        ? { compositionHeads: [...d.compositionHeads, h] }
        : { approvedHeads: [...d.approvedHeads, h] };
      return c.apply(key, 'APPROVED', {
        patch: { ...p, currentHeadSha: h, boundAttemptId: null, stateReason: null },
        attempts: [end('delivered', h)], evidence: { ...evidence, proof, carryForward: cmd.carryForward },
      });
    }
    const r = c.startRound(h, { trigger: attemptTrigger(a), delta: cmd.delta });
    return c.apply(key, 'AWAITING_REVIEW', {
      patch: { ...r.patch, currentHeadSha: h, boundAttemptId: null, stateReason: null },
      rounds: r.rounds, attempts: [end('delivered', h)], effects: r.effects, evidence: { ...evidence, proof },
    });
  }

  // failed / lost / unproven-with-nothing: back to the owing state, or exhaust.
  const exhausted = a.attemptNo >= a.maxAttempts;
  if (d.state === 'FIXING') {
    const round = c.currentRound();
    const roundHead = round?.headSha ?? a.boundHeadSha;
    if (d.currentHeadSha && d.currentHeadSha !== roundHead) {
      // §6.4: the head moved while the fix ran (a mid-fix push, recorded in FIXING). The round
      // advances now: r+1 at the current head, delta from the last decided one. Re-dispatching the
      // stale round's fix would be refused by T8 (newer_verdict_supersedes_fix) and strand the PR.
      const h = d.currentHeadSha;
      const ev = { ...evidence, headMovedDuringFix: { from: roundHead, to: h } };
      if (c.openRoundAt(h)) return c.apply(key, 'AWAITING_REVIEW', { patch: { boundAttemptId: null, stateReason: null }, attempts: [end('failed')], evidence: ev });
      const decided = c.decidedAt(h);
      if (decided) {
        const re = reenterVerdict(c, key, decided, h, ev);
        return re.result === 'apply' ? { ...re, patch: { ...re.patch, boundAttemptId: null }, attempts: [end('failed')] } : re;
      }
      const r = c.startRound(h, { trigger: attemptTrigger(a), delta: cmd.delta });
      return c.apply(key, 'AWAITING_REVIEW', {
        patch: { ...r.patch, boundAttemptId: null, stateReason: null },
        rounds: r.rounds, attempts: [end('failed')], effects: r.effects, evidence: ev,
      });
    }
    // AC-19: a fix that ends with the PR head where it was bound changed nothing; it is shown as
    // "no change" and still spends its attempt.
    // Only a live read of the unmoved head is evidence: an unread one (a crash, GitHub down) is a failure.
    const ended: 'failed' | 'noop' = d.currentHeadSha === a.boundHeadSha && !!live && live.headSha === a.boundHeadSha ? 'noop' : 'failed';
    if (exhausted) {
      return c.apply(key, 'ESCALATED', {
        patch: { stateReason: 'review_exhausted', boundAttemptId: null }, attempts: [end(ended)],
        effects: [{ kind: 'escalate_exhaustion', dedupeKey: `exhaust:${d.id}:review_fix:${a.attemptNo}`, payload: { family: 'review_fix', attempts: a.attemptNo } }],
        evidence,
      });
    }
    return c.apply(key, 'CHANGES_REQUESTED', {
      patch: { boundAttemptId: null }, attempts: [end(ended)],
      evidence: { ...evidence, ...(ended === 'noop' ? { noChange: true } : {}) },
      effects: [{
        kind: 'dispatch_fix', dedupeKey: `dispatch_fix:${d.id}:${round?.id ?? 'none'}:${a.attemptNo + 1}`,
        payload: { roundId: round?.id ?? null, round: d.currentRound, headSha: a.boundHeadSha, attemptNo: a.attemptNo + 1 },
      }],
    });
  }
  // REPAIRING: the family's ledger decides, counting every dispatched row (§5.7 rule 1).
  const { spent, max } = c.budget(a.family, a.maxAttempts, a.mode);
  if (spent >= max) {
    const reason = a.family === 'ci' ? 'ci_exhausted' : 'conflict_exhausted';
    return c.apply(key, 'ESCALATED', {
      patch: { stateReason: reason, boundAttemptId: null }, attempts: [end('failed')],
      effects: [{ kind: 'escalate_exhaustion', dedupeKey: `exhaust:${d.id}:${a.family}:${a.mode}:${a.attemptNo}`, payload: { family: a.family, attempts: a.attemptNo } }],
      evidence,
    });
  }
  const id = c.newId();
  const n = c.nextNo(a.family, a.mode);
  const kind: EffectSpec['kind'] = a.family === 'ci' ? 'dispatch_ci_fix' : a.mode === 'mechanical' ? (a.family === 'migration' ? 'renumber_migration' : 'refresh_branch') : 'dispatch_conflict_fix';
  return c.apply(key, 'REPAIRING', {
    patch: { boundAttemptId: id },
    attempts: [end('failed'), { op: 'insert', id, family: a.family, attemptNo: n, mode: a.mode, boundHeadSha: a.boundHeadSha, triggerReason: a.triggerReason, taskId: null, trigger: 'automatic', status: 'queued', maxAttempts: max }],
    effects: [{ kind, dedupeKey: `${kind}:${d.id}:${a.boundHeadSha}:${a.mode}:${n}`, payload: { attemptId: id, attemptNo: n, maxAttempts: max, headSha: a.boundHeadSha, signature: a.triggerReason } }],
    evidence,
  });
}

/**
 * §6.5 row 1 with a red head (e9f1674b): T10's outcome, taken by the owner's hand-off.
 * The same ledger row, dispatch key and exhaustion as T10, under the hand-off's own key.
 * No round is started: resuming from the repair starts one (resumeAfterRepair, T11).
 */
function ciRepairAtHandOff(
  c: Ctx, key: string, h: string, ci: NonNullable<Extract<Command, { type: 'AttemptEnded' }>['ci']>,
  patch: DeliveryPatch, evidence: Record<string, unknown>,
): Decision {
  const d = c.d!;
  const ciPatch: DeliveryPatch = { ...patch, currentHeadSha: h, ci: 'red', ciHeadSha: h };
  const ev = { ...evidence, signature: ci.signature };
  const { spent, max } = c.budget('ci', ci.maxAttempts);
  if (spent >= max) {
    return c.apply(key, 'ESCALATED', {
      patch: { ...ciPatch, stateReason: 'ci_exhausted', boundAttemptId: null },
      effects: [{ kind: 'escalate_exhaustion', dedupeKey: `exhaust:${d.id}:ci:${h}@v${d.version}`, payload: { family: 'ci', attempts: spent, max, headSha: h, signature: ci.signature } }],
      evidence: { ...ev, spent, max },
    });
  }
  const n = c.nextNo('ci', 'agent');
  const id = c.newId();
  return c.apply(key, 'REPAIRING', {
    patch: { ...ciPatch, stateReason: 'ci', boundAttemptId: id },
    attempts: [{ op: 'insert', id, family: 'ci', attemptNo: n, mode: 'agent', boundHeadSha: h, triggerReason: ci.signature, triggerFactId: null, taskId: null, trigger: 'automatic', status: 'queued', maxAttempts: max }],
    effects: [{ kind: 'dispatch_ci_fix', dedupeKey: `dispatch_ci_fix:${d.id}:${h}:${n}`, payload: { attemptId: id, attemptNo: n, maxAttempts: max, headSha: h, signature: ci.signature, trigger: 'automatic' } }],
    evidence: { ...ev, attemptNo: n, spent: spent + 1, max },
  });
}

const QUIESCENT_FOR_POLICY = new Set<DeliveryState>(['AWAITING_REVIEW', 'APPROVED']);
const POLICY_MAX_SPLIT_ATTEMPTS = 2;

/**
 * T28 acting on a finding for the current head, from a state that owes nobody's work.
 *  - `human`: ESCALATED(policy_human). Open review rounds are superseded: a reviewer would be
 *    judging a head a person has to decide on first.
 *  - `agent_split`: a safe EXPAND-then-CONTRACT split is agent work, not a human decision. One
 *    `migration` repair row (agent mode) bound to the head, through the same ledger and
 *    dispatch_conflict_fix as every other repair, so it spends the family's budget and can never
 *    race a second branch writer (the caller already found no open repair).
 */
function policyDecision(c: Ctx, key: string, ev: PolicyEvidence, patch: DeliveryPatch, extra: Record<string, unknown> = {}): Decision {
  const d = c.d!;
  const rounds: RoundOp[] = c.openRounds().map((r) => ({ op: 'update', roundId: r.id, whenStatus: ['queued', 'reviewing'], set: { status: 'superseded' } }));
  const evidence = { ...extra, policyEvidence: ev, reason: ev.reason };
  if (ev.outcome === 'agent_split') {
    const n = c.nextNo('migration', 'agent');
    if (n <= POLICY_MAX_SPLIT_ATTEMPTS) {
      const id = c.newId();
      return c.apply(key, 'REPAIRING', {
        guardHead: true,
        patch: { ...patch, policyEvidence: ev, stateReason: 'migration', boundAttemptId: id },
        rounds,
        attempts: [{ op: 'insert', id, family: 'migration', attemptNo: n, mode: 'agent', boundHeadSha: ev.headSha, triggerReason: 'migration_split', taskId: null, trigger: 'automatic', status: 'queued', maxAttempts: POLICY_MAX_SPLIT_ATTEMPTS }],
        effects: [{ kind: 'dispatch_conflict_fix', dedupeKey: `dispatch_conflict_fix:${d.id}:${ev.headSha}:split${n}`, payload: { attemptId: id, attemptNo: n, maxAttempts: POLICY_MAX_SPLIT_ATTEMPTS, headSha: ev.headSha, repairKind: 'migration_split', detail: { reason: ev.reason } } }],
        evidence,
      });
    }
    // The agent could not split it: now it is a person's decision.
  }
  return c.apply(key, 'ESCALATED', {
    guardHead: true,
    patch: { ...patch, policyEvidence: ev, stateReason: 'policy_human', boundAttemptId: null },
    rounds,
    effects: [{ kind: 'notify', dedupeKey: `notify:${d.id}:policy_human:${ev.headSha}`, payload: { event: 'policy_human', reason: ev.reason, headSha: ev.headSha, destructive: ev.destructive } }],
    evidence,
  });
}

/** Re-enter the state a decided round's verdict maps to at head `h`, exactly as T6 would. */
function reenterVerdict(c: Ctx, key: string, round: RoundSnapshot, h: string, evidence: Record<string, unknown>): Decision {
  const d = c.d!;
  const ev = { ...evidence, note: 'head_already_reviewed', roundId: round.id, verdict: round.effectiveVerdict };
  const base: DeliveryPatch = { currentHeadSha: h, currentRound: Math.max(d.currentRound, round.round) };
  // §5: an approval never stands over a required finding it did not verify (one raised or restated
  // since, or one it left open). The head is owed the verification round instead.
  const open = openRequiredFindings(c.view);
  if (round.effectiveVerdict === 'approve' && open.length > 0) {
    return verificationRound(c, key, round, open, { patch: { currentHeadSha: h }, evidence: ev });
  }
  if (round.effectiveVerdict === 'approve' && round.scope?.composition === true) {
    // A composition delta approve never becomes a whole-head verdict (§5.9, S33).
    const heads = d.compositionHeads.includes(h) ? d.compositionHeads : [...d.compositionHeads, h];
    return c.apply(key, 'APPROVED', { patch: { ...base, compositionHeads: heads, approvalBasis: 'composition', stateReason: null }, evidence: ev });
  }
  if (round.effectiveVerdict === 'approve') {
    const heads = d.approvedHeads.includes(h) ? d.approvedHeads : [...d.approvedHeads, h];
    return c.apply(key, 'APPROVED', { patch: { ...base, approvedHeads: heads, approvalBasis: 'verdict', stateReason: null }, evidence: ev });
  }
  if (round.effectiveVerdict === 'request_changes') {
    // Review of #5017: a held budget is final whichever round the head re-enters, and a re-check's
    // free cycle is owed once, at its verdict, never again on a re-entry after it was used.
    if (reviewBudgetHeld(d) || budgetSpentAt(c.view, round, d.maxRounds) || (isRecheckAfterApproval(round) && recheckCycleUsed(c.view, round))) {
      return c.apply(key, 'ESCALATED', {
        patch: { ...base, stateReason: 'review_exhausted' }, evidence: ev,
        effects: [{ kind: 'escalate_exhaustion', dedupeKey: `exhaust:${d.id}:${h}@v${d.version}`, payload: { family: 'review_fix', rounds: round.round } }],
      });
    }
    const fixOpen = c.view.attempts.some((a) => a.family === 'review_fix' && a.triggerReason === round.id && OPEN_ATTEMPT.has(a.status));
    const n = c.nextNo('review_fix', 'agent');
    return c.apply(key, 'CHANGES_REQUESTED', {
      patch: { ...base, stateReason: null }, evidence: ev,
      effects: fixOpen ? [] : [{ kind: 'dispatch_fix', dedupeKey: `dispatch_fix:${d.id}:${round.id}:${n}`, payload: { roundId: round.id, round: round.round, headSha: h, attemptNo: n } }],
    });
  }
  return c.apply(key, 'ESCALATED', { patch: { ...base, stateReason: 'review_escalated' }, evidence: ev });
}

// ── T12 / T16 shared: mechanical first, agent on refusal (§6.7) ─────────────

/**
 * S15 cycles over the conflict family's mechanical ledger: `cycle` is 1 plus
 * the number of `treadmill_cycle` markers, and `refreshes` counts the behind
 * refreshes dispatched since the newest marker (a skipped row did no work).
 */
export function treadmillCycle(mechanical: AttemptSnapshot[]): { cycle: number; refreshes: number } {
  const markers = mechanical.filter((a) => a.triggerReason === TREADMILL_CYCLE_MARKER);
  const since = markers.reduce((m, a) => Math.max(m, a.attemptNo), 0);
  const refreshes = mechanical.filter((a) => a.triggerReason === 'behind' && a.status !== 'skipped' && a.attemptNo > since).length;
  return { cycle: markers.length + 1, refreshes };
}

/**
 * S15's disjoint-delta rule over one delivery (base-delta.ts): may `head` land
 * although its base moved? Only an approved head (any coverage: an exact-head
 * verdict, a person, a composition, or a platform own_refresh carry). Before
 * the cycle's refresh budget is spent, only a head the platform's own refresh
 * produced, within the ordinary bound; once it is spent, any covered head,
 * within the wider `TREADMILL_EXHAUSTED_MAX_BASE_COMMITS`. Either way only a
 * listable, disjoint, risk-free base delta, and never on a base that requires
 * an up-to-date branch.
 */
export function behindTolerance(
  d: Pick<DeliverySnapshot, 'approvedHeads' | 'approvalBasis' | 'compositionHeads' | 'currentHeadSha'>,
  mechanical: AttemptSnapshot[],
  head: string,
  fact: BaseDeltaFact,
  ordinaryMax: number = DEFAULT_TREADMILL_MAX_BASE_COMMITS,
  maxRefreshes: number = DEFAULT_MAX_BEHIND_REFRESHES,
): BaseDeltaVerdict & { rule?: 'bounded' | 'spent_cycle' } {
  if (headCoverage(d, head) === 'none') return { tolerated: false, cause: 'refresh_exhausted', reason: 'no approval covers this head' };
  const spent = treadmillCycle(mechanical).refreshes >= maxRefreshes;
  const refreshed = mechanical.some((a) => a.family === 'conflict' && a.mode === 'mechanical' && a.reportedShas.includes(head));
  if (!spent && !refreshed) return { tolerated: false, cause: 'refresh_exhausted', reason: 'this head was not produced by a platform refresh' };
  const v = judgeBaseDelta(fact, spent ? Math.max(TREADMILL_EXHAUSTED_MAX_BASE_COMMITS, ordinaryMax) : ordinaryMax);
  return v.tolerated ? { ...v, rule: spent ? 'spent_cycle' : 'bounded' } : v;
}

/** At most this many files are named in a refresh's freshness evidence. */
const FRESHNESS_FILES_CAP = 20;

/** The S15 verdict a behind refresh went ahead on, as transition evidence. */
export function freshnessEvidence(
  tolerance: ReturnType<typeof behindTolerance> | null,
  fact: BaseDeltaFact | null,
  state: string,
): Record<string, unknown> {
  if (!tolerance || !fact) return { tolerated: false, cause: 'unread' };
  const size = {
    ...(fact.baseCommits != null ? { behindBy: fact.baseCommits } : {}),
    ...(fact.baseFiles ? { baseFileCount: fact.baseFiles.length } : {}),
  };
  // Tolerated, but only an APPROVED delivery skips the refresh (T12 from REPAIRING, LANDING...).
  if (tolerance.tolerated) return { tolerated: true, rule: tolerance.rule ?? null, state, ...size };
  return {
    tolerated: false, cause: tolerance.cause, reason: tolerance.reason, ...size,
    ...(tolerance.files ? { files: tolerance.files.slice(0, FRESHNESS_FILES_CAP) } : {}),
  };
}

function conflictRepair(c: Ctx, head: string, kind: 'conflict' | 'behind' | 'migration', o: {
  key: string; mechanicalRefused: boolean; maxMechanical: number; maxAgent: number; patch: DeliveryPatch; maxBehindRefreshes?: number;
  refusal?: Record<string, unknown> | null;
  detail?: Record<string, unknown> | null;
  /** Behind only: the live base delta (S15 disjoint-delta rule). */
  baseDelta?: BaseDeltaFact | null;
  maxBaseCommits?: number;
}): Decision {
  const d = c.d!;
  const family: AttemptFamily = kind === 'migration' ? 'migration' : 'conflict';
  const attempts: AttemptOp[] = [];
  const mechAtHead = c.ledger(family, 'mechanical').filter((a) => a.boundHeadSha === head);
  const openMech = mechAtHead.find((a) => OPEN_ATTEMPT.has(a.status));
  if (!o.mechanicalRefused && openMech) return c.rejected('fix_in_flight');
  if (o.mechanicalRefused && openMech) {
    attempts.push({ op: 'update', attemptId: openMech.id, whenStatus: ['queued', 'running'], set: { status: 'ended', outcome: 'failed', ended: true } });
  }
  const evidence = { repairKind: kind, headSha: head };
  // Why a behind refresh happened: the verdict the rule gave (or that no base delta was read),
  // so a refresh is explainable from the log rather than rebuilt from git. On the refresh only:
  // the treadmill escalation states its own cause.
  let freshness: Record<string, unknown> | null = null;
  if (kind === 'behind' && !o.mechanicalRefused) {
    const mechanical = c.ledger(family, 'mechanical');
    const maxRefreshes = o.maxBehindRefreshes ?? DEFAULT_MAX_BEHIND_REFRESHES;
    // S15 disjoint-delta rule: an approved head whose base gained only small, disjoint,
    // risk-free changes is not refreshed again (and never escalated for a moving base). Nothing
    // is recorded here: the door lands it through T15, which checks the same rule at merge time.
    const tolerance = o.baseDelta ? behindTolerance(d, mechanical, head, o.baseDelta, o.maxBaseCommits, maxRefreshes) : null;
    freshness = freshnessEvidence(tolerance, o.baseDelta ?? null, d.state);
    if (tolerance?.tolerated && d.state === 'APPROVED') return c.rejected('behind_tolerated');
    // S15 treadmill: a base that keeps moving is refreshed a bounded number of times across
    // heads per cycle; a spent cycle escalates, and the landing sweep opens a new one after
    // the cooldown (TreadmillCycleRestarted) until MAX_TREADMILL_CYCLES are used.
    const { refreshes, cycle } = treadmillCycle(mechanical);
    if (refreshes >= maxRefreshes) {
      const finalCycle = cycle >= MAX_TREADMILL_CYCLES;
      // With the base delta read, the escalation says which: the base keeps changing what this
      // PR changes (refresh_unsafe, naming the files), or it only kept moving (refresh_exhausted).
      const why = tolerance && !tolerance.tolerated ? tolerance : null;
      const because = why ? (why.cause === 'refresh_unsafe' ? `; ${why.reason}, so a green on an older base is not proof` : `; ${why.reason}`) : '';
      const detail = finalCycle
        ? `base moved ${refreshes} times under the approved PR, in each of ${cycle} refresh cycles${because}; a person has to merge it (merge anyway past freshness, or wait for a quiet base)`
        : `base moved ${refreshes} times under the approved PR (refresh cycle ${cycle} of ${MAX_TREADMILL_CYCLES})${because}; landing retries with a fresh refresh budget after the cooldown`;
      return c.apply(o.key + ':treadmill', 'ESCALATED', {
        guardHead: true, patch: { ...o.patch, stateReason: 'landing_needs_human', boundAttemptId: null }, attempts,
        // a90fc99b: a cycle the landing sweep restarts after the cooldown is Buildd's wait, not a
        // page. Only the last cycle, which nothing restarts, tells a person.
        effects: finalCycle ? [{ kind: 'notify', dedupeKey: `notify:${d.id}:treadmill:${head}`, payload: { event: 'landing_needs_human', detail, ...(why ? { cause: why.cause } : {}) } }] : [],
        evidence: {
          ...evidence, refreshes, treadmill: true, cycle, ...(finalCycle ? { finalCycle: true } : {}),
          ...(why ? { cause: why.cause, reason: detail, deltaReason: why.reason, ...(why.files ? { files: why.files } : {}), ...(o.baseDelta?.baseCommits != null ? { behindBy: o.baseDelta.baseCommits } : {}) } : {}),
        },
      });
    }
  }
  if (!o.mechanicalRefused && mechAtHead.length < o.maxMechanical) {
    const id = c.newId();
    const n = c.nextNo(family, 'mechanical');
    const effectKind: EffectSpec['kind'] = kind === 'migration' ? 'renumber_migration' : 'refresh_branch';
    attempts.push({ op: 'insert', id, family, attemptNo: n, mode: 'mechanical', boundHeadSha: head, triggerReason: kind, taskId: null, trigger: 'automatic', status: 'queued', maxAttempts: o.maxMechanical });
    return c.apply(o.key + `:m${n}`, 'REPAIRING', {
      guardHead: true,
      patch: { ...o.patch, stateReason: kind, boundAttemptId: id },
      attempts,
      effects: [{ kind: effectKind, dedupeKey: `${effectKind}:${d.id}:${head}:mechanical:${n}`, payload: { attemptId: id, attemptNo: n, headSha: head, expectedHead: head, repairKind: kind, maxAgent: o.maxAgent, detail: o.detail ?? null } }],
      evidence: { ...evidence, mode: 'mechanical', ...(freshness ? { freshness } : {}) },
    });
  }
  if (c.ledger(family, 'agent').some((a) => OPEN_ATTEMPT.has(a.status))) return c.rejected('fix_in_flight');
  const n = c.nextNo(family, 'agent');
  if (n > o.maxAgent) {
    return c.apply(o.key + ':exhausted', 'ESCALATED', {
      guardHead: true, patch: { ...o.patch, stateReason: 'conflict_exhausted', boundAttemptId: null }, attempts,
      effects: [{ kind: 'escalate_exhaustion', dedupeKey: `exhaust:${d.id}:${family}:${head}@v${d.version}`, payload: { family, attempts: n - 1 } }],
      evidence,
    });
  }
  const id = c.newId();
  attempts.push({ op: 'insert', id, family, attemptNo: n, mode: 'agent', boundHeadSha: head, triggerReason: kind, taskId: null, trigger: 'automatic', status: 'queued', maxAttempts: o.maxAgent });
  return c.apply(o.key + `:a${n}`, 'REPAIRING', {
    guardHead: true,
    patch: { ...o.patch, stateReason: kind, boundAttemptId: id },
    attempts,
    effects: [{ kind: 'dispatch_conflict_fix', dedupeKey: `dispatch_conflict_fix:${d.id}:${head}:${n}`, payload: { attemptId: id, attemptNo: n, maxAttempts: o.maxAgent, headSha: head, repairKind: kind, refusal: o.refusal ?? null, detail: o.detail ?? null } }],
    evidence: { ...evidence, mode: 'agent' },
  });
}

// ── §6.9 provenance ─────────────────────────────────────────────────────────

/**
 * Whose push is `h`? By SHA set and timing, never by author string (§6.9):
 *  - `attempt`: `h` is one of the bound attempt's reported SHAs, or the attempt
 *    is running (a platform mechanical effect counts from dispatch) and `h`
 *    descends from its bound head per the compare API. Unknown ancestry while
 *    running is attributed on timing alone; a known non-descendant is not.
 *  - `foreign_running`: an attempt is running but cannot claim `h` (a person,
 *    a bot, another session force-pushed): recorded, consumes nothing.
 *  - `none`: no running attempt to attribute it to.
 */
export function attributeHead(a: AttemptSnapshot | undefined, h: string, attribution?: { descendsFromBound: boolean }): 'attempt' | 'foreign_running' | 'none' {
  if (!a) return 'none';
  if (a.reportedShas.includes(h)) return 'attempt';
  const live = a.status === 'running' || (a.mode === 'mechanical' && a.status === 'queued');
  if (!live) return 'none';
  if (attribution?.descendsFromBound !== false) return 'attempt';
  // A mechanical write is pinned to its bound head and has no worker to end it: a head that left
  // that line means the write can never land, so nothing is left to wait on (75c04d5d).
  return a.mode === 'mechanical' ? 'none' : 'foreign_running';
}

// ── Repair family claim and resume (§10.5) ──────────────────────────────────

/** T9's CI-family equivalent: claim-time revalidation of a queued repair attempt. */
function repairClaimed(c: Ctx, cmd: Extract<Command, { type: 'FixClaimed' }>, a: AttemptSnapshot): Decision {
  const d = c.d!;
  if (d.state === 'REPAIRING' && d.boundAttemptId === a.id && a.status === 'running') return c.duplicate('already_claimed');
  if (a.status !== 'queued') return c.rejected('attempt_not_queued');
  const skip: AttemptOp = { op: 'update', attemptId: a.id, whenStatus: ['queued'], set: { status: 'skipped', outcome: 'noop', ended: true } };
  const recordSkip = (reason: string): Decision => c.rejected(reason, { record: { rounds: [], attempts: [skip] } });
  if (d.state !== 'REPAIRING' || d.boundAttemptId !== a.id) return recordSkip('fix_superseded');
  const live = cmd.revalidation.live;
  // A closed/merged PR or a moved head is answered by its own fact (T17/T18, T3); the attempt only skips.
  if (!livePrOpen(live) || live.headSha !== a.boundHeadSha) return recordSkip('fix_not_needed');
  if (a.family !== 'ci' && cmd.revalidation.conflictResolved && d.currentHeadSha) {
    return resumeAfterRepair(c, `claim:${a.id}`, d.currentHeadSha, {
      attempts: [skip], patch: { mergeable: 'clean', mergeableHeadSha: d.currentHeadSha },
      evidence: { attemptId: a.id, family: a.family, skipped: 'conflict_resolved', live },
    });
  }
  if (cmd.revalidation.ciGreen && d.currentHeadSha) {
    return resumeAfterRepair(c, `claim:${a.id}`, d.currentHeadSha, {
      attempts: [skip], patch: { ci: 'green', ciHeadSha: d.currentHeadSha },
      evidence: { attemptId: a.id, family: a.family, skipped: 'ci_green', live },
    });
  }
  return c.apply(`claim:${a.id}`, 'REPAIRING', {
    guardHead: true,
    attempts: [{ op: 'update', attemptId: a.id, whenStatus: ['queued'], set: { status: 'running' } }],
    evidence: { attemptId: a.id, family: a.family, live },
  });
}

/**
 * Leave REPAIRING without a push because the repair turned out to be
 * unnecessary: back to what the head was owed before (approval, an open or
 * decided round, or a fresh round).
 */
function resumeAfterRepair(c: Ctx, key: string, h: string, o: { attempts: AttemptOp[]; patch: DeliveryPatch; evidence: Record<string, unknown> }): Decision {
  const d = c.d!;
  const base: DeliveryPatch = { ...o.patch, boundAttemptId: null, stateReason: null };
  if (d.approvalBasis === 'policy') return c.apply(key, 'APPROVED', { guardHead: true, patch: { ...base, stateReason: 'policy_no_review' }, attempts: o.attempts, evidence: o.evidence });
  if (headCoverage(d, h) !== 'none') return c.apply(key, 'APPROVED', { guardHead: true, patch: base, attempts: o.attempts, evidence: o.evidence });
  if (c.openRoundAt(h)) return c.apply(key, 'AWAITING_REVIEW', { guardHead: true, patch: base, attempts: o.attempts, evidence: o.evidence });
  const decided = c.decidedAt(h);
  if (decided) {
    const r = reenterVerdict(c, key, decided, h, o.evidence);
    return r.result === 'apply' ? { ...r, patch: { ...base, ...r.patch }, attempts: [...o.attempts, ...r.attempts] } : r;
  }
  const r = c.startRound(h);
  return c.apply(key, 'AWAITING_REVIEW', { guardHead: true, patch: { ...base, ...r.patch }, rounds: r.rounds, attempts: o.attempts, effects: r.effects, evidence: o.evidence });
}
