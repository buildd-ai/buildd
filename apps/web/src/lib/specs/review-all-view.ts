import { listAwaitingApproval, type AwaitingApprovalRow } from './approval-inbox';
import { rowCoverage } from './approval-row-coverage';
import { signSpecApprovalRequest } from './approval-request';
import { filterByTier, type RiskFilter, type RiskTier } from '@buildd/spec-contract/risk-tier';
import { diffSpecHunks, diffSpecRevisions, type DiffHunk } from './diff';
import { getSpec } from './store';
import { shippedStandings } from './matches-shipped-store';
import type { ShippedStanding } from './matches-shipped';

/** Rows past this are counted and left to the inbox, so the page stays one read. */
export const REVIEW_ALL_ROWS = 30;

export interface ReviewAllRow extends Pick<AwaitingApprovalRow, 'specId' | 'title' | 'workspaceName' | 'headRevision' | 'approvedRevision' | 'revisionsCovered' | 'author' | 'tier' | 'tierReasons'> {
  /** Explanation coverage approved-to-head against the head's explanation (R-30); null when unreadable. */
  coverage: string | null;
  /** One sentence on what changes: the explanation's summary, else the change summary; null when neither was written. */
  summary: string | null;
  /** True when `summary` is the author's question rather than a summary. */
  isQuestion: boolean;
  /**
   * The signed request Approve all confirms for exactly this revision, pinned
   * to the spec, revision, version and content hash read now; null when the
   * deployment cannot sign one (Approve all is then off).
   */
  request: string | null;
  /** The revision against its approved revision (the whole body when none is), as numbered rows. Null when it cannot be read. */
  diff: { hunks: DiffHunk[]; omittedLines: number; linesAdded: number; linesRemoved: number } | null;
  /** What the merged work shows against the head's criteria (R-34); null when nothing merged or it could not be read. */
  shipped: ShippedStanding | null;
}

/** The one line a Review all row shows: the author's question when there is one, in place of the summary. */
export function reviewAllSummary(r: Pick<AwaitingApprovalRow, 'question' | 'explanationSummary' | 'changeSummary'>): string | null {
  return r.question ?? r.explanationSummary ?? r.changeSummary?.trim() ?? null;
}

/**
 * The Review all page (Living Spec b7fc9316 R-24, R-25): the inbox's own list
 * (R-1), so a revision the no-criteria-change check approved is not on it,
 * each with its one-line summary, its diff and its own signed request. Built
 * from the person's id alone; nothing here approves.
 */
export async function reviewAllView(userId: string, filter: RiskFilter = 'all', now = Date.now()): Promise<{ rows: ReviewAllRow[]; more: number; counts: Record<RiskTier, number>; filter: RiskFilter }> {
  const everything = await listAwaitingApproval(userId);
  const counts = { high: 0, medium: 0, low: 0 } satisfies Record<RiskTier, number>;
  for (const r of everything) counts[r.tier]++;
  // R-33: the filter narrows what is listed, so Approve all (which sends one request per listed row) acts only within it.
  const all = filterByTier(everything, filter);
  const caller = { kind: 'user' as const, userId };
  const shown = all.slice(0, REVIEW_ALL_ROWS);
  const shipped = await shippedStandings(shown);
  const rows = await Promise.all(shown.map(async (r): Promise<ReviewAllRow> => ({
    shipped: shipped.get(r.specId) ?? null,
    specId: r.specId, title: r.title, workspaceName: r.workspaceName, headRevision: r.headRevision, approvedRevision: r.approvedRevision, revisionsCovered: r.revisionsCovered, author: r.author, tier: r.tier, tierReasons: r.tierReasons, coverage: await rowCoverage(r), summary: reviewAllSummary(r),
    isQuestion: r.question != null,
    request: signSpecApprovalRequest({
      specId: r.specId, workspaceId: r.workspaceId, revision: r.headRevision, expectedVersion: r.version, contentHash: r.contentHash,
      requestedBy: userId, via: 'dashboard',
    }, now),
    diff: await rowDiff(caller, r).catch(() => null),
  })));
  return { rows, more: Math.max(0, all.length - REVIEW_ALL_ROWS), counts, filter };
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
