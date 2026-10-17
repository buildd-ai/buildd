/**
 * The review and repair readings every surface prints
 * (docs/specs/workflow-kernel-library.md §7). Pure, client-safe.
 *
 * `get_pr`, the task page and the PR activity comment all say how many review
 * rounds a delivery has had, what the latest one decided and how many findings
 * are still open. They read it here, from the delivery's review rounds and
 * findings, so the three can never disagree, and none of them reads it from
 * GitHub reviews or legacy reviewer task rows.
 *
 * A repair (a CI, review, conflict or migration fix attempt) reads its phase
 * from the attempt's own facts and the delivery it belongs to: queued,
 * running, awaiting push, pushed and testing, awaiting review, pushed, or no
 * change. "Completed" is never a phase: an attempt that ended has either put a
 * commit on the PR or it has not.
 */
import { isOpenFinding } from './findings';
import type { PrDisplayState } from './pr-display';
import type { AttemptSnapshot, DeliveryState, FindingSnapshot, RoundSnapshot, Verdict } from './types';

export interface ReviewSummary {
  /** Rounds a reviewer was asked to read (a round superseded before it ran is not one). */
  rounds: number;
  /** The newest such round's number. */
  latestRound: number | null;
  /** The newest decided round's verdict (effective, when the kernel adjusted it). */
  latestVerdict: Verdict | null;
  /** The newest round is still queued or being reviewed. */
  inFlight: boolean;
  /** Being read by a reviewer now, rather than waiting for one. */
  reviewing?: boolean;
  /** Findings still open (`open` or `addressed`), required or not. */
  openFindings: number;
  /** Of those, how many a push already touched (`addressed`, AC-17): a fix waiting for a re-review. Absent when none. */
  addressedFindings?: number;
  totalFindings: number;
}

/** Null when the delivery has had no review round. */
export function reviewSummaryOf(v: { rounds: readonly RoundSnapshot[]; findings?: readonly FindingSnapshot[] | null }): ReviewSummary | null {
  const rounds = [...(v.rounds ?? [])].filter((r) => r.status !== 'superseded').sort((a, b) => a.round - b.round);
  if (rounds.length === 0) return null;
  const latest = rounds[rounds.length - 1]!;
  const decided = [...rounds].reverse().find((r) => r.status === 'decided' && (r.effectiveVerdict ?? r.verdict));
  const findings = v.findings ?? [];
  return {
    rounds: rounds.length,
    latestRound: latest.round,
    latestVerdict: decided ? (decided.effectiveVerdict ?? decided.verdict) : null,
    inFlight: latest.status === 'queued' || latest.status === 'reviewing',
    ...(latest.status === 'reviewing' ? { reviewing: true } : {}),
    openFindings: findings.filter(isOpenFinding).length,
    ...(findings.some((f) => f.status === 'addressed') ? { addressedFindings: findings.filter((f) => f.status === 'addressed').length } : {}),
    totalFindings: findings.length,
  };
}

const VERDICT_WORDS: Record<Verdict, string> = {
  approve: 'approved',
  request_changes: 'changes requested',
  escalate: 'handed to a person',
};

/** "2 rounds · latest: changes requested · 1 open finding". Each surface adds its own label in front. */
export function reviewSummaryLine(s: ReviewSummary): string {
  const parts = [`${s.rounds} ${s.rounds === 1 ? 'round' : 'rounds'}`];
  if (s.latestVerdict) parts.push(`latest: ${VERDICT_WORDS[s.latestVerdict]}`);
  if (s.inFlight && s.latestRound != null) parts.push(`round ${s.latestRound} ${s.reviewing ? 'in review' : 'queued'}`);
  const waiting = s.addressedFindings ? `, ${s.addressedFindings} with a fix waiting for a re-review` : '';
  parts.push(s.openFindings === 0 ? 'no open findings' : `${s.openFindings} open ${s.openFindings === 1 ? 'finding' : 'findings'}${waiting}`);
  return parts.join(' · ');
}

export type RepairPhase =
  | 'queued' | 'running' | 'awaiting_push' | 'pushed_testing' | 'awaiting_review' | 'pushed'
  | 'no_change' | 'failed' | 'cancelled' | 'ended';

/** Lower-case words, so a surface can put them after a label ("CI fix 1 of 3 · pushed · testing"). */
export const REPAIR_PHASE_WORDS: Record<RepairPhase, string> = {
  queued: 'queued',
  running: 'running',
  awaiting_push: 'waiting for the push to reach GitHub',
  pushed_testing: 'pushed · testing',
  awaiting_review: 'pushed · awaiting review',
  pushed: 'pushed',
  no_change: 'no change',
  failed: 'failed',
  cancelled: 'cancelled',
  ended: 'ended',
};

export interface RepairPhaseDelivery {
  state: DeliveryState;
  headSha: string | null;
  prState: PrDisplayState | null;
  rounds: readonly RoundSnapshot[];
}

/** The head an attempt put on the PR: the proven push, else the last commit it reported. */
function pushedHead(a: AttemptSnapshot): string | null {
  return a.pushedHeadSha ?? (a.reportedShas.length ? a.reportedShas[a.reportedShas.length - 1]! : null);
}

export function repairPhaseOf(a: AttemptSnapshot, d: RepairPhaseDelivery): RepairPhase {
  switch (a.status) {
    case 'queued': return 'queued';
    case 'running': return 'running';
    case 'skipped':
    case 'cancelled': return 'cancelled';
    case 'ended': break;
  }
  switch (a.outcome) {
    case 'failed': return 'failed';
    case 'noop': return 'no_change';
    // It ended with commits GitHub does not show yet: the platform is recovering the push.
    case 'unproven': return d.state === 'AWAITING_PUSH' ? 'awaiting_push' : 'no_change';
    case 'delivered': {
      const head = pushedHead(a);
      if (!head || head !== d.headSha) return 'pushed';
      if (d.prState === 'awaiting_ci' || d.prState === 'ci_running') return 'pushed_testing';
      const onHead = d.rounds.find((r) => r.headSha === head && (r.status === 'queued' || r.status === 'reviewing'));
      return onHead ? 'awaiting_review' : 'pushed';
    }
    default: return d.state === 'AWAITING_PUSH' ? 'awaiting_push' : 'ended';
  }
}
