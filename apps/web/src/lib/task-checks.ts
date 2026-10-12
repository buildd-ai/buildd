/**
 * The task page's checks list and the run's place in its delivery
 * (docs/specs/task-page.md). Pure, client-safe.
 *
 * Every row comes from a fact the workflow kernel recorded on the delivery:
 * review rounds, the CI reading on the current head, the delivery's state, and
 * the attempt ledger. Nothing is inferred from a worker finishing, and a row
 * the facts do not support is not drawn. A repair hangs off the check (or the
 * round) that caused it; a review round is never a repair, and a mechanical
 * branch refresh is not one either.
 */
import { TaskStatus } from '@buildd/shared';
import type { DeliveryView } from './workflow/projections';

// The kernel's snapshots, read through the view (only its read model is imported outside the kernel).
type RoundSnapshot = DeliveryView['rounds'][number];
type AttemptSnapshot = DeliveryView['ledger'][number];
type AttemptFamily = AttemptSnapshot['family'];

export type CheckState = 'passed' | 'failed' | 'running' | 'pending' | 'blocked' | 'closed' | 'skipped';

export interface CheckRepair {
  /** "CI fix 1 of 3" */
  label: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'ended' | 'cancelled';
  taskId: string | null;
}

export interface CheckRow {
  key: 'review' | 'tests' | 'merge';
  name: string;
  state: CheckState;
  result: string;
  repair: CheckRepair | null;
  /** Code review only: the reviewer run whose findings the row opens. */
  reviewTaskId?: string | null;
  /** Code review only: the round the row reads, so its findings stay bound to that round's head. */
  reviewRound?: { round: number; headSha: string; status: RoundSnapshot['status']; carried: boolean } | null;
}

export interface RoundHistoryEntry {
  round: number;
  /** Short head SHA the round reviewed. */
  headSha: string;
  result: string;
  state: CheckState;
  reviewTaskId: string | null;
  repairs: CheckRepair[];
}

export interface TaskChecks {
  current: CheckRow[];
  /** Earlier rounds, oldest first. */
  history: RoundHistoryEntry[];
}

export type ChecksInput = Pick<DeliveryView, 'state' | 'stateReason' | 'prNumber' | 'headSha' | 'prState' | 'rounds' | 'ledger' | 'approvedCurrentHead' | 'approvalBasis'>;

const FAMILY_LABEL: Record<AttemptFamily, string> = { review_fix: 'Review fix', ci: 'CI fix', conflict: 'Conflict fix', migration: 'Migration fix', trunk: 'Base fix' };

function repairStatus(a: AttemptSnapshot): CheckRepair['status'] {
  switch (a.status) {
    case 'queued': return 'queued';
    case 'running': return 'running';
    case 'skipped':
    case 'cancelled': return 'cancelled';
    case 'ended': return a.outcome === 'delivered' ? 'completed' : a.outcome === 'failed' ? 'failed' : 'ended';
  }
}

function repairOf(a: AttemptSnapshot): CheckRepair {
  return { label: `${FAMILY_LABEL[a.family]} ${a.attemptNo} of ${a.maxAttempts}`, status: repairStatus(a), taskId: a.taskId };
}

/** Agent repairs only: a mechanical attempt is the platform updating the branch, not a repair. */
const repairs = (ledger: AttemptSnapshot[]) => ledger.filter(a => a.mode === 'agent');
const newest = <T extends { attemptNo: number }>(xs: T[]): T | undefined => [...xs].sort((a, b) => b.attemptNo - a.attemptNo)[0];

const ROUND_WORD: Record<string, { state: CheckState; word: string }> = {
  approve: { state: 'passed', word: 'Approved' },
  request_changes: { state: 'failed', word: 'Changes requested' },
  escalate: { state: 'blocked', word: 'Escalated to a person' },
};

function roundReading(r: RoundSnapshot): { state: CheckState; word: string } {
  if (r.status === 'queued') return { state: 'pending', word: 'Awaiting review' };
  if (r.status === 'reviewing') return { state: 'running', word: 'In review' };
  if (r.status === 'failed') return { state: 'failed', word: 'Review run failed' };
  if (r.status === 'superseded') return { state: 'skipped', word: 'Superseded by a newer head' };
  const v = r.effectiveVerdict ?? r.verdict;
  return (v && ROUND_WORD[v]) ?? { state: 'pending', word: 'Awaiting review' };
}

const roundRef = (r: RoundSnapshot, carried: boolean) => ({ round: r.round, headSha: r.headSha, status: r.status, carried });

function reviewRow(v: ChecksInput, current: RoundSnapshot | undefined, carried: RoundSnapshot | undefined): CheckRow {
  const base = { key: 'review' as const, name: 'Code review', repair: null };
  if (current) {
    const r = roundReading(current);
    const fix = r.state === 'failed' ? newest(repairs(v.ledger).filter(a => a.family === 'review_fix' && a.triggerReason === current.id)) : undefined;
    return {
      ...base, state: r.state, result: `${r.word} · round ${current.round}`, repair: fix ? repairOf(fix) : null,
      reviewTaskId: current.reviewerTaskId ?? null, reviewRound: roundRef(current, false),
    };
  }
  if (carried) {
    return {
      ...base, state: 'passed', result: `Approved · round ${carried.round} · still valid after a branch update`,
      reviewTaskId: carried.reviewerTaskId ?? null, reviewRound: roundRef(carried, true),
    };
  }
  if (v.approvalBasis === 'policy') return { ...base, state: 'skipped', result: 'Not required by policy' };
  return { ...base, state: 'pending', result: 'Awaiting review' };
}

function testsRow(v: ChecksInput): CheckRow | null {
  const base = { key: 'tests' as const, name: 'Tests' };
  const fix = newest(repairs(v.ledger).filter(a => a.family === 'ci' && a.boundHeadSha === v.headSha));
  if (v.state === 'BLOCKED_ON_TRUNK') return { ...base, state: 'blocked', result: 'Failed · the base branch is red', repair: null };
  switch (v.prState) {
    case 'ci_passed': return { ...base, state: 'passed', result: 'Passed', repair: null };
    case 'ci_failed': return { ...base, state: 'failed', result: 'Failed', repair: fix ? repairOf(fix) : null };
    case 'awaiting_ci': return { ...base, state: 'running', result: 'Checking', repair: null };
    // A conflicted head runs no meaningful CI; merged and closed PRs end the list at Merge.
    default: return null;
  }
}

function mergeRow(v: ChecksInput): CheckRow | null {
  const base = { key: 'merge' as const, name: 'Merge', repair: null };
  switch (v.state) {
    case 'MERGED': return { ...base, state: 'passed', result: 'Merged' };
    case 'LANDING': return { ...base, state: 'running', result: 'Merging' };
    case 'APPROVED': return { ...base, state: 'pending', result: 'Awaiting merge' };
    case 'CLOSED_UNMERGED':
    case 'ABANDONED': return { ...base, state: 'closed', result: 'Closed without merging' };
    case 'SUPERSEDED': return { ...base, state: 'closed', result: 'Landed in another PR' };
    case 'REPAIRING': {
      if (v.stateReason === 'behind') return { ...base, state: 'running', result: 'Updating branch' };
      if (v.stateReason === 'conflict' || v.stateReason === 'migration') {
        const family = v.stateReason === 'migration' ? 'migration' : 'conflict';
        const fix = newest(repairs(v.ledger).filter(a => a.family === family && a.boundHeadSha === v.headSha));
        return { ...base, state: 'failed', result: v.stateReason === 'migration' ? 'Migration number clash' : 'Conflict with base', repair: fix ? repairOf(fix) : null };
      }
      return null;
    }
    default:
      // Before an approval nothing waits on the merge; a row here would only say "not yet".
      return v.prState === 'conflict' ? { ...base, state: 'failed', result: 'Conflict with base' } : null;
  }
}

export function deriveTaskChecks(v: ChecksInput): TaskChecks {
  // Checks are checks on a PR: without one there is nothing to review, test or merge.
  if (v.prNumber == null) return { current: [], history: [] };
  const rounds = [...v.rounds].sort((a, b) => a.round - b.round);
  const live = rounds.filter(r => r.status !== 'superseded');
  const onHead = live.filter(r => r.headSha === v.headSha);
  // A merged delivery's last round is its review even if the merge commit moved the head.
  const current: RoundSnapshot | undefined = onHead[onHead.length - 1] ?? (v.state === 'MERGED' ? live[live.length - 1] : undefined);
  // An approval the kernel carried to this head (content-equivalent refresh) stays current.
  const carried = !current && v.approvedCurrentHead
    ? [...live].reverse().find(r => r.status === 'decided' && (r.effectiveVerdict ?? r.verdict) === 'approve')
    : undefined;
  const shown = current ?? carried;

  const rows = [reviewRow(v, current, carried), testsRow(v), mergeRow(v)].filter((r): r is CheckRow => !!r);
  const history: RoundHistoryEntry[] = rounds
    .filter(r => r !== shown && r.status !== 'superseded')
    .map(r => {
      const reading = roundReading(r);
      const caused = repairs(v.ledger).filter(a => (a.family === 'review_fix' && a.triggerReason === r.id) || (a.family === 'ci' && a.boundHeadSha === r.headSha && r.headSha !== v.headSha));
      return { round: r.round, headSha: r.headSha.slice(0, 7), result: reading.word, state: reading.state, reviewTaskId: r.reviewerTaskId ?? null, repairs: caused.sort((a, b) => a.attemptNo - b.attemptNo).map(repairOf) };
    });
  return { current: rows, history };
}

// ── What an opened Code review row says ─────────────────────────────────────

/** A reviewer run's findings as the page loaded them (lib/task-delivery-context.ts). */
export interface ReviewFindings {
  prose: string | null;
  verdict: string | null;
  /** The reviewer task's status, when its row was read. */
  status?: string | null;
}

export interface ReviewRoundRef {
  round: number;
  /** Short head SHA the round reviewed. */
  headSha: string;
  /** An approval the kernel carried to the current head after a branch update. */
  carried: boolean;
}

export type ReviewDetail =
  | { kind: 'findings'; prose: string; round: ReviewRoundRef; linkTaskId: string | null }
  | { kind: 'queued' | 'running' | 'no-output' | 'run-failed' | 'unavailable'; text: string; round: ReviewRoundRef; linkTaskId: string | null };

/**
 * What the Code review row opens to, or null when it has nothing to add (then
 * the row is not a disclosure). Findings are only ever the current round's
 * reviewer's, so an earlier head's prose never reads as this head's review; a
 * reviewer that left no output is said to have left none, never an approval;
 * the page's own run is not linked to itself.
 */
export function reviewDetailOf(
  row: Pick<CheckRow, 'key' | 'reviewTaskId' | 'reviewRound'>,
  p: { findings: Map<string, ReviewFindings>; findingsUnavailable?: boolean; currentTaskId: string },
): ReviewDetail | null {
  const r = row.reviewRound;
  if (row.key !== 'review' || !r) return null;
  const id = row.reviewTaskId ?? null;
  const round: ReviewRoundRef = { round: r.round, headSha: r.headSha.slice(0, 7), carried: r.carried };
  const linkTaskId = id && id !== p.currentTaskId ? id : null;
  const f = id ? p.findings.get(id) : undefined;
  const say = (kind: Exclude<ReviewDetail['kind'], 'findings'>, text: string): ReviewDetail => ({ kind, text, round, linkTaskId });

  if (r.status === 'failed') return say('run-failed', 'The review run ended before giving a verdict');
  if (r.status === 'queued' || r.status === 'reviewing') {
    return r.status === 'reviewing' || f?.status === TaskStatus.IN_PROGRESS
      ? say('running', 'Review in progress · no findings yet')
      : say('queued', 'Review queued · no findings yet');
  }
  if (f?.prose) return { kind: 'findings', prose: f.prose, round, linkTaskId };
  if (p.findingsUnavailable) return say('unavailable', 'Couldn’t load the review’s findings');
  return say('no-output', 'The review finished without written findings');
}

// ── Which run this page is ──────────────────────────────────────────────────

export interface TaskSubject {
  /** The deliverable itself, a review of it, or a fix applied to it. */
  kind: 'deliverable' | 'review' | 'fix';
  /** The deliverable task: this task, or the one this run belongs to. */
  deliverableTaskId: string;
}

const FIX_ROLES = new Set(['fix', 'ci_fix', 'conflict_fix']);

/**
 * The delivery's own record says what this run is (`tasks.delivery_role`);
 * without one (legacy-owned, no PR yet) a reviewer's `context.reviewerFor`, or
 * a retry column (`retryOf`), does.
 */
export function taskSubjectOf(p: {
  taskId: string;
  view: Pick<DeliveryView, 'ownerTaskId' | 'history'> | null;
  context: Record<string, unknown> | null | undefined;
  parentTaskId: string | null | undefined;
  /** The task carries a reviewer/CI/conflict retry column. */
  retryOf?: boolean;
}): TaskSubject {
  if (p.view && p.view.ownerTaskId !== p.taskId) {
    const role = p.view.history.find(h => h.taskId === p.taskId)?.role;
    if (role === 'review') return { kind: 'review', deliverableTaskId: p.view.ownerTaskId };
    if (role && FIX_ROLES.has(role)) return { kind: 'fix', deliverableTaskId: p.view.ownerTaskId };
  }
  if (p.view?.ownerTaskId === p.taskId) return { kind: 'deliverable', deliverableTaskId: p.taskId };
  const reviewerFor = p.context?.reviewerFor;
  if (typeof reviewerFor === 'string' && reviewerFor) return { kind: 'review', deliverableTaskId: reviewerFor };
  if (p.retryOf && p.parentTaskId) return { kind: 'fix', deliverableTaskId: p.parentTaskId };
  return { kind: 'deliverable', deliverableTaskId: p.taskId };
}
