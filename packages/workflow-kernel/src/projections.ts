/**
 * DeliveryView: the one read model of a kernel-owned delivery
 * (docs/specs/workflow-state-kernel.md §4, §12, §17.5).
 *
 * Pure. Every surface that shows where a kernel-owned PR stands (Home's Needs
 * You, the task page, mission views, the PR activity comment's headline)
 * reads this instead of inferring from raw worker/reviewer/task columns. A
 * legacy-owned delivery never reaches here: its surfaces keep today's
 * projections (§14 cutover).
 *
 * Three rules this module exists to hold:
 *  1. **One owner of the next move** per non-terminal state (§4). `needsYou`
 *     is true only when that owner is a person, never because a worker ended
 *     or sits in `waiting_input`.
 *  2. **A recoverable blocker stays platform-owned**, with the evidence that
 *     explains it carried in `detail` (never generic copy).
 *  3. **Replacement chains read current** (S35): a failed or superseded
 *     attempt stays in `history`, but the delivery's stage comes from its
 *     canonical state and its current attempt, never from the worst attempt.
 */
import type { PrDisplayState, PrSupersededBy } from './pr-display';
import { findingLine, findingTotals, openRequiredFindings, shortFindingId, type FindingTotals } from './findings';
import { deriveEscalationBrief, type EscalationBrief, type EscalationBriefPermissions } from './escalation-brief';
import { landingStatusOf } from './landing-gate';
import { ROUND_TRIGGER_COPY } from './delta-approval';
import { attemptOrdinal, attemptView, spentReviewRounds } from './reducer';
import type { AttemptFamily, AttemptSnapshot, CloseActor, DeliverySnapshot, DeliveryState, FindingSnapshot, KernelView, RemedyClass, RoundSnapshot } from './types';

export type { DeliverySnapshot } from './types';

const short8 = (id: string) => id.slice(0, 8);

/**
 * Why a PR closed without merging and who closed it, from the cause the delivery holds and the
 * `closedBy` its PrClosedUnmerged transition recorded. The header and the timeline row both print it.
 */
export function closeCauseCopy(cause: string | null, evidence: Record<string, unknown> | null | undefined): string | null {
  const by = (evidence?.closedBy ?? null) as CloseActor | null;
  const login = typeof by?.login === 'string' && by.login ? by.login : null;
  switch (cause) {
    case 'buildd_close': {
      const door = by?.door;
      const reason = typeof door?.reason === 'string' && door.reason.trim() ? door.reason.trim() : null;
      return [`closed through buildd${door?.taskId ? ` by task \`${short8(door.taskId)}\`` : ''}`, reason && (reason.length > 60 ? `${reason.slice(0, 59)}…` : reason)].filter(Boolean).join(' · ');
    }
    case 'manual': return login ? `closed by @${login} on GitHub` : 'closed by a person on GitHub';
    case 'base_deleted': return 'base branch deleted';
    case 'superseded_by_policy': return 'superseded by policy';
    default: return login ? `closed by @${login}` : cause;
  }
}

export type NextMoveOwner = 'worker' | 'reviewer' | 'platform' | 'human' | 'landing' | 'trunk' | 'none';

export type DeliveryStage =
  | 'working'
  | 'awaiting_push'
  | 'review'
  | 'fixing'
  | 'repairing'
  | 'blocked'
  | 'approved'
  | 'landing'
  | 'needs_you'
  | 'merged'
  | 'closed'
  | 'superseded'
  | 'abandoned'
  | 'failed';

/** A conflict-fix (or migration-renumber) task already filed for this PR (S37). */
export interface RemediationRef {
  taskId: string;
  family: 'conflict' | 'migration';
  /** The task's execution status: pending | assigned | in_progress | ... */
  taskStatus: string;
  /** Computed by the loader from claim age and worker liveness. */
  stalled: boolean;
  stallReason?: string | null;
}

/** One attempt task of the delivery (owner, fix, ci_fix, conflict_fix, review). */
export interface AttemptTaskRef {
  taskId: string;
  role: string;
  status: string;
  createdAt: string;
  /**
   * The open question this attempt ended on, when it stopped to ask a person
   * (a question, a post_note question without a default, a failure whose
   * evidence needs an owner decision). Set by the loader, null/absent otherwise.
   */
  ownerQuestion?: string | null;
}

export interface TransitionRef {
  command: string;
  fromState: string | null;
  toState: string;
  evidence: Record<string, unknown> | null;
  createdAt: string;
}

export interface DeliveryViewInput {
  view: KernelView;
  lastTransition?: TransitionRef | null;
  attemptTasks?: AttemptTaskRef[];
  remediation?: RemediationRef | null;
  /**
   * An approved PR waits on a person, not the landing path: the effective merge
   * policy is `human`, or `agent-review` approve-only, or a landing handoff is
   * open at the current head. Computed once in the loader (`landingNeedsPerson`).
   */
  approvedNeedsPerson?: boolean;
  /** What the viewer may do on a review escalation (policy override, repo merge permission). */
  escalationPermissions?: EscalationBriefPermissions;
  /**
   * A behind refresh parked in the landing lane (lib/workflow/landing-lane.ts):
   * the PR holding the lane on this base, when known, and this PR's place among the
   * parked refreshes on that base (1 = next). Absent or null = not parked.
   */
  laneWait?: LaneWait | null;
  /**
   * The owner task is back in the queue with no worker on it (a loop pass waiting
   * on its backoff, a retry): WORKING then names the wait, not an agent at work.
   */
  ownerParked?: boolean;
}

export interface LaneWait {
  behindPr: number | null;
  position?: number | null;
}

export type DeliveryCta =
  | { action: 'repair_remediation'; label: 'Run fix' | 'Repair'; taskId: string }
  | { action: 'create_conflict_fix'; label: 'Resolve conflicts' }
  | { action: 'open_pr'; label: 'Review on GitHub' };

export interface DeliveryAttemptHistoryEntry {
  taskId: string;
  role: string;
  status: string;
  /** True when a later attempt of the same role replaced this one. */
  superseded: boolean;
}

export interface DeliveryView {
  deliveryId: string;
  ownerTaskId: string;
  repoFullName: string | null;
  prNumber: number | null;
  state: DeliveryState;
  stateReason: string | null;
  version: number;
  headSha: string | null;
  stage: DeliveryStage;
  owner: NextMoveOwner;
  /** True only when the owner of the next move is a person. */
  needsYou: boolean;
  /** Short state line ("Waiting for the fix to reach GitHub"). */
  headline: string;
  /** The evidence behind the state, specific to this delivery; null when the headline says it all. */
  detail: string | null;
  /** True when the standing approval of the current head is a verified composition attestation. */
  compositionVerified: boolean;
  /** "attempt N of M" per family, 1-based, from the ledger (§5.7 rule 4). */
  attempts: Partial<Record<AttemptFamily, { n: number; m: number }>>;
  /** The newest attempt task, which is the one the delivery is acting on. */
  currentAttempt: AttemptTaskRef | null;
  /** Every attempt, oldest first; superseded ones stay for audit (S35). */
  history: DeliveryAttemptHistoryEntry[];
  cta: DeliveryCta | null;
  /**
   * The PR's display state read from the delivery's own facts on its current
   * head (§17.5). Replaces `derivePrDisplayState` over the worker columns for
   * a kernel-owned PR. Null when no PR is bound.
   */
  prState: PrDisplayState | null;
  /** GitHub's `merged_at` as the delivery recorded it (T17); null until merged. */
  mergedAt: string | null;
  /** T20's record: the PR this delivery's work landed under. Null without one. */
  supersededBy: PrSupersededBy | null;
  /** The newest `workflow_transitions` row: what moved the delivery here, and when. */
  lastTransition: TransitionRef | null;
  /** Every review round, oldest first: the task page's checks list (docs/specs/task-page.md). */
  rounds: RoundSnapshot[];
  /** The attempt ledger (repairs and refreshes), as recorded: the checks list attaches each to its cause. */
  ledger: AttemptSnapshot[];
  /** The current head carries a standing approval (a verdict, or one carried across a content-equivalent refresh). */
  approvedCurrentHead: boolean;
  approvalBasis: DeliverySnapshot['approvalBasis'];
  /** §5: every finding with its disposition, oldest first; resolved ones stay for history. */
  findings?: FindingSnapshot[];
  /** §5: how many required findings are still open (`open` or `addressed`). */
  openFindings?: number;
  /** Of those, how many a push already touched (`addressed`): a fix waiting for a re-review (AC-17). */
  addressedFindings?: number;
  /**
   * Living Spec r7 AC-47: the required findings partitioned, each counted once: open,
   * addressed awaiting verification, verified resolved, set aside (waived or deferred).
   * `open + addressedAwaitingVerification` equals `openFindings`. Count from this, never by
   * adding `openFindings` and `addressedFindings` (the second is inside the first).
   */
  findingTotals: FindingTotals;
  /**
   * R-43: what the `Buildd / Review approval` status says on the current head, in the
   * same plain terms it publishes, so a surface can show it apart from CI. Null
   * when nothing is published (no PR head, or the delivery is over).
   */
  reviewApproval?: { state: 'success' | 'failure' | 'pending'; description: string } | null;
  /** What a person is asked to decide on a review escalation: its cause, findings by state, and the actions open to them. Null otherwise. */
  escalation?: EscalationBrief | null;
  /**
   * A behind refresh parked in the landing lane: queued behind another PR on the
   * same base, no repair running. Null when not parked. Owner is `landing` then.
   */
  laneWait?: LaneWait | null;
  /**
   * Living Spec fa62b865 R-50: the one review reading every surface shows (task page, mission
   * page, get_pr, get_pr_review, explain, the commit status and the sticky comment). No surface
   * derives a review state of its own.
   */
  review: ReviewReading;
}

/** A review's outcome as every surface names it (R-50). */
export type ReviewVerdict = 'none' | 'queued' | 'reviewing' | 'collecting_evidence' | 'changes_requested' | 'approved' | 'escalated' | 'failed' | 'merged';

/** One open finding in the shape every surface lists it (R-48): once, by id, with where and what. */
export interface ReadingFinding {
  id: string;
  shortId: string;
  path: string | null;
  line: number | null;
  title: string;
  status: FindingSnapshot['status'];
  remedyClass: RemedyClass;
  restatedCount: number;
  /** The one-line form: "`ab12cd34:0` src/a.ts:4: off by one (restated twice)". */
  text: string;
}

export interface ReviewReading {
  /** The delivery's state line (`DeliveryView.headline`): the same words on every surface. */
  stateLine: string;
  verdict: ReviewVerdict;
  /** "Round n of m": the current round's number, and the rounds spent of the budget (§11.1: only code fixes spend). */
  round: number;
  roundsSpent: number;
  roundBudget: number;
  /** The required findings still open (`open` or `addressed`), oldest first. */
  openFindings: ReadingFinding[];
  totals: FindingTotals;
  /** The review stops the PR until something answers it: open it, never bury it (Task Page AC-28). */
  blocks: boolean;
  escalation: EscalationBrief | null;
}

const REVIEW_ESCALATIONS = new Set(['review_escalated', 'review_exhausted', 'review_unavailable']);

function readingFinding(f: FindingSnapshot): ReadingFinding {
  return {
    id: f.id, shortId: shortFindingId(f.id), path: f.path, line: f.line, title: f.title, status: f.status,
    remedyClass: f.remedyClass ?? 'code_fix', restatedCount: f.restatedCount ?? 0, text: findingLine(f),
  };
}

/** R-50: the review reading, from the delivery alone. */
export function reviewReadingOf(view: KernelView, headline: string, escalation: EscalationBrief | null): ReviewReading {
  const d = view.delivery!;
  const current = view.rounds.find((r) => r.round === d.currentRound) ?? null;
  const reviewEscalation = d.state === 'ESCALATED' && REVIEW_ESCALATIONS.has(d.stateReason ?? '');
  const verdict: ReviewVerdict =
    d.state === 'MERGED' ? 'merged'
    : reviewEscalation ? 'escalated'
    : current?.status === 'failed' ? 'failed'
    : d.state === 'CHANGES_REQUESTED' || d.state === 'FIXING' ? 'changes_requested'
    : d.state === 'AWAITING_REVIEW' && d.stateReason === 'evidence' ? 'collecting_evidence'
    : d.state === 'AWAITING_REVIEW' ? (current?.status === 'reviewing' ? 'reviewing' : current ? 'queued' : 'none')
    : d.currentHeadSha != null && (d.approvedHeads.includes(d.currentHeadSha) || d.compositionHeads.includes(d.currentHeadSha)) ? 'approved'
    : current?.status === 'decided' && current.effectiveVerdict === 'request_changes' ? 'changes_requested'
    : current?.status === 'decided' && current.effectiveVerdict === 'approve' ? 'approved'
    : 'none';
  return {
    stateLine: headline,
    verdict,
    round: d.currentRound,
    roundsSpent: spentReviewRounds(view),
    roundBudget: d.maxRounds,
    openFindings: openRequiredFindings(view).map(readingFinding),
    totals: findingTotals(view.findings),
    blocks: verdict === 'changes_requested' || verdict === 'escalated' || verdict === 'failed',
    escalation,
  };
}

/**
 * The PR display state from the delivery alone. A CI or mergeable fact counts
 * only when it was observed on the current head; the kernel records no
 * "CI running" fact, so an open PR without a verdict on its head reads
 * `awaiting_ci`.
 */
export function deliveryPrState(d: DeliverySnapshot): PrDisplayState | null {
  if (d.prNumber == null) return null;
  switch (d.state) {
    case 'MERGED': return 'merged';
    case 'SUPERSEDED':
    case 'ABANDONED':
    case 'CLOSED_UNMERGED': return 'closed';
    default: break;
  }
  const onHead = (sha: string | null) => sha != null && sha === d.currentHeadSha;
  if (d.state === 'REPAIRING' && (d.stateReason === 'conflict' || d.stateReason === 'migration')) return 'conflict';
  if (d.mergeable === 'dirty' && onHead(d.mergeableHeadSha)) return 'conflict';
  if ((d.state === 'REPAIRING' && d.stateReason === 'ci') || d.state === 'BLOCKED_ON_TRUNK') return 'ci_failed';
  if (d.ci === 'red' && onHead(d.ciHeadSha)) return 'ci_failed';
  if (d.ci === 'green' && onHead(d.ciHeadSha)) return 'ci_passed';
  return 'awaiting_ci';
}

const short = (sha: string | null | undefined): string => (sha ? sha.slice(0, 7) : 'unknown');

/** " · PR is red", naming the failing check when the last transition read them. */
function redSuffix(t: TransitionRef | null | undefined): string {
  const checks = (t?.evidence?.liveChecks as { failing?: unknown } | undefined)?.failing;
  const failing = Array.isArray(checks) ? checks.filter((c): c is string => typeof c === 'string' && !!c.trim()) : [];
  if (failing.length === 0) return ' · PR is red';
  return ` · PR is red: ${failing[0]}${failing.length > 1 ? ` and ${failing.length - 1} more` : ''}`;
}

/** §4: who the platform waits on, per state. Exactly one per non-terminal state. */
export function ownerOfNextMove(state: DeliveryState, o: { boundAttemptRunning?: boolean; remediation?: RemediationRef | null; approvedNeedsPerson?: boolean } = {}): NextMoveOwner {
  switch (state) {
    case 'WORKING': return 'worker';
    case 'AWAITING_PUSH': return 'platform';
    case 'AWAITING_REVIEW': return 'reviewer';
    case 'CHANGES_REQUESTED': return 'platform';
    case 'FIXING': return 'worker';
    case 'REPAIRING':
      if (o.remediation && !o.remediation.stalled) return 'worker';
      return o.boundAttemptRunning ? 'worker' : 'platform';
    case 'BLOCKED_ON_TRUNK': return 'trunk';
    case 'APPROVED': return o.approvedNeedsPerson ? 'human' : 'landing';
    case 'LANDING': return 'landing';
    case 'ESCALATED': return 'human';
    case 'CLOSED_UNMERGED': return 'platform';
    case 'MERGED':
    case 'SUPERSEDED':
    case 'ABANDONED':
    case 'FAILED': return 'none';
  }
}

function stageOf(state: DeliveryState): DeliveryStage {
  switch (state) {
    case 'WORKING': return 'working';
    case 'AWAITING_PUSH': return 'awaiting_push';
    case 'AWAITING_REVIEW':
    case 'CHANGES_REQUESTED': return 'review';
    case 'FIXING': return 'fixing';
    case 'REPAIRING': return 'repairing';
    case 'BLOCKED_ON_TRUNK': return 'blocked';
    case 'APPROVED': return 'approved';
    case 'LANDING': return 'landing';
    case 'ESCALATED': return 'needs_you';
    case 'MERGED': return 'merged';
    case 'CLOSED_UNMERGED': return 'closed';
    case 'SUPERSEDED': return 'superseded';
    case 'ABANDONED': return 'abandoned';
    case 'FAILED': return 'failed';
  }
}

const ESCALATION_COPY: Record<string, string> = {
  review_escalated: 'The reviewer escalated this PR',
  review_exhausted: 'Review budget spent without an approval',
  review_unavailable: 'No valid review verdict could be produced',
  ci_exhausted: 'CI fix budget spent',
  ci_unfixed_head: 'A CI fix ended without changing the head; another on the same head would repeat it',
  conflict_exhausted: 'Conflict fix budget spent',
  push_undeliverable: 'The fix never reached GitHub',
  landing_needs_human: 'Merge blocked: a person has to merge it',
  effect_dead: 'An automatic step kept failing; a person has to take it from here',
  policy_human: 'Workspace policy requires a person',
  unsafe_to_merge: 'Unsafe to merge',
};

const COUNT_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const countWord = (n: number): string => COUNT_WORDS[n] ?? String(n);
const timesWord = (n: number): string => (n === 1 ? 'once' : n === 2 ? 'twice' : `${countWord(n)} times`);

/**
 * c1d66a6a: `review_exhausted` names what happened. A delivery that never had an approval spent
 * its budget without one; one that was approved and then had a later change refused says so,
 * rather than "without an approval" for a PR approved twice; one whose last verdict approved but
 * left findings unverified says that the verification ran out of rounds.
 */
export function reviewExhaustedCopy(rounds: RoundSnapshot[]): string {
  const decided = rounds.filter((r) => r.effectiveVerdict === 'approve' || r.effectiveVerdict === 'request_changes').sort((a, b) => a.round - b.round);
  const approvals = decided.filter((r) => r.effectiveVerdict === 'approve');
  const last = approvals.at(-1);
  if (!last) return ESCALATION_COPY.review_exhausted!;
  const refused = decided.filter((r) => r.round > last.round && r.effectiveVerdict === 'request_changes').length;
  // The last verdict approved, but left findings unverified, and the verification round did not fit.
  if (refused === 0) return 'Approved, but findings it left unverified ran out of review rounds';
  return `Approved${approvals.length > 1 ? ` ${timesWord(approvals.length)}` : ''}, then a later change was refused${refused > 1 ? ` ${timesWord(refused)}` : ''}`;
}

/**
 * `review_escalated` names who escalated. A server gate (migration safety, a hard path rule,
 * the confidence bar) can override an approve after the reviewer decided; the round keeps the
 * reviewer's own verdict beside the effective one, so the copy says it was the gate, not the
 * reviewer, that sent the PR to a person.
 */
export function reviewEscalatedCopy(rounds: RoundSnapshot[]): string {
  const last = rounds.filter((r) => r.status === 'decided' && r.effectiveVerdict).sort((a, b) => b.round - a.round)[0];
  if (last?.effectiveVerdict === 'escalate' && last.verdict && last.verdict !== 'escalate') {
    return last.verdict === 'approve'
      ? 'The reviewer approved; a merge gate escalated this PR'
      : 'A merge gate escalated this PR';
  }
  return ESCALATION_COPY.review_escalated!;
}

/** c1d66a6a / AC-17: open findings a push already touched, waiting for a review to verify them. */
function addressedNote(findings: FindingSnapshot[]): string | null {
  const open = findings.filter((f) => f.required && (f.status === 'open' || f.status === 'addressed'));
  const addressed = open.filter((f) => f.status === 'addressed').length;
  if (addressed === 0) return null;
  return addressed === open.length
    ? `${addressed === 1 ? 'the finding has' : `all ${countWord(addressed)} findings have`} a fix waiting for a re-review`
    : `${countWord(addressed)} of ${countWord(open.length)} findings ${addressed === 1 ? 'has' : 'have'} a fix waiting for a re-review`;
}

/**
 * `landing_needs_human` says which kind of refusal it was (S15 / T16 / §6.7), so a
 * person reading "a person has to merge it" knows whether the base kept moving
 * faster than CI, the base keeps changing what the PR changes (and which files),
 * the gap touches a risky path (and which),
 * GitHub itself refused the merge, or the branch could not be updated. A policy
 * refusal (deny path, human tier, migration) is its own escalation reason.
 */
export function landingEscalationCopy(t: TransitionRef | null | undefined): { headline: string; detail: string | null } {
  const ev = t?.evidence ?? null;
  const str = (k: string): string | null => (ev && typeof ev[k] === 'string' && (ev[k] as string).trim() ? (ev[k] as string).trim() : null);
  if (t?.command === 'ConflictObserved' && ev?.treadmill === true) {
    const files = Array.isArray(ev.files) ? (ev.files as unknown[]).filter((f): f is string => typeof f === 'string') : [];
    if (ev.cause === 'refresh_unsafe') {
      // dc4436aa: a risky path in the gap is not the base changing this PR's files. Evidence
      // from before `deltaBasis` was recorded is told apart by the rule's own words.
      const risky = ev.deltaBasis === 'risky_path' || (ev.deltaBasis == null && (str('deltaReason') ?? '').startsWith('the gap involves'));
      if (risky) {
        return {
          headline: 'Merge held: the base or this PR touches a migration, lockfile, manifest or CI file',
          detail: files.length ? `the gap touches ${files.join(', ')}` : str('deltaReason'),
        };
      }
      return {
        headline: 'Merge held: the base keeps changing what this PR changes',
        detail: files.length ? `the base changed ${files.join(', ')}` : str('deltaReason'),
      };
    }
    const refreshes = typeof ev.refreshes === 'number' ? ev.refreshes : null;
    const behindBy = typeof ev.behindBy === 'number' ? ev.behindBy : null;
    return {
      headline: 'Merge held: the base kept moving faster than CI',
      detail: [refreshes != null ? `refreshed ${refreshes} times` : null, behindBy != null ? `${behindBy} commits behind` : null].filter(Boolean).join(', ') || null,
    };
  }
  if (t?.command === 'MergeCallResult' && ev?.outcome === 'gate_refused') return { headline: 'The review approval check refused the merge when it ran; a person has to look', detail: str('detail') };
  if (t?.command === 'MergeCallResult' && ev?.outcome === 'held') return { headline: 'GitHub kept the merge waiting on a required check that has not passed; a person has to look', detail: str('detail') };
  if (t?.command === 'MergeCallResult') return { headline: 'GitHub refused the merge; a person has to merge it', detail: str('detail') };
  if (t?.command === 'MechanicalRepairFailed') return { headline: 'Updating the branch kept failing; a person has to merge it', detail: str('reason') };
  return { headline: ESCALATION_COPY.landing_needs_human!, detail: evidenceDetail(t) };
}

function evidenceDetail(t: TransitionRef | null | undefined): string | null {
  const ev = t?.evidence;
  if (!ev) return null;
  const pick = (k: string): string | null => (typeof ev[k] === 'string' && (ev[k] as string).trim() ? (ev[k] as string).trim() : null);
  return pick('reason') ?? pick('note') ?? pick('summary') ?? null;
}

/** Whether the latest attempt per role replaced earlier attempts of that role. */
function historyOf(tasks: AttemptTaskRef[]): DeliveryAttemptHistoryEntry[] {
  const sorted = [...tasks].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const latestByRole = new Map<string, string>();
  for (const t of sorted) latestByRole.set(t.role, t.taskId);
  return sorted.map((t) => ({ taskId: t.taskId, role: t.role, status: t.status, superseded: latestByRole.get(t.role) !== t.taskId }));
}

export function deriveDeliveryView(input: DeliveryViewInput): DeliveryView | null {
  const d = input.view.delivery;
  if (!d) return null;
  const tasks = input.attemptTasks ?? [];
  const history = historyOf(tasks);
  const currentAttempt = tasks.length
    ? [...tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null
    : null;
  const bound = d.boundAttemptId ? input.view.attempts.find((a) => a.id === d.boundAttemptId) : undefined;
  const boundAttemptRunning = bound ? bound.status === 'running' || bound.status === 'queued' : false;
  const remediation = input.remediation ?? null;

  const conflictOnHead = d.mergeable === 'dirty' && d.mergeableHeadSha === d.currentHeadSha;
  const repairKind = d.state === 'REPAIRING' ? d.stateReason : null;
  const laneWait = repairKind === 'behind' ? input.laneWait ?? null : null;
  const conflictBlocked = repairKind === 'conflict' || repairKind === 'migration'
    || (conflictOnHead && !['MERGED', 'SUPERSEDED', 'ABANDONED', 'FAILED', 'CLOSED_UNMERGED'].includes(d.state));

  const compositionVerified = d.approvalBasis === 'composition'
    && d.currentHeadSha != null && d.compositionHeads.includes(d.currentHeadSha);

  let owner = ownerOfNextMove(d.state, { boundAttemptRunning, remediation, approvedNeedsPerson: input.approvedNeedsPerson });
  let stage = stageOf(d.state);
  let headline: string;
  let detail: string | null = null;
  let cta: DeliveryCta | null = null;
  const pr = d.prNumber != null ? `PR #${d.prNumber}` : 'the PR';

  switch (d.state) {
    case 'WORKING': headline = input.ownerParked ? "Waiting for the agent's next pass" : 'Agent working'; break;
    case 'AWAITING_PUSH':
      headline = 'Waiting for the fix to reach GitHub';
      detail = `${pr} is still at ${short(d.currentHeadSha)}; the platform is re-checking for the pushed commit`;
      break;
    case 'AWAITING_REVIEW': {
      const round = input.view.rounds.find((r) => r.round === d.currentRound);
      if (d.stateReason === 'evidence') {
        // §11.1 R-46: buildd is capturing what an evidence finding needs; no builder is asked, no round spent.
        const n = Array.isArray((round?.scope?.evidence as { findingIds?: unknown[] } | undefined)?.findingIds)
          ? (round!.scope!.evidence as { findingIds: unknown[] }).findingIds.length : 0;
        headline = 'Collecting evidence';
        detail = `capturing ${n === 1 ? 'one design screen' : `${countWord(n)} design screens`} at ${short(round?.headSha ?? d.currentHeadSha)}`;
        owner = 'platform';
        break;
      }
      headline = round?.status === 'reviewing' ? 'Reviewing' : 'Review queued';
      detail = round ? `round ${round.round} at ${short(round.headSha)}${round.kind === 'delta' ? ' · changes since the last review' : ''}` : null;
      break;
    }
    case 'CHANGES_REQUESTED': headline = 'Changes requested · fix queued'; break;
    case 'FIXING': headline = 'Fixing review feedback'; break;
    // "Repairing" is an agent changing code. A behind refresh is the platform
    // updating the branch from its base (docs/specs/task-page.md). Parked in the
    // landing lane, it says which PR is landing on that base first.
    case 'REPAIRING':
      if (laneWait) {
        // Parked, not repairing: nothing runs on this PR until the lane frees, and the
        // landing lane (not a worker) owns the next move.
        const base = d.baseRef ?? 'its base';
        const approved = d.currentHeadSha != null && d.approvedHeads.includes(d.currentHeadSha);
        const behind = laneWait.behindPr != null ? `PR #${laneWait.behindPr}` : 'another PR';
        headline = approved ? `Approved · queued to land behind ${behind}` : 'Waiting to update branch';
        const place = laneWait.position != null && laneWait.position > 0 ? `; position ${laneWait.position} in the queue` : '';
        detail = `${behind} is merging into ${base} first${place}`;
        owner = 'landing';
      } else {
        headline = repairKind === 'ci' ? 'Fixing CI' : repairKind === 'behind' ? 'Updating branch' : 'Repairing';
      }
      break;
    case 'BLOCKED_ON_TRUNK': headline = 'Blocked on a red base branch'; break;
    case 'APPROVED':
      if (compositionVerified) {
        // §5.9 / S33: a delta round approved only the paths new to this composed PR
        // (release, integration or refresh); it is not a verdict on the whole PR.
        const delta = input.view.rounds.find((r) => r.scope?.composition === true && r.status === 'decided'
          && r.effectiveVerdict === 'approve' && r.headSha === d.currentHeadSha);
        const n = delta && Array.isArray(delta.scope?.novelDeltaPaths) ? (delta.scope!.novelDeltaPaths as unknown[]).length : 0;
        headline = delta ? 'New changes approved' : 'Composition verified';
        detail = delta
          ? `every other change was reviewed at its own head; this review covered only ${n} new ${n === 1 ? 'path' : 'paths'}`
          : 'every change in it was reviewed at its own head; nothing new was added';
      } else {
        // Approved is not merged: the header says what it waits on until the merge fact.
        // Ready only once the required checks passed on this head; until then
        // the approval waits on them, not on a merge.
        const ci = deliveryPrState(d);
        headline = ci === 'awaiting_ci' || ci === 'ci_running' ? 'Approved · checking'
          : ci === 'ci_failed' ? 'Approved · checks failing'
          : d.approvalBasis === 'policy' || ci === 'ci_passed' ? 'Ready to merge' : 'Approved · awaiting merge';
      }
      break;
    case 'LANDING': headline = 'Merging'; break;
    case 'ESCALATED':
      if (d.stateReason === 'landing_needs_human') {
        ({ headline, detail } = landingEscalationCopy(input.lastTransition));
      } else {
        headline = d.stateReason === 'review_exhausted' ? reviewExhaustedCopy(input.view.rounds)
          : d.stateReason === 'review_escalated' ? reviewEscalatedCopy(input.view.rounds)
          : ESCALATION_COPY[d.stateReason ?? ''] ?? 'Needs a decision';
        detail = [evidenceDetail(input.lastTransition), addressedNote(input.view.findings ?? [])].filter(Boolean).join('; ') || null;
      }
      // 08d752ed (#5539): whatever it escalated for, a red head is part of what the person decides on.
      if (d.stateReason !== 'ci_exhausted' && d.ci === 'red' && d.ciHeadSha != null && d.ciHeadSha === d.currentHeadSha) headline += redSuffix(input.lastTransition);
      cta = { action: 'open_pr', label: 'Review on GitHub' };
      break;
    case 'MERGED': headline = 'Merged'; break;
    case 'CLOSED_UNMERGED':
      headline = 'Closed without merging';
      detail = closeCauseCopy(d.stateReason, input.lastTransition?.command === 'PrClosedUnmerged' ? input.lastTransition.evidence : null);
      break;
    case 'SUPERSEDED': headline = d.supersededByPr != null ? `Merged in #${d.supersededByPr}` : 'Superseded'; break;
    case 'ABANDONED': headline = 'Abandoned'; break;
    case 'FAILED': headline = 'Failed'; detail = d.stateReason; break;
  }

  // S37: a conflicted PR is never a bare "create a conflict fix" state when a
  // remediation already exists. The CTA names the real next transition.
  if (conflictBlocked && d.state !== 'ESCALATED') {
    stage = 'repairing';
    if (remediation && remediation.stalled) {
      headline = 'Conflict fix stalled';
      detail = remediation.stallReason ?? `the conflict fix for ${pr} has not started`;
      owner = 'platform';
      cta = { action: 'repair_remediation', label: remediation.taskStatus === 'pending' ? 'Run fix' : 'Repair', taskId: remediation.taskId };
    } else if (remediation) {
      headline = 'Resolving conflicts';
      owner = 'worker';
      cta = null;
    } else {
      headline = 'Merge conflict';
      detail = `${pr} conflicts with its base at ${short(d.currentHeadSha)}`;
      owner = 'platform';
      cta = { action: 'create_conflict_fix', label: 'Resolve conflicts' };
    }
  }

  // A fix attempt that ended asking a person: the next move is theirs, whatever
  // state the ledger is in. Requeueing the attempt would stall the same way.
  const FIX_ROLES = new Set(['fix', 'ci_fix', 'conflict_fix', 'migration_fix', 'trunk_fix']);
  const OPEN_STATES: DeliveryState[] = ['CHANGES_REQUESTED', 'FIXING', 'REPAIRING', 'AWAITING_PUSH', 'AWAITING_REVIEW', 'WORKING'];
  const asked = [...tasks].filter((t) => FIX_ROLES.has(t.role) && t.ownerQuestion).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (asked && OPEN_STATES.includes(d.state)) {
    owner = 'human';
    stage = 'needs_you';
    headline = 'Waiting on you: a fix attempt asked a question';
    detail = asked.ownerQuestion!;
    cta = null;
  }

  const escalation = deriveEscalationBrief(input.view, input.escalationPermissions);
  const attempts: DeliveryView['attempts'] = {};
  for (const fam of ['review_fix', 'ci', 'conflict', 'migration', 'trunk'] as AttemptFamily[]) {
    if (input.view.attempts.some((a) => a.family === fam)) attempts[fam] = attemptView(input.view.attempts, fam, d.maxRounds);
  }

  return {
    deliveryId: d.id,
    ownerTaskId: d.ownerTaskId,
    repoFullName: d.repoFullName,
    prNumber: d.prNumber,
    state: d.state,
    stateReason: d.stateReason,
    version: d.version,
    headSha: d.currentHeadSha,
    stage,
    owner,
    needsYou: owner === 'human',
    headline,
    detail,
    compositionVerified,
    attempts,
    currentAttempt,
    history,
    cta,
    prState: deliveryPrState(d),
    mergedAt: d.mergedAt ?? null,
    supersededBy: d.supersededByPr != null || d.supersededByUrl
      ? { prNumber: d.supersededByPr ?? null, url: d.supersededByUrl ?? null, reason: d.supersededReason ?? null }
      : null,
    lastTransition: input.lastTransition ?? null,
    rounds: [...input.view.rounds].sort((a, b) => a.round - b.round),
    ledger: input.view.attempts,
    approvedCurrentHead: d.currentHeadSha != null && d.approvedHeads.includes(d.currentHeadSha),
    approvalBasis: d.approvalBasis,
    findings: input.view.findings ?? [],
    openFindings: openRequiredFindings(input.view).length,
    addressedFindings: openRequiredFindings(input.view).filter((f) => f.status === 'addressed').length,
    findingTotals: findingTotals(input.view.findings),
    reviewApproval: reviewApprovalOf(input.view),
    escalation,
    laneWait,
    review: reviewReadingOf(input.view, headline, escalation),
  };
}

function reviewApprovalOf(view: KernelView): DeliveryView['reviewApproval'] {
  const s = landingStatusOf(view);
  return s ? { state: s.state, description: s.description } : null;
}

const FAMILY_LABEL: Record<AttemptFamily, string> = { ci: 'CI', review_fix: 'review', conflict: 'conflict', migration: 'migration', trunk: 'trunk' };

/**
 * §5.7 rule 4 / §12.1: the one family-labelled "attempt N of M" line
 * ("CI 1 of 3 · review 1 of 3"), identical wherever it is shown. Only the
 * families the ledger has rows for; null when it has none.
 */
export function attemptLine(attempts: DeliveryView['attempts']): string | null {
  const order: AttemptFamily[] = ['ci', 'review_fix', 'conflict', 'migration', 'trunk'];
  const parts = order.filter((f) => attempts[f]).map((f) => `${FAMILY_LABEL[f]} ${attempts[f]!.n} of ${attempts[f]!.m}`);
  return parts.length ? parts.join(' · ') : null;
}

/**
 * S35: does a failed attempt task count as a failure of the work? Only when
 * it is the current attempt of a delivery that is itself not moving. A
 * superseded predecessor, or a failed attempt of a delivery that is still
 * live or already shipped, is history.
 */
export function attemptFailureCounts(view: DeliveryView, taskId: string): boolean {
  if (view.state === 'FAILED') return view.currentAttempt?.taskId === taskId || view.ownerTaskId === taskId;
  return false;
}

/** A review round as the read model lists it (`DeliveryView.rounds`). */
export type DeliveryRound = RoundSnapshot;

/**
 * 58c8961e: one sentence on why a round started, whether it is a delta review
 * that carries an approval (or, after one, why it is a full review), and how it
 * ended if a push superseded it. Null for a round recorded before triggers.
 */
export function roundTriggerSentence(r: RoundSnapshot): string | null {
  if (!r.trigger || !ROUND_TRIGGER_COPY[r.trigger]) return null;
  const parts = [ROUND_TRIGGER_COPY[r.trigger]];
  const el = r.scope?.deltaApproval as { eligible?: unknown; fromHeadSha?: unknown; reason?: unknown } | undefined;
  if (el?.eligible === true && r.kind === 'delta' && typeof el.fromHeadSha === 'string') parts.push(`A delta review that carries the approval at ${el.fromHeadSha.slice(0, 7)}`);
  else if (el && el.eligible !== true && typeof el.reason === 'string') parts.push(`A full review, because ${el.reason}`);
  if (r.status === 'superseded') parts.push(r.endReason === 'superseded_by_push' ? 'Ended: replaced by a newer push' : 'Ended: superseded');
  return `Review round ${r.round} at ${r.headSha.slice(0, 7)}: ${parts.join('. ')}.`;
}

const REPAIR_FAMILY_LABEL: Record<AttemptFamily, string> = { review_fix: 'Review fix', ci: 'CI fix', conflict: 'Conflict fix', migration: 'Migration fix', trunk: 'Base fix' };

/**
 * One repair's label, "CI fix 2 of 3" (§5.7 rule 4, 295486ba): N is its place among the
 * attempts that were dispatched (`attemptOrdinal`), never the raw `attempt_no`, which a skipped
 * row also takes, so the label can't run past the budget ("4 of 3"). A skipped row spent nothing
 * and has no number.
 */
export function repairLabelOf(a: AttemptSnapshot, ledger: AttemptSnapshot[], o: { upTo?: boolean } = {}): string {
  const n = attemptOrdinal(ledger, a);
  return n == null ? `${REPAIR_FAMILY_LABEL[a.family]}, not started` : `${REPAIR_FAMILY_LABEL[a.family]} ${n} of ${o.upTo ? 'up to ' : ''}${a.maxAttempts}`;
}
