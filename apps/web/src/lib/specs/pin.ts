import { db } from '@buildd/core/db';
import { specRevisions, specs } from '@buildd/core/db/schema';
import { and, eq } from 'drizzle-orm';
import { isUuid } from '@/lib/uuid';
import { getArtifactRevision } from '@/lib/artifact-revisions';
import { specCriteria } from '@buildd/spec-contract/requirements';
import { checkCriteriaScope } from '@buildd/spec-contract/scope';
import type { StoredDesign } from './design';

/**
 * Pinning work to a Living Spec revision (G2, decision D-4).
 *
 * A task that names a Living Spec in `context.specSource.specId` is pinned when
 * it is filed: the server writes the approved revision's id, number and hash
 * (or, for work built ahead of approval, the named or head revision's, marked
 * `provisional`: living-specs.md §20),
 * so a later revision (N+1, proposed or approved) never moves running work or
 * its review. The pin comes from the database; a caller's hash or revision
 * number is overwritten, never trusted. `specSource` grows additively: a
 * repo-document source (`specPath`, `planningTaskId`, written by approvePlan)
 * passes through untouched, as does a task that names no spec at all.
 */

export type PinError = { ok: false; status: 400 | 404 | 409; error: string };
type Ctx = Record<string, unknown> | null | undefined;

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

export async function pinSpecSource<C extends Ctx>(workspaceId: string, context: C): Promise<{ ok: true; context: C } | PinError> {
  const src = asRecord(asRecord(context)?.specSource);
  if (!src || src.specId === undefined) return { ok: true, context };
  const { specId, specRevisionId, revision: namedRevision } = src;
  if (typeof specId !== 'string' || !isUuid(specId)) return { ok: false, status: 400, error: 'context.specSource.specId must be a spec UUID' };
  if (specRevisionId !== undefined && (typeof specRevisionId !== 'string' || !isUuid(specRevisionId))) {
    return { ok: false, status: 400, error: 'context.specSource.specRevisionId must be a spec revision UUID' };
  }
  // A revision number names a revision only when no revision id is given (a
  // copied pin carries both; its id wins).
  const byNumber = specRevisionId === undefined && namedRevision !== undefined;
  if (byNumber && (typeof namedRevision !== 'number' || !Number.isInteger(namedRevision) || namedRevision < 1)) {
    return { ok: false, status: 400, error: 'context.specSource.revision must be a revision number' };
  }

  const [spec] = await db.select({ id: specs.id, workspaceId: specs.workspaceId, approvedRevision: specs.approvedRevision, headRevision: specs.headRevision })
    .from(specs).where(eq(specs.id, specId)).limit(1);
  if (!spec || spec.workspaceId !== workspaceId) return { ok: false, status: 404, error: 'context.specSource.specId: spec not found in this workspace' };

  // Which revision: the one named, else the approved one, else the head
  // (building ahead of approval, §20 R-36).
  const named = typeof specRevisionId === 'string' || byNumber;
  const where = typeof specRevisionId === 'string'
    ? and(eq(specRevisions.id, specRevisionId), eq(specRevisions.specId, specId))
    : and(eq(specRevisions.specId, specId), eq(specRevisions.revision, byNumber ? namedRevision as number : spec.approvedRevision ?? spec.headRevision));
  const [rev] = await db.select().from(specRevisions).where(where).limit(1);
  if (!rev) return { ok: false, status: 409, error: `context.specSource names a revision this spec does not have (it has revisions 1 to ${spec.headRevision})` };
  // Not approved: a provisional pin to exactly this revision, which a later
  // approval re-grades (./provisional.ts). Approved: as before.
  const provisional = rev.approvedAt === null;

  // A repo commit the work also traces to (D-1), kept only when it is a SHA.
  // Pin provenance is the server's: a revision the filer named is explicit
  // and kept at claim; otherwise the first claim re-pins (lib/specs/claim-pin.ts).
  // A provisional pin moves at claim only to a newer approved revision.
  const { commitSha, criteria, explicit: _explicit, pinnedAt: _pinnedAt, repinnedFrom: _repinnedFrom, provisional: _provisional, regradedFrom: _regradedFrom, regrade: _regrade, attachedBy: _attachedBy, attachedAt: _attachedAt, ...rest } = src;
  const pinned: Record<string, unknown> = {
    ...rest,
    specId,
    specRevisionId: rev.id,
    revision: rev.revision,
    contentHash: rev.contentHash,
    ...(named && !provisional ? { explicit: true } : {}),
    ...(provisional ? { provisional: true } : {}),
    ...(typeof commitSha === 'string' && /^[0-9a-f]{7,40}$/i.test(commitSha) ? { commitSha } : {}),
  };
  // The criteria this task answers for (./scope.ts), checked against the
  // revision it is pinned to; left out, it answers for every one.
  if (criteria !== undefined) {
    const read = await readPinnedSpecRevision(pinned);
    if (!read.ok) return { ok: false, status: 409, error: `context.specSource.criteria cannot be checked: ${read.reason}` };
    const scope = checkCriteriaScope(criteria, specCriteria(read.body).map((c) => c.id), rev.revision);
    if (!scope.ok) return { ok: false, status: 400, error: scope.error };
    pinned.criteria = scope.criteria;
  }
  return { ok: true, context: { ...(context as Record<string, unknown>), specSource: pinned } as unknown as C };
}

export type PinnedRead =
  | { ok: true; specId: string; revision: number; contentHash: string; body: string; title: string; design: StoredDesign | null }
  | { ok: false; reason: string };

/**
 * The exact text a pin names, for the reviewer and the running agent. The
 * hash is checked against the stored revision: a pin that no longer resolves,
 * or resolves to different bytes, is unavailable (never quietly the head).
 * No caller check: this reads by the pin a task already carries, server-side.
 */
export async function readPinnedSpecRevision(pin: Record<string, unknown> | null | undefined): Promise<PinnedRead> {
  const specId = pin?.specId; const specRevisionId = pin?.specRevisionId; const contentHash = pin?.contentHash;
  if (typeof specId !== 'string' || !isUuid(specId) || typeof specRevisionId !== 'string' || !isUuid(specRevisionId) || typeof contentHash !== 'string') {
    return { ok: false, reason: 'the task names a Living Spec but carries no pinned revision' };
  }
  const [row] = await db.select({ rev: specRevisions, title: specs.title, bodyArtifactId: specs.bodyArtifactId })
    .from(specRevisions).innerJoin(specs, eq(specs.id, specRevisions.specId))
    .where(and(eq(specRevisions.id, specRevisionId), eq(specRevisions.specId, specId))).limit(1);
  if (!row) return { ok: false, reason: `pinned spec revision ${specRevisionId} no longer exists` };
  if (row.rev.contentHash !== contentHash) return { ok: false, reason: `pinned spec revision ${row.rev.revision} has a different hash than the task was pinned to` };
  const body = await getArtifactRevision(row.bodyArtifactId, row.rev.artifactRevision);
  if (!body || body.contentHash !== contentHash || typeof body.content !== 'string') {
    return { ok: false, reason: `the body of pinned spec revision ${row.rev.revision} is missing or does not match its hash` };
  }
  return { ok: true, specId, revision: row.rev.revision, contentHash, body: body.content, title: row.title, design: row.rev.design ?? null };
}
