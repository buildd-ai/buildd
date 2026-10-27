/**
 * The PR activity comment as a projection (docs/specs/workflow-state-kernel.md
 * §12.1; Living Spec fa62b865 §11.3, R-50 and R-51). Pure: the body is computed
 * from the delivery and its `workflow_transitions` history, never appended to.
 *
 *  - One state line and "Open in Buildd", edited in place: the delivery's review
 *    reading (`DeliveryView.review.stateLine`), the same words the task page, get_pr
 *    and explain show. No timeline, no findings, no rounds line and no escalation
 *    prose: those live in Buildd. GitHub carries a review only for new code findings.
 *  - The line is a pure function of canonical state (`deriveDeliveryView`), so
 *    "Approved" can never head a REPAIRING delivery and "Merged" stays the line
 *    whatever is recorded after it.
 *  - The body carries a `render_version` marker; a render older than the marker
 *    already on GitHub is skipped by the handler.
 */
import { renderStateLineComment, taskActivityUrl, type ActivityHeader } from '@/lib/pr-activity-comment';
import { deriveDeliveryView } from './projections';
import type { DeliveryState, KernelView } from './types';

export interface ActivityTransition {
  command: string;
  fromState: string | null;
  toState: string;
  toVersion: number;
  evidence: Record<string, unknown> | null;
  createdAt: string;
}

export const RENDER_VERSION_PREFIX = '<!-- buildd-render-version:';
const RENDER_VERSION_RE = /<!-- buildd-render-version:(\d+) -->/;

export function renderVersionMarker(version: number): string {
  return `${RENDER_VERSION_PREFIX}${version} -->`;
}

/** The delivery version a comment body was rendered from, or null for a legacy/foreign body. */
export function parseRenderVersion(body: string): number | null {
  const m = RENDER_VERSION_RE.exec(body);
  return m ? Number(m[1]) : null;
}

type HeaderTone = ActivityHeader['tone'];

function toneFor(state: DeliveryState, reviewing: boolean): HeaderTone {
  switch (state) {
    case 'WORKING':
    case 'FIXING': return 'working';
    case 'AWAITING_REVIEW': return reviewing ? 'working' : 'waiting';
    case 'ESCALATED': return 'human';
    case 'APPROVED':
    case 'MERGED':
    case 'SUPERSEDED': return 'done';
    case 'CLOSED_UNMERGED':
    case 'ABANDONED':
    case 'FAILED': return 'ended';
    default: return 'waiting';
  }
}

/**
 * Whether the owner's latest attempt move in WORKING put its task back in the
 * queue (a requeue, a loop hold, a reopen to pending) rather than starting it.
 * The comment has no task row, so this reads the transitions.
 */
export function ownerParkedIn(transitions: ActivityTransition[]): boolean {
  const latest = [...transitions]
    .filter((t) => t.toState === 'WORKING')
    .sort((a, b) => b.toVersion - a.toVersion)
    .find((t) => t.command === 'AttemptStarted' || t.command === 'AttemptRequeued' || t.command === 'AttemptReopened'
      || (t.command === 'AttemptEnded' && t.evidence?.requeue === true));
  if (!latest) return false;
  if (latest.command === 'AttemptStarted') return false;
  if (latest.command === 'AttemptReopened') return latest.evidence?.to === 'pending';
  return true;
}

/** The whole comment body for one delivery at its current version: one state line (R-51). */
export function renderDeliveryActivity(p: {
  view: KernelView;
  transitions: ActivityTransition[];
  timezone?: string;
}): string {
  const d = p.view.delivery;
  if (!d) throw new Error('renderDeliveryActivity: no delivery');
  const last = [...p.transitions].sort((a, b) => b.toVersion - a.toVersion)[0];
  const ownerParked = d.state === 'WORKING' && ownerParkedIn(p.transitions);
  const dv = deriveDeliveryView({
    view: p.view,
    lastTransition: last ? { command: last.command, fromState: last.fromState, toState: last.toState, evidence: last.evidence, createdAt: last.createdAt } : null,
    ownerParked,
  });
  const currentRound = p.view.rounds.find((r) => r.round === d.currentRound);
  const header: ActivityHeader = {
    headline: dv?.review.stateLine ?? d.state,
    tone: ownerParked ? 'waiting' : toneFor(d.state, currentRound?.status === 'reviewing'),
  };
  // The delivery's start is its first transition (the PR binding).
  const startedAt = [...p.transitions].sort((a, b) => a.toVersion - b.toVersion)[0]?.createdAt ?? null;
  const body = renderStateLineComment({ header, url: d.ownerTaskId ? taskActivityUrl(d.ownerTaskId) : null, startedAt, timezone: p.timezone });
  return `${body}\n${renderVersionMarker(d.version)}`;
}
