import { db } from '@buildd/core/db';
import { specRevisions, specs } from '@buildd/core/db/schema';
import { and, eq } from 'drizzle-orm';
import { isUuid } from '@/lib/uuid';
import { personReach, reach } from './store';
import { specApprover } from './approval';
import { verifySpecApprovalRequest } from './approval-request';
import { diffSpecBodies, diffSpecHunks, diffSpecRevisions, type DiffHunk, type SectionChange } from './diff';
import { getSpec } from './store';
import { nativeSourceOn } from './repo-copy';
import { attachmentSources, type AttachmentSource } from './attachments';
import { liveReplaced } from './replaces';
import { runApprovalGate } from './approval-gate';
import type { SpecGateResult } from '@buildd/core/db/schema';
import type { RevisionReview } from './revision-changes';
import { explanationCoverage, sectionWordChanges, type ExplanationCoverage, type SpecExplanation } from '@buildd/spec-contract/explanation';
import type { WordOp } from '@buildd/spec-contract/criterion-review';

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
    /** What an Approve here is pinned to, as read now. */
    pin: ApprovalPin;
    /** The approved revision this one replaces; null when nothing is approved yet. */
    replaces: number | null;
    sections: SectionChange[];
    /** The changed sections as numbered rows (lib/specs/diff.ts, same caps as the text diff). */
    hunks: DiffHunk[];
    omittedLines: number;
    /** The whole revision being approved, Markdown (at most the 200k body cap). */
    body: string;
    /**
     * The workspace writes repo copies, so the page shows the repo checks on
     * the would-be copy (living-specs.md §18, R-34). They ask GitHub, so the
     * page fetches them after it shows (spec 3ef37387 R-14), never here.
     */
    repoChecks?: boolean;
    /** What `attachment:<name>` resolves to on the revision being approved (§21). */
    attachments?: Record<string, AttachmentSource>;
    /**
     * The live specs the revision replaces (R-77), each "Retire it" checked as
     * the link's choice says (all, for a link made before the choice existed),
     * at the version the link read, so one that moved since reports stale.
     */
    replacing: Array<{ id: string; title: string; version: number; checked: boolean }>;
    /** The quality gate now: refusals need a reason to approve anyway, warnings are shown. */
    gate: SpecGateResult;
    /** What the revision changes, by criterion (the Review change list); null when it cannot be read. */
    changes: Pick<RevisionReview, 'summary' | 'lines' | 'otherText' | 'mismatch'> | null;
    /** What the revision's author says it changes (b7fc9316 R-15), as stored with the revision; null when none was given. */
    explanation: SpecExplanation | null;
    /** The explanation checked against `changes` (R-16), no model; null when the change list cannot be read. */
    coverage: ExplanationCoverage | null;
    /** Each changed section's words outside the criteria (R-17), keyed by heading path. */
    sectionWords: Record<string, WordOp[]>;
  };

export async function approvalRequestView(userId: string, specId: string, token: string | null | undefined): Promise<ApprovalRequestView> {
  const v = verifySpecApprovalRequest(token);
  if (!v.ok) return { state: v.reason === 'expired' ? 'expired' : 'invalid' };
  const req = v.payload;
  if (!isUuid(specId) || req.specId !== specId) return { state: 'invalid' };
  return approvalPinView(userId, specId, req, { workspaceId: req.workspaceId, retire: req.retire });
}

/** What an Approve is pinned to: the revision, the spec version and the body's hash, as shown. */
export interface ApprovalPin { revision: number; expectedVersion: number; contentHash: string }

/**
 * The confirm view for one pinned revision, with or without a request token
 * (an inbox row has none, Living Spec b7fc9316 R-2): the person may approve
 * here, the revision's body still has that hash, and the spec has not moved.
 * `workspaceId`, when a token named one, must be the spec's. `retire`: the
 * link's choice of replaced specs (R-77); none, all of them checked.
 */
export async function approvalPinView(userId: string, specId: string, pin: ApprovalPin, opts: { workspaceId?: string; retire?: ReadonlyArray<{ specId: string; expectedVersion?: number }> } = {}): Promise<ApprovalRequestView> {
  if (!isUuid(specId)) return { state: 'not_found' };
  const caller = { kind: 'user' as const, userId };
  const [spec] = await db.select().from(specs).where(eq(specs.id, specId)).limit(1);
  if (!spec || !(await reach(caller, spec.workspaceId, false))) return { state: 'not_found' };
  if (opts.workspaceId && spec.workspaceId !== opts.workspaceId) return { state: 'invalid' };
  const base = { title: spec.title, revision: pin.revision };
  if (!(await specApprover(caller, spec.workspaceId))) return { state: 'not_approver', ...base };
  const [rev] = await db.select().from(specRevisions)
    .where(and(eq(specRevisions.specId, specId), eq(specRevisions.revision, pin.revision))).limit(1);
  if (!rev || rev.contentHash !== pin.contentHash) return { state: 'stale', ...base };
  if (spec.approvedRevision === pin.revision && rev.approvedAt) return { state: 'approved', ...base };
  if (spec.version !== pin.expectedVersion || spec.headRevision !== pin.revision) return { state: 'stale', ...base };

  const repoChecks = nativeSourceOn({ livingSpecs: (await personReach(userId, spec.workspaceId))?.livingSpecs });
  const [attachments, { gate, review }] = await Promise.all([
    attachmentSources(specId, pin.revision).catch(() => ({})),
    runApprovalGate(spec, pin.revision),
  ]);
  const replacing = (await liveReplaced(spec.workspaceId, rev.replaces)).map((r) => {
    const chosen = opts.retire?.find((c) => c.specId === r.id);
    return { id: r.id, title: r.title, version: chosen?.expectedVersion ?? r.version, checked: opts.retire ? !!chosen : true };
  });
  const changes = review ? { summary: review.summary, lines: review.lines, otherText: review.otherText, mismatch: review.mismatch } : null;
  const explanation = rev.explanation ?? null;
  const coverage = changes ? explanationCoverage(explanation, changes.lines, changes.otherText) : null;
  const ready = { ...base, pin: { revision: pin.revision, expectedVersion: pin.expectedVersion, contentHash: pin.contentHash }, repoChecks, attachments, gate, changes, explanation, coverage };
  if (spec.approvedRevision) {
    const d = await diffSpecRevisions(caller, specId, { from: spec.approvedRevision, to: pin.revision, rows: true });
    if (!d.ok || d.diff.toBody === undefined) return { state: 'stale', ...base };
    const sectionWords = changes ? sectionWordChanges(d.diff.fromBody ?? '', d.diff.toBody, changes.otherText) : {};
    return { state: 'ready', ...ready, sectionWords, replaces: spec.approvedRevision, sections: d.diff.sections, hunks: d.diff.hunks ?? [], omittedLines: d.diff.omittedLines, body: d.diff.toBody, replacing };
  }
  // Nothing approved yet: the whole revision is what comes into force.
  const s = await getSpec(caller, specId, { revision: pin.revision });
  if (!s.ok || typeof s.view.body !== 'string') return { state: 'stale', ...base };
  const d = diffSpecBodies('', s.view.body);
  const h = diffSpecHunks('', s.view.body);
  const sectionWords = changes ? sectionWordChanges('', s.view.body, changes.otherText) : {};
  return { state: 'ready', ...ready, sectionWords, replaces: null, sections: d.sections, hunks: h.hunks, omittedLines: h.omittedLines, body: s.view.body, replacing };
}
