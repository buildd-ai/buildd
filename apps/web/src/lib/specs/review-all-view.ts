import { listAwaitingApproval, type AwaitingApprovalRow } from './approval-inbox';
import { signSpecApprovalRequest } from './approval-request';
import { diffSpecHunks, diffSpecRevisions, type DiffHunk } from './diff';
import { getSpec } from './store';

/** Rows past this are counted and left to the inbox, so the page stays one read. */
export const REVIEW_ALL_ROWS = 30;

export interface ReviewAllRow extends Pick<AwaitingApprovalRow, 'specId' | 'title' | 'workspaceName' | 'headRevision' | 'approvedRevision' | 'author'> {
  /** One sentence on what changes: the explanation's summary, else the change summary; null when neither was written. */
  summary: string | null;
  /**
   * The signed request Approve all confirms for exactly this revision, pinned
   * to the spec, revision, version and content hash read now; null when the
   * deployment cannot sign one (Approve all is then off).
   */
  request: string | null;
  /** The revision against its approved revision (the whole body when none is), as numbered rows. Null when it cannot be read. */
  diff: { hunks: DiffHunk[]; omittedLines: number; linesAdded: number; linesRemoved: number } | null;
}

/**
 * The Review all page (Living Spec b7fc9316 R-24, R-25): the inbox's own list
 * (R-1), so a revision the no-criteria-change check approved is not on it,
 * each with its one-line summary, its diff and its own signed request. Built
 * from the person's id alone; nothing here approves.
 */
export async function reviewAllView(userId: string, now = Date.now()): Promise<{ rows: ReviewAllRow[]; more: number }> {
  const all = await listAwaitingApproval(userId);
  const caller = { kind: 'user' as const, userId };
  const rows = await Promise.all(all.slice(0, REVIEW_ALL_ROWS).map(async (r): Promise<ReviewAllRow> => ({
    specId: r.specId, title: r.title, workspaceName: r.workspaceName, headRevision: r.headRevision, approvedRevision: r.approvedRevision, author: r.author,
    summary: r.explanationSummary ?? r.changeSummary?.trim() ?? null,
    request: signSpecApprovalRequest({
      specId: r.specId, workspaceId: r.workspaceId, revision: r.headRevision, expectedVersion: r.version, contentHash: r.contentHash,
      requestedBy: userId, via: 'dashboard',
    }, now),
    diff: await rowDiff(caller, r).catch(() => null),
  })));
  return { rows, more: Math.max(0, all.length - REVIEW_ALL_ROWS) };
}

async function rowDiff(caller: { kind: 'user'; userId: string }, r: AwaitingApprovalRow): Promise<ReviewAllRow['diff']> {
  const count = (hunks: DiffHunk[]) => ({ linesAdded: hunks.reduce((n, h) => n + h.linesAdded, 0), linesRemoved: hunks.reduce((n, h) => n + h.linesRemoved, 0) });
  if (r.approvedRevision != null) {
    const d = await diffSpecRevisions(caller, r.specId, { from: r.approvedRevision, to: r.headRevision, rows: true });
    if (!d.ok || d.diff.to.contentHash !== r.contentHash) return null;
    const hunks = d.diff.hunks ?? [];
    return { hunks, omittedLines: d.diff.omittedLines, ...count(hunks) };
  }
  // Nothing approved yet: the whole revision is what comes into force.
  const s = await getSpec(caller, r.specId, { revision: r.headRevision });
  if (!s.ok || typeof s.view.body !== 'string') return null;
  const h = diffSpecHunks('', s.view.body);
  return { hunks: h.hunks, omittedLines: h.omittedLines, ...count(h.hunks) };
}
