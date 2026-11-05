import { listAwaitingApproval, type AwaitingApprovalRow } from './approval-inbox';
import type { RevisionRisk } from './revision-risk';
import { approvalPinView, type ApprovalRequestView } from './approval-view';

/** Rows past this show their line and a link to the spec, not the full review. */
export const INBOX_DETAILED_ROWS = 20;

export interface InboxRow extends AwaitingApprovalRow {
  /** The confirm view, pinned to this row's revision, version and hash; null past INBOX_DETAILED_ROWS. */
  view: ApprovalRequestView | null;
  /** Needs judgement or low-risk. Unreadable or unclassified rows say judgement. */
  risk: RevisionRisk;
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
  const built = await Promise.all(rows.map(async (r, i): Promise<InboxRow> => {
    const view = i < INBOX_DETAILED_ROWS
      ? await approvalPinView(userId, r.specId, { revision: r.headRevision, expectedVersion: r.version, contentHash: r.contentHash }).catch(() => null)
      : null;
    return { ...r, view, risk: (view?.state === 'ready' && view.risk) || UNKNOWN_RISK };
  }));
  return sortByRisk(built);
}
