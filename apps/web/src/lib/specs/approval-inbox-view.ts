import { listAwaitingApproval, type AwaitingApprovalRow } from './approval-inbox';
import type { RevisionRisk } from './revision-risk';
import { rowCoverage } from './approval-row-coverage';
import { approvalPinView, type ApprovalRequestView } from './approval-view';
import { shippedStandings } from './matches-shipped-store';
import type { ShippedStanding } from './matches-shipped';

/** Rows past this show their line and a link to the spec, not the full review. */
export const INBOX_DETAILED_ROWS = 20;

export interface InboxRow extends AwaitingApprovalRow {
  /** The confirm view, pinned to this row's revision, version and hash; null past INBOX_DETAILED_ROWS. */
  view: ApprovalRequestView | null;
  /** Needs judgement or low-risk. Unreadable or unclassified rows say judgement. */
  risk: RevisionRisk;
  /** What the merged work shows against the head's criteria (R-34); null when nothing merged or it could not be read. */
  shipped: ShippedStanding | null;
  /** Explanation coverage approved-to-head against the head's explanation (R-30); null when unreadable. */
  coverage: string | null;
}

const UNKNOWN_RISK: RevisionRisk = { level: 'judgement', reasons: ['Could not be compared with the approved revision'] };

/** Judgement rows first, low-risk after; each group keeps the incoming (newest-first) order. Never drops or approves a row. */
export function sortByRisk<T extends { risk: RevisionRisk }>(rows: readonly T[]): T[] {
  return [...rows.filter((r) => r.risk.level === 'judgement'), ...rows.filter((r) => r.risk.level !== 'judgement')];
}

/**
 * The Awaiting your approval page (Living Spec b7fc9316 R-1, R-2): every row
 * waiting on this person, each opened onto what the confirm page shows,
 * pinned to what the page renders now. Built from the person's id alone.
 */
export async function approvalInboxView(userId: string): Promise<InboxRow[]> {
  const rows = await listAwaitingApproval(userId);
  const shipped = await shippedStandings(rows);
  const built = await Promise.all(rows.map(async (r, i): Promise<InboxRow> => {
    const coverage = await rowCoverage(r);
    const view = i < INBOX_DETAILED_ROWS
      ? await approvalPinView(userId, r.specId, { revision: r.headRevision, expectedVersion: r.version, contentHash: r.contentHash }).catch(() => null)
      : null;
    return { ...r, shipped: shipped.get(r.specId) ?? null, view, coverage, risk: (view?.state === 'ready' && view.risk) || UNKNOWN_RISK };
  }));
  return sortByRisk(built);
}

/**
 * The Other drafts lane (b7fc9316 R-38): waiting revisions of every kind but
 * `contract`, one line each with a link to the spec. No approve control here:
 * nothing in this lane blocks a build or a merge.
 */
export async function otherDraftsView(userId: string): Promise<AwaitingApprovalRow[]> {
  return listAwaitingApproval(userId, 'other');
}
