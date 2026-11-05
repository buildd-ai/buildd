import { listAwaitingApproval, type AwaitingApprovalRow } from './approval-inbox';
import { rowCoverage } from './approval-row-coverage';
import { approvalPinView, type ApprovalRequestView } from './approval-view';

/** Rows past this show their line and a link to the spec, not the full review. */
export const INBOX_DETAILED_ROWS = 20;

export interface InboxRow extends AwaitingApprovalRow {
  /** The confirm view, pinned to this row's revision, version and hash; null past INBOX_DETAILED_ROWS. */
  view: ApprovalRequestView | null;
  /** Explanation coverage approved-to-head against the head's explanation (R-30); null when unreadable. */
  coverage: string | null;
}

/**
 * The Awaiting your approval page (Living Spec b7fc9316 R-1, R-2): every row
 * waiting on this person, each opened onto what the confirm page shows,
 * pinned to what the page renders now. Built from the person's id alone.
 */
export async function approvalInboxView(userId: string): Promise<InboxRow[]> {
  const rows = await listAwaitingApproval(userId);
  return Promise.all(rows.map(async (r, i) => ({
    ...r,
    coverage: await rowCoverage(r),
    view: i < INBOX_DETAILED_ROWS
      ? await approvalPinView(userId, r.specId, { revision: r.headRevision, expectedVersion: r.version, contentHash: r.contentHash }).catch(() => null)
      : null,
  })));
}
