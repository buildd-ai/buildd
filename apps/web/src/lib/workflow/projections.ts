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
import type { PrDisplayState } from '@/lib/pr-presentation';
import { attemptView } from './reducer';
import type { AttemptFamily, DeliverySnapshot, DeliveryState, KernelView } from './types';

export type { DeliverySnapshot } from './types';

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
  /** The newest `workflow_transitions` row: what moved the delivery here, and when. */
  lastTransition: TransitionRef | null;
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

/** §4: who the platform waits on, per state. Exactly one per non-terminal state. */
export function ownerOfNextMove(state: DeliveryState, o: { boundAttemptRunning?: boolean; remediation?: RemediationRef | null } = {}): NextMoveOwner {
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
    case 'APPROVED':
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
  conflict_exhausted: 'Conflict fix budget spent',
  push_undeliverable: 'The fix never reached GitHub',
  landing_needs_human: 'Merge refused; a person has to land it',
  policy_human: 'Workspace policy requires a person',
  unsafe_to_merge: 'Unsafe to merge',
};

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
    ? [...tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
    : null;
  const bound = d.boundAttemptId ? input.view.attempts.find((a) => a.id === d.boundAttemptId) : undefined;
  const boundAttemptRunning = bound ? bound.status === 'running' || bound.status === 'queued' : false;
  const remediation = input.remediation ?? null;

  const conflictOnHead = d.mergeable === 'dirty' && d.mergeableHeadSha === d.currentHeadSha;
  const repairKind = d.state === 'REPAIRING' ? d.stateReason : null;
  const conflictBlocked = repairKind === 'conflict' || repairKind === 'migration'
    || (conflictOnHead && !['MERGED', 'SUPERSEDED', 'ABANDONED', 'FAILED', 'CLOSED_UNMERGED'].includes(d.state));

  const compositionVerified = d.approvalBasis === 'composition'
    && d.currentHeadSha != null && d.compositionHeads.includes(d.currentHeadSha);

  let owner = ownerOfNextMove(d.state, { boundAttemptRunning, remediation });
  let stage = stageOf(d.state);
  let headline: string;
  let detail: string | null = null;
  let cta: DeliveryCta | null = null;
  const pr = d.prNumber != null ? `PR #${d.prNumber}` : 'the PR';

  switch (d.state) {
    case 'WORKING': headline = 'Agent working'; break;
    case 'AWAITING_PUSH':
      headline = 'Waiting for the fix to reach GitHub';
      detail = `${pr} is still at ${short(d.currentHeadSha)}; the platform is re-checking for the pushed commit`;
      break;
    case 'AWAITING_REVIEW': {
      const round = input.view.rounds.find((r) => r.round === d.currentRound);
      headline = round?.status === 'reviewing' ? 'Reviewing' : 'Review queued';
      detail = round ? `round ${round.round} at ${short(round.headSha)}${round.kind === 'delta' ? ' · changes since the last review' : ''}` : null;
      break;
    }
    case 'CHANGES_REQUESTED': headline = 'Changes requested · fix queued'; break;
    case 'FIXING': headline = 'Fixing review feedback'; break;
    case 'REPAIRING': headline = repairKind === 'ci' ? 'Fixing CI' : 'Repairing'; break;
    case 'BLOCKED_ON_TRUNK': headline = 'Blocked on a red base branch'; break;
    case 'APPROVED':
      headline = compositionVerified ? 'Release composition verified' : d.approvalBasis === 'policy' ? 'Ready to land' : 'Approved';
      if (compositionVerified) detail = 'every change in it was reviewed at its own head; nothing new was added';
      break;
    case 'LANDING': headline = 'Merging'; break;
    case 'ESCALATED':
      headline = ESCALATION_COPY[d.stateReason ?? ''] ?? 'Needs a decision';
      detail = evidenceDetail(input.lastTransition);
      cta = { action: 'open_pr', label: 'Review on GitHub' };
      break;
    case 'MERGED': headline = 'Merged'; break;
    case 'CLOSED_UNMERGED': headline = 'Closed without merging'; detail = d.stateReason; break;
    case 'SUPERSEDED': headline = d.supersededByPr != null ? `Shipped in PR #${d.supersededByPr}` : 'Superseded'; break;
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
    lastTransition: input.lastTransition ?? null,
  };
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
