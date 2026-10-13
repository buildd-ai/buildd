import { createHash } from 'node:crypto';
import { db } from '@buildd/core/db';
import { specComments, specRevisions, specs } from '@buildd/core/db/schema';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { outlineOf } from '@buildd/core/artifact-read';
import { requirementIds } from '@buildd/spec-contract/requirements';
import { isUuid } from '@/lib/uuid';
import { author, fail, getSpec, reach, type SpecCaller, type SpecError } from './store';
import { findSection } from './section-revise';

/**
 * Comments on a spec revision (Living Specs R-26, docs/specs/living-specs.md
 * §16). A comment anchors to one section (by outline id, found again on a
 * later revision by its heading) or one criterion (by id), and records a hash
 * of the anchored text. Read on a revision, a comment made on it or an earlier
 * one is `open` when its anchor's text is unchanged, `outdated` when the
 * anchor changed or is gone, `resolved` once a person resolved it. A comment
 * made on a later revision is not shown on an earlier one. Nothing here
 * writes the spec: comments never move the body, the hash or an approval.
 */

export const MAX_COMMENT_CHARS = 4000;

export type AnchorKind = 'section' | 'criterion';
export type CommentState = 'open' | 'outdated' | 'resolved';

export interface CommentView {
  id: string;
  anchor: { kind: AnchorKind; id: string; label: string };
  /** The anchor on the revision being read: a section's outline id there, or the criterion id; null when it is gone. */
  anchorHere: string | null;
  body: string;
  author: { kind: 'user' | 'agent'; id: string };
  madeOnRevision: number;
  parentCommentId: string | null;
  state: CommentState;
  resolvedBy: string | null;
  createdAt: string;
}

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

type Anchored = { id: string; label: string; text: string };

/** The anchor's text in `body`: a section's span, or a criterion's definition line. */
export function locateAnchor(body: string, kind: AnchorKind, ref: { id?: string; label?: string }): Anchored | null {
  if (kind === 'criterion') {
    const id = ref.id ?? ref.label;
    const c = requirementIds(body).find((r) => r.id === id && (r.kind === 'requirement' || r.kind === 'acceptance'));
    return c ? { id: c.id, label: c.id, text: c.text } : null;
  }
  const outline = outlineOf(body);
  const byId = ref.id ? outline.find((s) => s.id === ref.id) : undefined;
  // On another revision outline ids shift; a heading used once still names the section.
  const byLabel = !byId && ref.label ? outline.filter((s) => s.title === ref.label) : [];
  const s = byId ?? (byLabel.length === 1 ? byLabel[0] : undefined);
  return s ? { id: s.id, label: s.title, text: body.slice(s.start, s.end) } : null;
}

/** Comment on one section or criterion of a revision (default: the head). */
export async function addSpecComment(caller: SpecCaller, specId: string, input: {
  revision?: unknown; anchor?: unknown; body?: unknown; replyTo?: unknown;
}): Promise<{ ok: true; comment: CommentView } | SpecError> {
  if (!isUuid(specId)) return fail(404, 'Spec not found');
  if (typeof input.body !== 'string' || !input.body.trim()) return fail(400, 'body (the comment) is required');
  if (input.body.length > MAX_COMMENT_CHARS) return fail(400, `a comment is at most ${MAX_COMMENT_CHARS} characters`);
  if (input.revision !== undefined && !Number.isInteger(input.revision)) return fail(400, 'revision must be a revision number');
  const [spec] = await db.select({ workspaceId: specs.workspaceId, headRevision: specs.headRevision }).from(specs).where(eq(specs.id, specId)).limit(1);
  if (!spec || !(await reach(caller, spec.workspaceId, true))) return fail(404, 'Spec not found');
  const n = (input.revision as number | undefined) ?? spec.headRevision;
  const got = await getSpec(caller, specId, { revision: n });
  if (!got.ok) return got;

  const a = (input.anchor && typeof input.anchor === 'object' ? input.anchor : {}) as { section?: unknown; heading?: unknown; criterion?: unknown };
  let kind: AnchorKind;
  let anchored: Anchored | null;
  if (a.criterion !== undefined) {
    if (a.section !== undefined || a.heading !== undefined) return fail(400, 'anchor names either a section or a criterion, not both');
    if (typeof a.criterion !== 'string') return fail(400, 'anchor.criterion must be a criterion id such as AC-2');
    kind = 'criterion';
    anchored = locateAnchor(got.view.body, 'criterion', { id: a.criterion.trim() });
    if (!anchored) return fail(400, `revision ${n} has no criterion ${a.criterion}`);
  } else {
    const found = findSection(got.view.body, { section: a.section, heading: a.heading });
    if (typeof found === 'string') return fail(400, `anchor: ${found}`);
    kind = 'section';
    anchored = { id: found.id, label: found.title, text: got.view.body.slice(found.start, found.end) };
  }

  let parentCommentId: string | null = null;
  if (input.replyTo !== undefined && input.replyTo !== null) {
    if (typeof input.replyTo !== 'string' || !isUuid(input.replyTo)) return fail(400, 'replyTo must be a comment id');
    const [parent] = await db.select({ id: specComments.id, specId: specComments.specId, parentCommentId: specComments.parentCommentId })
      .from(specComments).where(eq(specComments.id, input.replyTo)).limit(1);
    if (!parent || parent.specId !== specId) return fail(400, 'replyTo names no comment on this spec');
    // One level of replies: a reply to a reply joins the same thread.
    parentCommentId = parent.parentCommentId ?? parent.id;
  }

  const who = author(caller);
  const [row] = await db.insert(specComments).values({
    workspaceId: spec.workspaceId, specId, specRevisionId: got.view.revision.id,
    anchorKind: kind, anchorId: anchored.id, anchorLabel: anchored.label, anchorHash: sha(anchored.text),
    body: input.body.trim(), authorKind: who.authorKind, authorId: who.authorId, parentCommentId,
  }).returning();
  return { ok: true, comment: { ...toView(row, n, got.view.body), state: row.resolvedAt ? 'resolved' : 'open' } };
}

function toView(row: typeof specComments.$inferSelect, madeOn: number, bodyHere: string): CommentView {
  const here = locateAnchor(bodyHere, row.anchorKind, { id: row.anchorKind === 'criterion' ? row.anchorId : undefined, label: row.anchorLabel });
  const unchanged = !!here && sha(here.text) === row.anchorHash;
  return {
    id: row.id,
    anchor: { kind: row.anchorKind, id: row.anchorId, label: row.anchorLabel },
    anchorHere: here?.id ?? null,
    body: row.body,
    author: { kind: row.authorKind, id: row.authorId },
    madeOnRevision: madeOn,
    parentCommentId: row.parentCommentId,
    state: row.resolvedAt ? 'resolved' : unchanged ? 'open' : 'outdated',
    resolvedBy: row.resolvedBy,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}

/** The comments readable on revision `revision` (default the head): made on it or earlier, oldest first. */
export async function listSpecComments(caller: SpecCaller, specId: string, opts: { revision?: number } = {}): Promise<{ ok: true; revision: number; comments: CommentView[] } | SpecError> {
  const got = await getSpec(caller, specId, opts.revision !== undefined ? { revision: opts.revision } : {});
  if (!got.ok) return got;
  const n = got.view.revision.revision;
  const revs = await db.select({ id: specRevisions.id, revision: specRevisions.revision }).from(specRevisions).where(eq(specRevisions.specId, specId));
  const upTo = revs.filter((r) => r.revision <= n);
  if (upTo.length === 0) return { ok: true, revision: n, comments: [] };
  const byRev = new Map(upTo.map((r) => [r.id, r.revision]));
  const rows = await db.select().from(specComments)
    .where(and(eq(specComments.specId, specId), inArray(specComments.specRevisionId, [...byRev.keys()])))
    .orderBy(asc(specComments.createdAt));
  return { ok: true, revision: n, comments: rows.map((r) => toView(r, byRev.get(r.specRevisionId)!, got.view.body)) };
}

/** Resolve a comment: a person's act, with write access. Idempotent. */
export async function resolveSpecComment(caller: SpecCaller, specId: string, commentId: string): Promise<{ ok: true; resolvedAt: string } | SpecError> {
  if (!isUuid(specId) || !isUuid(commentId)) return fail(404, 'Comment not found');
  const [row] = await db.select({ id: specComments.id, specId: specComments.specId, workspaceId: specComments.workspaceId, resolvedAt: specComments.resolvedAt })
    .from(specComments).where(eq(specComments.id, commentId)).limit(1);
  if (!row || row.specId !== specId || !(await reach(caller, row.workspaceId, false))) return fail(404, 'Comment not found');
  if (caller.kind !== 'user') return fail(403, 'Resolving a comment is a person\'s act, from their own session');
  if (!(await reach(caller, row.workspaceId, true))) return fail(403, 'You may read this comment but not resolve it');
  if (row.resolvedAt) return { ok: true, resolvedAt: new Date(row.resolvedAt).toISOString() };
  const [up] = await db.update(specComments).set({ resolvedAt: new Date(), resolvedBy: author(caller).label })
    .where(eq(specComments.id, commentId)).returning({ resolvedAt: specComments.resolvedAt });
  return { ok: true, resolvedAt: new Date(up!.resolvedAt!).toISOString() };
}

