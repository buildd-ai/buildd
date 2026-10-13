import { db } from '@buildd/core/db';
import { specRevisions, specs } from '@buildd/core/db/schema';
import { and, eq } from 'drizzle-orm';
import { isUuid } from '@/lib/uuid';
import { reach } from './store';
import { specApprover } from './approval';
import { verifySpecApprovalRequest } from './approval-request';
import { diffSpecBodies, diffSpecHunks, diffSpecRevisions, type DiffHunk, type SectionChange } from './diff';
import { getSpec } from './store';
import { repoCopyPreflight, type RepoCopyPreflight } from './repo-copy';

/**
 * What the confirm page (/app/specs/[specId]/approve) shows a signed-in person
 * for an approval request made over MCP or chat. The page only reads; the
 * approval happens in confirmSpecApproval when the person presses Approve.
 */
export type ApprovalRequestView =
  | { state: 'invalid' | 'expired' | 'not_found' }
  | { state: 'not_approver' | 'stale' | 'approved'; title: string; revision: number }
  | {
    state: 'ready';
    title: string;
    revision: number;
    /** The approved revision this one replaces; null when nothing is approved yet. */
    replaces: number | null;
    sections: SectionChange[];
    /** The changed sections as numbered rows (lib/specs/diff.ts, same caps as the text diff). */
    hunks: DiffHunk[];
    omittedLines: number;
    /** The whole revision being approved, Markdown (at most the 200k body cap). */
    body: string;
    /** The repo checks on the would-be repo copy (living-specs.md §18, R-34); null when the workspace has not opted in. */
    preflight?: RepoCopyPreflight | null;
  };

export async function approvalRequestView(userId: string, specId: string, token: string | null | undefined): Promise<ApprovalRequestView> {
  const v = verifySpecApprovalRequest(token);
  if (!v.ok) return { state: v.reason === 'expired' ? 'expired' : 'invalid' };
  const req = v.payload;
  if (!isUuid(specId) || req.specId !== specId) return { state: 'invalid' };
  const caller = { kind: 'user' as const, userId };
  const [spec] = await db.select().from(specs).where(eq(specs.id, specId)).limit(1);
  if (!spec || !(await reach(caller, spec.workspaceId, false))) return { state: 'not_found' };
  if (spec.workspaceId !== req.workspaceId) return { state: 'invalid' };
  const base = { title: spec.title, revision: req.revision };
  if (!(await specApprover(caller, spec.workspaceId))) return { state: 'not_approver', ...base };
  const [rev] = await db.select().from(specRevisions)
    .where(and(eq(specRevisions.specId, specId), eq(specRevisions.revision, req.revision))).limit(1);
  if (!rev || rev.contentHash !== req.contentHash) return { state: 'stale', ...base };
  if (spec.approvedRevision === req.revision && rev.approvedAt) return { state: 'approved', ...base };
  if (spec.version !== req.expectedVersion || spec.headRevision !== req.revision) return { state: 'stale', ...base };

  const preflight = await repoCopyPreflight(spec, req.revision).then((p) => (p.state === 'off' ? null : p)).catch(() => null);
  if (spec.approvedRevision) {
    const d = await diffSpecRevisions(caller, specId, { from: spec.approvedRevision, to: req.revision, rows: true });
    if (!d.ok || d.diff.toBody === undefined) return { state: 'stale', ...base };
    return { state: 'ready', ...base, replaces: spec.approvedRevision, sections: d.diff.sections, hunks: d.diff.hunks ?? [], omittedLines: d.diff.omittedLines, body: d.diff.toBody, preflight };
  }
  // Nothing approved yet: the whole revision is what comes into force.
  const s = await getSpec(caller, specId, { revision: req.revision });
  if (!s.ok || typeof s.view.body !== 'string') return { state: 'stale', ...base };
  const d = diffSpecBodies('', s.view.body);
  const h = diffSpecHunks('', s.view.body);
  return { state: 'ready', ...base, replaces: null, sections: d.sections, hunks: h.hunks, omittedLines: h.omittedLines, body: s.view.body, preflight };
}
