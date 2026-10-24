import { db } from '@buildd/core/db';
import { specRevisions, specs, type SpecMetadataBlock } from '@buildd/core/db/schema';
import { and, asc, eq, sql } from 'drizzle-orm';
import { isUuid } from '@/lib/uuid';
import { getArtifactRevision } from '@/lib/artifact-revisions';
import { SHORT_ID } from './short-id';
import { author, createSpecDraft, fail, reach, reviseSpecDraft, type SpecCaller, type SpecError, type SpecRow } from './store';

/**
 * Copying a Living Spec into another workspace (a cross-workspace handoff).
 *
 * Workspaces do not read each other's specs: a runner in the destination gets
 * a 404 for the source spec, and that stays so. The copy is the handoff
 * instead, and it grants nothing: the caller must already read the source and
 * write specs in the destination (a task token, scoped to one workspace,
 * never can). The copy is a draft in the destination, byte for byte the
 * source revision, with its provenance in `metadata.copied_from`. It is never
 * approved by copying: a person in the destination approves it (D-4), and
 * until then work there can only pin it provisionally.
 *
 * The reply is the acknowledgement a runner waits on: the destination spec id,
 * the revision and its hash, re-read after the write and checked against the
 * source. Anything short of that is a failure naming what is wrong, never a
 * quiet success. A retry is safe: the copy of the same source revision is
 * found and returned, and a copy of an older source revision is revised up to
 * the named one rather than duplicated.
 *
 * Not carried: repo references (they are checked against the destination's
 * own repo), an artifact design and attachments (both live in the source
 * workspace). A URL or design-tool design is carried. The reply lists what was
 * left out.
 */

export type CopiedFrom = NonNullable<SpecMetadataBlock['copied_from']>;

export interface SpecCopyResult {
  ok: true;
  /** True when a retry found the copy already in place: nothing new was written. */
  reused: boolean;
  source: { workspaceId: string; specId: string; revision: number; contentHash: string; approved: boolean };
  destination: { workspaceId: string; specId: string; revision: number; contentHash: string; version: number; status: string; approved: boolean };
  verified: true;
  notCarried: string[];
  spec: SpecRow;
}

/** The copy of `sourceSpecId` in `workspaceId`, oldest first if more than one exists. */
export async function findSpecCopy(workspaceId: string, sourceSpecId: string): Promise<SpecRow | null> {
  if (!isUuid(workspaceId) || !isUuid(sourceSpecId)) return null;
  const [row] = await db.select().from(specs)
    .where(and(eq(specs.workspaceId, workspaceId), sql`${specs.metadata}->'copied_from'->>'specId' = ${sourceSpecId}`))
    .orderBy(asc(specs.createdAt)).limit(1);
  return row ?? null;
}

/** The sentence a 404 for a spec in no reachable workspace ends with: what to do, not who to ask again. */
export const COPY_RECOVERY = 'If it lives in another workspace, it cannot be read from here. Someone who can read that workspace and write specs in this one copies it: manage_specs { action: "copy", specId, targetWorkspaceId, revision }. The reply names the spec id and revision to use here; until then work that needs it stays blocked, and asking the owner again does not make it readable.';

/**
 * A spec the caller cannot read, by full or 8-hex short id: the 404 a runner
 * gets. When a copy of it sits in a workspace the caller reads, the 404 names
 * the copy (id, revision, hash), so the runner builds against it instead of
 * asking the owner again. Otherwise it says how a copy is made. A copy only
 * ever reveals the source id the caller already named.
 */
export async function specNotFound(caller: SpecCaller, idOrShort: string): Promise<SpecError> {
  const key = idOrShort.toLowerCase();
  const match = isUuid(key) ? sql`${specs.metadata}->'copied_from'->>'specId' = ${key}`
    : SHORT_ID.test(key) ? sql`${specs.metadata}->'copied_from'->>'specId' LIKE ${`${key}%`}` : null;
  const rows = match ? await db.select().from(specs).where(match).orderBy(asc(specs.createdAt)).limit(20) : [];
  const copies: SpecRow[] = [];
  for (const r of rows) if (await reach(caller, r.workspaceId, false)) copies.push(r);
  if (copies.length) {
    const lines = copies.map((c) => {
      const from = c.metadata!.copied_from!;
      return `${c.id} ("${c.title}", copied from revision ${from.revision}, sha256 ${from.contentHash}${c.approvedRevision ? `, approved revision ${c.approvedRevision} here` : ', not approved here yet'})`;
    });
    return fail(404, `Spec ${idOrShort} is not readable from here, but it was copied into a workspace you can read: ${lines.join('; ')}. Use that spec id.`, { code: 'spec_copied' });
  }
  return fail(404, `Spec not found. ${COPY_RECOVERY}`, { code: 'spec_not_found' });
}

export async function copySpecToWorkspace(caller: SpecCaller, specId: string, input: {
  targetWorkspaceId: unknown; revision?: unknown; expectedContentHash?: unknown;
}): Promise<SpecCopyResult | SpecError> {
  if (!isUuid(specId)) return fail(404, 'Spec not found');
  const { targetWorkspaceId, revision: namedRevision, expectedContentHash } = input;
  if (typeof targetWorkspaceId !== 'string' || !isUuid(targetWorkspaceId)) return fail(400, 'targetWorkspaceId must be a workspace UUID');
  if (namedRevision !== undefined && (typeof namedRevision !== 'number' || !Number.isInteger(namedRevision) || namedRevision < 1)) {
    return fail(400, 'revision must be a revision number');
  }
  if (expectedContentHash !== undefined && (typeof expectedContentHash !== 'string' || !/^[0-9a-f]{64}$/.test(expectedContentHash))) {
    return fail(400, 'expectedContentHash must be the sha256 (64 hex characters) of the revision you read');
  }

  const [spec] = await db.select().from(specs).where(eq(specs.id, specId)).limit(1);
  if (!spec || !(await reach(caller, spec.workspaceId, false))) return fail(404, 'Spec not found (you must be able to read the source spec to copy it)');
  if (spec.workspaceId === targetWorkspaceId) return fail(400, 'The spec is already in that workspace; nothing to copy');
  if (spec.status === 'retired' || spec.status === 'superseded') return fail(409, `A ${spec.status} spec is not copied`, { code: 'spec_copy_retired' });
  if (spec.repoSource?.state === 'imported') {
    return fail(409, `This spec is imported from ${spec.repoSource.path} and waiting for confirmation, so the repo file is still its source. Confirm the import, or import the file in the destination workspace instead.`, { code: 'spec_imported' });
  }
  if (!(await reach(caller, targetWorkspaceId, true))) {
    return fail(404, 'Destination workspace not found, or you cannot write specs there. Nothing was copied. The copy needs one caller who reads the source workspace and writes specs in the destination: a person who belongs to both, or an API key that reaches both. A task token reaches only its own workspace.', { code: 'spec_copy_destination' });
  }

  // Which revision: the one named, else the approved one, else the head.
  const n = (namedRevision as number | undefined) ?? spec.approvedRevision ?? spec.headRevision;
  const [rev] = await db.select().from(specRevisions).where(and(eq(specRevisions.specId, specId), eq(specRevisions.revision, n))).limit(1);
  if (!rev) return fail(409, `The spec has no revision ${n} (it has revisions 1 to ${spec.headRevision}); nothing was copied`, { code: 'spec_copy_stale' });
  if (typeof expectedContentHash === 'string' && expectedContentHash !== rev.contentHash) {
    return fail(409, `Revision ${n} has sha256 ${rev.contentHash}, not the ${expectedContentHash} you read; nothing was copied. Re-read the spec and copy the revision you mean.`, { code: 'spec_copy_stale' });
  }
  if (spec.approvedRevision != null && n < spec.approvedRevision) {
    return fail(409, `Revision ${n} is older than the approved revision ${spec.approvedRevision}; nothing was copied. Copy revision ${spec.approvedRevision}, or ask the person who chose revision ${n} which one they mean.`, { code: 'spec_copy_stale' });
  }
  const sourceBody = await getArtifactRevision(spec.bodyArtifactId, rev.artifactRevision);
  if (!sourceBody || typeof sourceBody.content !== 'string' || sourceBody.contentHash !== rev.contentHash) {
    return fail(409, `The body of revision ${n} is missing or does not match its hash; nothing was copied`, { code: 'spec_copy_source_unreadable' });
  }
  const body = sourceBody.content;

  const notCarried: string[] = [];
  if (rev.repoRefs?.length) notCarried.push(`repo references (${rev.repoRefs.map((r) => r.path).join(', ')}): they are checked against the destination's own repo; add them with revise`);
  const design = rev.design && rev.design.kind !== 'artifact' ? rev.design : null;
  if (rev.design?.kind === 'artifact') notCarried.push('the design (an artifact in the source workspace)');
  notCarried.push('attachments (they live in the source workspace)');

  const copiedFrom: CopiedFrom = {
    workspaceId: spec.workspaceId, specId, revision: n, contentHash: rev.contentHash,
    copiedAt: new Date().toISOString(), copiedBy: author(caller).label,
  };
  const source = { workspaceId: spec.workspaceId, specId, revision: n, contentHash: rev.contentHash, approved: rev.approvedAt !== null };

  // A retry: the copy already there, at this revision or an older one.
  const existing = await findSpecCopy(targetWorkspaceId, specId);
  let copyId: string;
  let reused = false;
  if (existing) {
    copyId = existing.id;
    const [head] = await db.select().from(specRevisions)
      .where(and(eq(specRevisions.specId, existing.id), eq(specRevisions.revision, existing.headRevision))).limit(1);
    if (head?.contentHash === rev.contentHash) {
      reused = true;
    } else {
      const r = await reviseSpecDraft(caller, existing.id, {
        expectedVersion: existing.version, body,
        changeSummary: `Copied from spec ${specId} revision ${n} (sha256 ${rev.contentHash.slice(0, 12)})`,
      }, { duplicates: false });
      if (!r.ok) return fail(r.status, `The copy ${existing.id} is there but could not be brought to revision ${n}: ${r.error}`, { code: r.code ?? 'spec_copy_failed' });
    }
    // Provenance names the source revision the head now is (also repairs one a
    // failed write left behind). Keyed on the row, so it moves nothing else.
    if (existing.metadata?.copied_from?.revision !== n || existing.metadata?.copied_from?.contentHash !== rev.contentHash) {
      await db.execute(sql`UPDATE specs SET metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('copied_from', ${JSON.stringify(copiedFrom)}::jsonb)
        WHERE id = ${existing.id}::uuid`);
    }
  } else {
    const r = await createSpecDraft(caller, {
      workspaceId: targetWorkspaceId, title: spec.title, scope: spec.scope, body,
      changeSummary: `Copied from spec ${specId} revision ${n} (sha256 ${rev.contentHash.slice(0, 12)})`,
      ...(design ? { design } : {}),
    }, { duplicates: false, metadata: { copied_from: copiedFrom } });
    if (!r.ok) return fail(r.status, `Nothing was copied: ${r.error}`, { code: r.code ?? 'spec_copy_failed' });
    copyId = r.spec.id;
  }

  return verifyCopy(copyId, targetWorkspaceId, source, notCarried, reused);
}

/** Re-read the destination after the write: the head is the source revision's bytes, by hash, and names its source. */
async function verifyCopy(copyId: string, workspaceId: string, source: SpecCopyResult['source'], notCarried: string[], reused: boolean): Promise<SpecCopyResult | SpecError> {
  const unverified = (why: string) => fail(502, `The copy ${copyId} was written but is not verified: ${why}. Do not build against it; run the same copy again.`, { code: 'spec_copy_unverified' });
  const [copy] = await db.select().from(specs).where(eq(specs.id, copyId)).limit(1);
  if (!copy || copy.workspaceId !== workspaceId) return unverified('it is not in the destination workspace');
  const [head] = await db.select().from(specRevisions).where(and(eq(specRevisions.specId, copyId), eq(specRevisions.revision, copy.headRevision))).limit(1);
  if (!head || head.contentHash !== source.contentHash) return unverified(`its head revision has sha256 ${head?.contentHash ?? 'none'}, the source revision ${source.revision} has ${source.contentHash}`);
  const body = await getArtifactRevision(copy.bodyArtifactId, head.artifactRevision);
  if (!body || body.contentHash !== source.contentHash) return unverified('its body does not match the hash');
  const from = copy.metadata?.copied_from;
  if (!from || from.specId !== source.specId || from.revision !== source.revision || from.contentHash !== source.contentHash) return unverified('its provenance does not name the source revision');
  return {
    ok: true, reused, source, verified: true, notCarried, spec: copy,
    destination: { workspaceId, specId: copy.id, revision: head.revision, contentHash: head.contentHash, version: copy.version, status: copy.status, approved: head.approvedAt !== null },
  };
}
