import { db } from '@buildd/core/db';
import { artifacts, specRevisions, specs, SPEC_SCOPES, type SpecScope } from '@buildd/core/db/schema';
import { and, desc, eq, sql } from 'drizzle-orm';
import { isUuid } from '@/lib/uuid';
import { resolveWorkspaceAccess, type WorkspaceAccessCaller } from '@/lib/workspace-access';
import { getArtifactRevision } from '@/lib/artifact-revisions';
import { requirementIds, type RequirementRef } from './requirements';

/**
 * Living Specs store (G1): create a draft, revise it under a version check,
 * read any revision. The body is the spec's body artifact; every spec revision
 * pins one artifact revision and its sha256, so an earlier revision is always
 * readable exactly as it was.
 *
 * Revising is one statement: the body artifact is updated only while it is at
 * the revision the head pins and the spec at the version the writer read, and
 * the version bump and the new spec revision ride in the same statement, so a
 * revise lands whole or not at all and the loser of a race writes nothing. A stale `expectedVersion` is a 409 naming the current
 * version: re-read, merge, revise on top. A revise always leaves the head a
 * draft: on an approved spec it proposes N+1 while `approved_revision` stays N.
 * Nothing here approves: approval is a person's act on one revision
 * (./approval.ts, decision D-4).
 */

export type SpecCaller =
  | { kind: 'user'; userId: string }
  | { kind: 'account'; account: Extract<WorkspaceAccessCaller, { account: unknown }>['account'] & { taskScope?: { workspaceId: string } } };

const accessCaller = (c: SpecCaller): WorkspaceAccessCaller => (c.kind === 'user' ? { userId: c.userId } : { account: c.account });
const author = (c: SpecCaller) => (c.kind === 'user'
  ? { authorKind: 'user' as const, authorId: c.userId, label: `user:${c.userId}` }
  : { authorKind: 'agent' as const, authorId: c.account.id, label: `account:${c.account.id}` });

export type SpecError = { ok: false; status: 400 | 403 | 404 | 409; error: string; currentVersion?: number };
export const fail = (status: SpecError['status'], error: string, extra: Partial<SpecError> = {}): SpecError => ({ ok: false, status, error, ...extra });

/** Read (or, with `write`, create and revise) access to a workspace's specs. */
export async function reach(caller: SpecCaller, workspaceId: string, write: boolean): Promise<boolean> {
  if (caller.kind === 'account' && caller.account.taskScope && caller.account.taskScope.workspaceId !== workspaceId) return false;
  return (await resolveWorkspaceAccess(workspaceId, accessCaller(caller), write ? 'canCreate' : undefined)).ok;
}

export const MAX_SPEC_BODY_CHARS = 400_000;

function checkBody(body: unknown): string | SpecError {
  if (typeof body !== 'string' || !body.trim()) return fail(400, 'body (the spec text, Markdown) is required');
  if (body.length > MAX_SPEC_BODY_CHARS) return fail(400, `body is at most ${MAX_SPEC_BODY_CHARS} characters`);
  return body;
}

export type SpecRow = typeof specs.$inferSelect;
export type SpecRevisionRow = typeof specRevisions.$inferSelect;

export async function createSpecDraft(caller: SpecCaller, input: {
  workspaceId: unknown; title: unknown; scope?: unknown; parentSpecId?: unknown; body: unknown; changeSummary?: unknown;
}): Promise<{ ok: true; spec: SpecRow; revision: SpecRevisionRow } | SpecError> {
  const { workspaceId, title, parentSpecId } = input;
  const scope = (input.scope ?? 'feature') as SpecScope;
  if (typeof workspaceId !== 'string' || !isUuid(workspaceId)) return fail(400, 'workspaceId must be a UUID');
  if (typeof title !== 'string' || !title.trim() || title.length > 200) return fail(400, 'title is required (at most 200 characters)');
  if (!SPEC_SCOPES.includes(scope)) return fail(400, `scope must be one of: ${SPEC_SCOPES.join(', ')}`);
  const body = checkBody(input.body);
  if (typeof body !== 'string') return body;
  if (!(await reach(caller, workspaceId, true))) return fail(404, 'Workspace not found');
  if (parentSpecId !== undefined && parentSpecId !== null) {
    if (typeof parentSpecId !== 'string' || !isUuid(parentSpecId)) return fail(400, 'parentSpecId must be a UUID');
    const [parent] = await db.select({ workspaceId: specs.workspaceId }).from(specs).where(eq(specs.id, parentSpecId)).limit(1);
    if (!parent || parent.workspaceId !== workspaceId) return fail(404, 'Parent spec not found in this workspace');
  }

  const who = author(caller);
  // The body artifact: its insert is revision 1 (the artifact revision trigger).
  const [art] = await db.insert(artifacts).values({
    workspaceId, type: 'content', title: `Spec: ${title.trim()}`, content: body, contentAuthor: who.label,
    visibility: 'private', metadata: { livingSpec: true },
  }).returning();
  const bodyRev = await getArtifactRevision(art.id, art.currentRevision);
  const [spec] = await db.insert(specs).values({
    workspaceId, title: title.trim(), scope, parentSpecId: (parentSpecId as string | null | undefined) ?? null,
    bodyArtifactId: art.id, headRevision: 1, createdBy: who.label,
  }).returning();
  const [revision] = await db.insert(specRevisions).values({
    specId: spec.id, revision: 1, artifactRevision: art.currentRevision, contentHash: bodyRev!.contentHash!,
    authorKind: who.authorKind, authorId: who.authorId, changeSummary: typeof input.changeSummary === 'string' ? input.changeSummary : null,
  }).returning();
  return { ok: true, spec, revision };
}

export async function reviseSpecDraft(caller: SpecCaller, specId: string, input: {
  expectedVersion: unknown; body: unknown; changeSummary?: unknown;
}): Promise<{ ok: true; spec: SpecRow; revision: SpecRevisionRow; unchanged: boolean } | SpecError> {
  if (!isUuid(specId)) return fail(404, 'Spec not found');
  if (!Number.isInteger(input.expectedVersion)) return fail(400, 'expectedVersion (the spec version you read) is required');
  const body = checkBody(input.body);
  if (typeof body !== 'string') return body;
  const [spec] = await db.select().from(specs).where(eq(specs.id, specId)).limit(1);
  if (!spec || !(await reach(caller, spec.workspaceId, true))) return fail(404, 'Spec not found');
  if (spec.status === 'retired' || spec.status === 'superseded') return fail(409, `A ${spec.status} spec is not revised`);
  const conflict = () => fail(409, `The spec changed since version ${input.expectedVersion as number}: it is now at version ${spec.version}. Re-read it, merge, then revise on top.`, { currentVersion: spec.version });
  if (spec.version !== input.expectedVersion) return conflict();

  const [head] = await db.select().from(specRevisions).where(and(eq(specRevisions.specId, specId), eq(specRevisions.revision, spec.headRevision))).limit(1);
  const [{ hash }] = ((await db.execute(sql`SELECT encode(sha256(convert_to(${body}, 'UTF8')), 'hex') AS hash`)) as unknown as { rows: Array<{ hash: string }> }).rows;
  if (hash === head.contentHash) return { ok: true, spec, revision: head, unchanged: true };

  // One statement, so it lands whole or not at all: the body (only while the
  // artifact is still at the revision the head pins AND the spec still at the
  // version read), the version bump, and the spec revision pinning the new body.
  const who = author(caller);
  const summary = typeof input.changeSummary === 'string' ? input.changeSummary : null;
  const rows = await db.execute(sql`
    WITH body AS (
      UPDATE artifacts SET content = ${body}, content_author = ${who.label}, updated_at = now()
      WHERE id = ${spec.bodyArtifactId}::uuid AND current_revision = ${head.artifactRevision}
        AND EXISTS (SELECT 1 FROM specs WHERE id = ${specId}::uuid AND version = ${spec.version})
      RETURNING current_revision
    ), up AS (
      UPDATE specs SET version = version + 1, head_revision = head_revision + 1, status = 'draft', updated_at = now()
      WHERE id = ${specId}::uuid AND version = ${spec.version} AND EXISTS (SELECT 1 FROM body)
      RETURNING id, head_revision
    )
    INSERT INTO spec_revisions (spec_id, revision, artifact_revision, content_hash, author_kind, author_id, change_summary)
    SELECT up.id, up.head_revision, body.current_revision, ${hash}, ${who.authorKind}, ${who.authorId}, ${summary} FROM up, body
    RETURNING id`);
  if (((rows as { rows?: unknown[] }).rows ?? []).length === 0) {
    const [now] = await db.select({ version: specs.version }).from(specs).where(eq(specs.id, specId)).limit(1);
    return fail(409, `The spec changed while you were revising it: it is now at version ${now?.version ?? spec.version}. Re-read it, merge, then revise on top.`, { currentVersion: now?.version ?? spec.version });
  }
  const [after] = await db.select().from(specs).where(eq(specs.id, specId)).limit(1);
  const [revision] = await db.select().from(specRevisions).where(and(eq(specRevisions.specId, specId), eq(specRevisions.revision, after.headRevision))).limit(1);
  return { ok: true, spec: after, revision, unchanged: false };
}

/**
 * Set, change or clear a spec's parent. The parent must be in the same
 * workspace and must not be the spec or one of its descendants: one statement
 * walks the new parent's ancestors and writes only when the spec is not among
 * them, so a relate never closes a cycle. Structure, not body: the version
 * (the body's CAS token) does not move.
 */
export async function relateSpec(caller: SpecCaller, specId: string, input: { parentSpecId: unknown }): Promise<{ ok: true; spec: SpecRow } | SpecError> {
  if (!isUuid(specId)) return fail(404, 'Spec not found');
  const parentSpecId = input.parentSpecId;
  if (parentSpecId !== null && (typeof parentSpecId !== 'string' || !isUuid(parentSpecId))) return fail(400, 'parentSpecId must be a spec UUID, or null to clear it');
  const [spec] = await db.select().from(specs).where(eq(specs.id, specId)).limit(1);
  if (!spec || !(await reach(caller, spec.workspaceId, true))) return fail(404, 'Spec not found');
  if (parentSpecId === null) {
    const [cleared] = await db.update(specs).set({ parentSpecId: null, updatedAt: new Date() }).where(eq(specs.id, specId)).returning();
    return { ok: true, spec: cleared };
  }
  if (parentSpecId === specId) return fail(409, 'A spec cannot be its own parent');
  const [parent] = await db.select({ workspaceId: specs.workspaceId }).from(specs).where(eq(specs.id, parentSpecId)).limit(1);
  if (!parent || parent.workspaceId !== spec.workspaceId) return fail(404, 'Parent spec not found in this workspace');

  const rows = await db.execute(sql`
    WITH RECURSIVE ancestors(id, depth) AS (
      SELECT ${parentSpecId}::uuid, 0
      UNION ALL
      SELECT s.parent_spec_id, a.depth + 1 FROM specs s JOIN ancestors a ON s.id = a.id
      WHERE s.parent_spec_id IS NOT NULL AND a.depth < 1000
    )
    UPDATE specs SET parent_spec_id = ${parentSpecId}::uuid, updated_at = now()
    WHERE id = ${specId}::uuid AND NOT EXISTS (SELECT 1 FROM ancestors WHERE id = ${specId}::uuid)
    RETURNING id`);
  if (((rows as { rows?: unknown[] }).rows ?? []).length === 0) {
    return fail(409, 'That parent is this spec or one of its descendants: the relation would form a cycle');
  }
  const [after] = await db.select().from(specs).where(eq(specs.id, specId)).limit(1);
  return { ok: true, spec: after };
}

export interface SpecView {
  spec: SpecRow;
  revision: SpecRevisionRow;
  body: string;
  requirements: RequirementRef[];
  revisions: Array<Pick<SpecRevisionRow, 'revision' | 'contentHash' | 'authorKind' | 'changeSummary' | 'approvedAt' | 'createdAt'>>;
}

/** A spec at its head, or at `revision`, exactly as that revision was written. */
export async function getSpec(caller: SpecCaller, specId: string, opts: { revision?: number } = {}): Promise<{ ok: true; view: SpecView } | SpecError> {
  if (!isUuid(specId)) return fail(404, 'Spec not found');
  const [spec] = await db.select().from(specs).where(eq(specs.id, specId)).limit(1);
  if (!spec || !(await reach(caller, spec.workspaceId, false))) return fail(404, 'Spec not found');
  const n = opts.revision ?? spec.headRevision;
  const [revision] = await db.select().from(specRevisions).where(and(eq(specRevisions.specId, specId), eq(specRevisions.revision, n))).limit(1);
  if (!revision) return fail(404, `Spec has no revision ${n}`);
  const body = (await getArtifactRevision(spec.bodyArtifactId, revision.artifactRevision))?.content ?? '';
  const revisions = await db.select({
    revision: specRevisions.revision, contentHash: specRevisions.contentHash, authorKind: specRevisions.authorKind,
    changeSummary: specRevisions.changeSummary, approvedAt: specRevisions.approvedAt, createdAt: specRevisions.createdAt,
  }).from(specRevisions).where(eq(specRevisions.specId, specId)).orderBy(desc(specRevisions.revision));
  return { ok: true, view: { spec, revision, body, requirements: requirementIds(body), revisions } };
}

export async function listSpecs(caller: SpecCaller, workspaceId: string): Promise<{ ok: true; specs: SpecRow[] } | SpecError> {
  if (!isUuid(workspaceId) || !(await reach(caller, workspaceId, false))) return fail(404, 'Workspace not found');
  return { ok: true, specs: await db.select().from(specs).where(eq(specs.workspaceId, workspaceId)).orderBy(desc(specs.updatedAt)) };
}
