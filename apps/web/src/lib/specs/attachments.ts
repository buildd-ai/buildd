import { randomUUID } from 'node:crypto';
import { db } from '@buildd/core/db';
import { artifacts, specAttachments, specRevisions, specs, users, workspaces, SPEC_ATTACHMENT_KINDS, type SpecApprovedAttachment, type SpecAttachmentKind } from '@buildd/core/db/schema';
import { and, desc, eq, gt, inArray, isNull, lte, or, type SQL } from 'drizzle-orm';
import { isUuid } from '@/lib/uuid';
import { buildArtifactKey, uploadStagingKey } from '@/lib/storage-keys';
import { generateSizedUploadUrl, isStorageConfigured } from '@/lib/storage';
import { author, fail, reach, type SpecCaller, type SpecError } from './store';

export { approvedAttachmentsSql } from './attachment-pins';

/**
 * Spec attachments (living-specs.md §21, decisions D-15/D-16): a file or image
 * linked to a spec under a name, kept as an artifact (the existing upload and
 * storage path; no second file store). The body places one inline with
 * `![caption](attachment:<name>)`.
 *
 * An attachment belongs to the revision it was added in (the head then) and
 * applies to every revision from there until it is removed. Removing it stops
 * it from the head when the head is a draft, or from the next revision when the
 * head is the approved one, so what an approved or older revision shows never
 * changes. Live names are unique per spec; `replace` swaps the artifact under a
 * name the same way (the old row is removed, a new one added), and when two
 * rows apply to one revision the newer wins.
 *
 * `binding` attachments are what an approval records (approvedAttachmentsSql,
 * in the approving statement): each one's artifact revision, beside the design
 * pin. Reading the approved revision or a later one, a binding attachment whose
 * artifact moved on, or that was swapped or added after approval, says so.
 * `reference` attachments are never recorded, never flagged, never graded.
 *
 * The lasting link is /api/specs/[specId]/attachments/[name]?revision=N: the
 * spec's own read check, then a fresh presigned URL (openSpecAttachment), so a
 * body never carries an expiring one.
 */

export const ATTACHMENT_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const MAX_CAPTION_CHARS = 300;
/** The same ceiling as an artifact upload (POST /api/artifacts/upload-url). */
export const MAX_ATTACHMENT_UPLOAD_BYTES = 50 * 1024 * 1024;

export type AttachmentApproval =
  | { state: 'unchanged'; pinned: number; current: number }
  | { state: 'changed'; pinned: number; current: number }
  | { state: 'added'; pinned: null; current: number };

export interface AttachmentView {
  id: string;
  name: string;
  kind: SpecAttachmentKind;
  caption: string | null;
  artifactId: string;
  title: string | null;
  mimeType: string | null;
  isImage: boolean;
  /** The artifact's revision now. */
  artifactRevision: number;
  addedInRevision: number;
  removedFromRevision: number | null;
  addedBy: { kind: 'person' | 'agent'; name: string | null };
  addedAt: string;
  /** The lasting, access-checked link, at the revision read. */
  url: string;
  /** Binding only, read on the approved revision or later: how it stands against what approval recorded. */
  approval: AttachmentApproval | null;
}

type Row = typeof specAttachments.$inferSelect;
type ArtifactFacts = { id: string; title: string | null; metadata: Record<string, unknown> | null; currentRevision: number; storageKey: string | null; uploadState: string | null };

const mimeOf = (a: Pick<ArtifactFacts, 'metadata'>) => (typeof a.metadata?.mimeType === 'string' ? a.metadata.mimeType : null);
const isImageMime = (m: string | null) => !!m && m.toLowerCase().startsWith('image/');
export const attachmentUrl = (specId: string, name: string, revision: number) => `/api/specs/${specId}/attachments/${encodeURIComponent(name)}?revision=${revision}`;

/** Applies to revision `n`: added at or before it, not removed by it. */
const appliesAt = (n: number): SQL => and(
  lte(specAttachments.addedInRevision, n),
  or(isNull(specAttachments.removedFromRevision), gt(specAttachments.removedFromRevision, n)),
)!;

/** The revision a removal (or replace) stops it from: the head while it is a draft, the next one when the head is approved. */
const stopsFrom = (spec: { headRevision: number; approvedRevision: number | null }) => (spec.approvedRevision === spec.headRevision ? spec.headRevision + 1 : spec.headRevision);

/** The rows that apply to revision `n`, one per name (the newest), each with its artifact. */
async function applying(specId: string, n: number): Promise<Array<{ row: Row; art: ArtifactFacts }>> {
  const rows = await db.select({ row: specAttachments, art: { id: artifacts.id, title: artifacts.title, metadata: artifacts.metadata, currentRevision: artifacts.currentRevision, storageKey: artifacts.storageKey, uploadState: artifacts.uploadState } })
    .from(specAttachments).innerJoin(artifacts, eq(artifacts.id, specAttachments.artifactId))
    .where(and(eq(specAttachments.specId, specId), appliesAt(n)))
    .orderBy(desc(specAttachments.createdAt));
  const seen = new Set<string>();
  const out: Array<{ row: Row; art: ArtifactFacts }> = [];
  for (const r of rows) {
    if (seen.has(r.row.name)) continue;
    seen.add(r.row.name);
    out.push(r as { row: Row; art: ArtifactFacts });
  }
  return out.sort((a, b) => a.row.name.localeCompare(b.row.name));
}

/** How one binding attachment stands against the approval record. */
export function approvalState(pins: readonly SpecApprovedAttachment[], name: string, artifactId: string, current: number): AttachmentApproval {
  const pin = pins.find((p) => p.name === name);
  if (!pin) return { state: 'added', pinned: null, current };
  if (pin.artifactId !== artifactId || current > pin.revision) return { state: 'changed', pinned: pin.revision, current };
  return { state: 'unchanged', pinned: pin.revision, current };
}

async function loadSpec(caller: SpecCaller, specId: string, write: boolean): Promise<typeof specs.$inferSelect | SpecError> {
  if (!isUuid(specId)) return fail(404, 'Spec not found');
  const [spec] = await db.select().from(specs).where(eq(specs.id, specId)).limit(1);
  if (!spec || !(await reach(caller, spec.workspaceId, false))) return fail(404, 'Spec not found');
  if (write && !(await reach(caller, spec.workspaceId, true))) return fail(403, 'You may read this spec but not change its attachments');
  return spec;
}
const isError = (v: unknown): v is SpecError => !!v && typeof v === 'object' && (v as SpecError).ok === false;

/** The attachments that apply to revision `revision` (default the head), with how each binding one stands against approval. */
export async function listSpecAttachments(caller: SpecCaller, specId: string, opts: { revision?: number }): Promise<{ ok: true; revision: number; attachments: AttachmentView[] } | SpecError> {
  const spec = await loadSpec(caller, specId, false);
  if (isError(spec)) return spec;
  const n = opts.revision ?? spec.headRevision;
  if (!Number.isInteger(n) || n < 1 || n > spec.headRevision) return fail(404, `Spec has no revision ${n}`);
  return { ok: true, revision: n, attachments: await attachmentViews(spec, n) };
}

/** The views for revision `n` of a spec the caller already reaches. */
export async function attachmentViews(spec: Pick<typeof specs.$inferSelect, 'id' | 'approvedRevision'>, n: number): Promise<AttachmentView[]> {
  const rows = await applying(spec.id, n);
  if (!rows.length) return [];
  let pins: SpecApprovedAttachment[] | null = null;
  if (spec.approvedRevision != null && n >= spec.approvedRevision) {
    const [rev] = await db.select({ approvedAttachments: specRevisions.approvedAttachments }).from(specRevisions)
      .where(and(eq(specRevisions.specId, spec.id), eq(specRevisions.revision, spec.approvedRevision))).limit(1);
    pins = rev?.approvedAttachments ?? [];
  }
  const personIds = [...new Set(rows.map((r) => r.row.addedBy).filter((l) => l.startsWith('user:')).map((l) => l.slice(5)).filter(isUuid))];
  const names = new Map<string, string>();
  if (personIds.length) {
    for (const u of await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, personIds))) if (u.name) names.set(u.id, u.name);
  }
  return rows.map(({ row, art }) => {
    const mimeType = mimeOf(art);
    const person = row.addedBy.startsWith('user:');
    return {
      id: row.id, name: row.name, kind: row.kind, caption: row.caption, artifactId: row.artifactId,
      title: art.title, mimeType, isImage: !!art.storageKey && isImageMime(mimeType),
      artifactRevision: art.currentRevision, addedInRevision: row.addedInRevision, removedFromRevision: row.removedFromRevision,
      addedBy: { kind: person ? 'person' : 'agent', name: person ? names.get(row.addedBy.slice(5)) ?? null : null },
      addedAt: new Date(row.createdAt).toISOString(),
      url: attachmentUrl(spec.id, row.name, n),
      approval: row.kind === 'binding' && pins ? approvalState(pins, row.name, row.artifactId, art.currentRevision) : null,
    };
  });
}

export interface AttachmentSource { src: string; alt: string | null; image: boolean }

/**
 * What `attachment:<name>` resolves to on revision `n`, for the renderer
 * (MarkdownContent's `attachments`). A name absent here renders as a visible
 * "missing attachment" placeholder, never a broken image. The caller has
 * already passed the spec's read check.
 */
export async function attachmentSources(specId: string, n: number): Promise<Record<string, AttachmentSource>> {
  const out: Record<string, AttachmentSource> = {};
  for (const { row, art } of await applying(specId, n)) {
    out[row.name] = { src: attachmentUrl(specId, row.name, n), alt: row.caption, image: !!art.storageKey && isImageMime(mimeOf(art)) };
  }
  return out;
}

/** The same map, from views already read. */
export function sourcesOf(views: readonly AttachmentView[]): Record<string, AttachmentSource> {
  return Object.fromEntries(views.map((v) => [v.name, { src: v.url, alt: v.caption, image: v.isImage }]));
}

export interface AttachDeps {
  /** Presign the PUT for an upload's staging key (default: the artifact upload signer). */
  signUpload?: (stagingKey: string, mimeType: string, sizeBytes: number) => Promise<string>;
}

/**
 * Attach a file to a spec: an artifact already in the spec's workspace
 * (`artifactId`), or a new upload (`filename`, `mimeType`, `sizeBytes`),
 * which creates a pending artifact and returns a presigned PUT for it, the same
 * staged, size-bound upload as upload_artifact. Needs write access.
 */
export async function attachToSpec(caller: SpecCaller, specId: string, input: {
  name?: unknown; kind?: unknown; caption?: unknown; artifactId?: unknown; replace?: unknown;
  filename?: unknown; mimeType?: unknown; sizeBytes?: unknown;
}, deps: AttachDeps = {}): Promise<{ ok: true; attachment: AttachmentView; upload: { artifactId: string; uploadUrl: string } | null } | SpecError> {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!ATTACHMENT_NAME_RE.test(name)) return fail(400, 'name must be 1-64 characters of a-z, 0-9, ".", "_" or "-", starting with a letter or digit (the body places it as attachment:<name>)');
  if (!SPEC_ATTACHMENT_KINDS.includes(input.kind as SpecAttachmentKind)) return fail(400, `kind must be one of: ${SPEC_ATTACHMENT_KINDS.join(', ')}`);
  const kind = input.kind as SpecAttachmentKind;
  if (input.caption !== undefined && input.caption !== null && (typeof input.caption !== 'string' || input.caption.length > MAX_CAPTION_CHARS)) {
    return fail(400, `caption is text of at most ${MAX_CAPTION_CHARS} characters`);
  }
  const caption = typeof input.caption === 'string' && input.caption.trim() ? input.caption.trim() : null;
  const upload = input.artifactId === undefined || input.artifactId === null;
  if (upload) {
    if (typeof input.filename !== 'string' || !input.filename.trim() || typeof input.mimeType !== 'string' || !input.mimeType.trim()) {
      return fail(400, 'artifactId (an artifact in this workspace), or filename, mimeType and sizeBytes to upload one, is required');
    }
    if (typeof input.sizeBytes !== 'number' || !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0) return fail(400, 'sizeBytes must be a positive integer');
    if (input.sizeBytes > MAX_ATTACHMENT_UPLOAD_BYTES) return fail(400, `a file is at most ${MAX_ATTACHMENT_UPLOAD_BYTES / (1024 * 1024)}MB`);
  } else if (typeof input.artifactId !== 'string' || !isUuid(input.artifactId)) {
    return fail(400, 'artifactId must be an artifact id');
  }

  const spec = await loadSpec(caller, specId, true);
  if (isError(spec)) return spec;
  if (spec.status === 'retired' || spec.status === 'superseded') return fail(409, `A ${spec.status} spec takes no attachments`);
  const [live] = await db.select({ id: specAttachments.id }).from(specAttachments)
    .where(and(eq(specAttachments.specId, specId), eq(specAttachments.name, name), isNull(specAttachments.removedFromRevision))).limit(1);
  if (live && input.replace !== true) return fail(409, `This spec already has an attachment named ${name}. Pass replace: true to put a new file under that name, or pick another name.`, { code: 'attachment_exists' });

  const who = author(caller);
  let artifactId: string;
  let signed: { artifactId: string; uploadUrl: string } | null = null;
  if (upload) {
    const [ws] = await db.select({ dataClass: workspaces.dataClass }).from(workspaces).where(eq(workspaces.id, spec.workspaceId)).limit(1);
    if (ws?.dataClass === 'sensitive') return fail(403, 'Content upload is not permitted for sensitive workspaces');
    const sign = deps.signUpload ?? (isStorageConfigured() ? generateSizedUploadUrl : null);
    if (!sign) return fail(502, 'Storage is not configured on this deployment, so nothing can be uploaded. Attach an existing artifact instead.');
    const id = randomUUID();
    let storageKey: string;
    try {
      storageKey = buildArtifactKey(spec.workspaceId, id, input.filename);
    } catch {
      return fail(400, 'filename cannot be stored; use a plain file name');
    }
    const mimeType = (input.mimeType as string).trim();
    const sizeBytes = input.sizeBytes as number;
    const uploadUrl = await sign(uploadStagingKey(storageKey), mimeType, sizeBytes);
    await db.insert(artifacts).values({
      id, workspaceId: spec.workspaceId, type: 'file', title: caption ?? (input.filename as string), storageKey,
      uploadState: 'pending', visibility: 'private', contentAuthor: who.label,
      metadata: { filename: input.filename, mimeType, sizeBytes, specAttachment: { specId, name } },
    });
    artifactId = id;
    signed = { artifactId: id, uploadUrl };
  } else {
    const [art] = await db.select({ workspaceId: artifacts.workspaceId, uploadState: artifacts.uploadState }).from(artifacts).where(eq(artifacts.id, input.artifactId as string)).limit(1);
    if (!art || art.workspaceId !== spec.workspaceId) return fail(400, 'artifactId names no artifact in this spec\'s workspace; nothing was attached');
    if (art.uploadState === 'failed') return fail(400, 'That artifact\'s upload failed; upload it again first');
    artifactId = input.artifactId as string;
  }

  if (live) {
    await db.update(specAttachments).set({ removedFromRevision: stopsFrom(spec), removedBy: who.label, removedAt: new Date() })
      .where(and(eq(specAttachments.id, live.id), isNull(specAttachments.removedFromRevision)));
  }
  let row: Row;
  try {
    [row] = await db.insert(specAttachments).values({
      workspaceId: spec.workspaceId, specId, artifactId, name, kind, caption, addedInRevision: spec.headRevision, addedBy: who.label,
    }).returning();
  } catch (err) {
    if (String((err as { code?: unknown })?.code ?? (err as Error)?.message).includes('23505') || /spec_attachments_live_name_idx/.test(String((err as Error)?.message))) {
      return fail(409, `Another attachment named ${name} was added at the same time. Re-read the attachments and try again.`, { code: 'attachment_exists' });
    }
    throw err;
  }
  const views = await attachmentViews(spec, spec.headRevision);
  const view = views.find((v) => v.id === row.id);
  if (!view) throw new Error('attachment not readable after insert');
  return { ok: true, attachment: view, upload: signed };
}

/** Stop an attachment applying from the next revision it can (stopsFrom). Older revisions keep it. Needs write access. */
export async function removeSpecAttachment(caller: SpecCaller, specId: string, name: string): Promise<{ ok: true; removedFromRevision: number } | SpecError> {
  const spec = await loadSpec(caller, specId, true);
  if (isError(spec)) return spec;
  const from = stopsFrom(spec);
  const [row] = await db.update(specAttachments).set({ removedFromRevision: from, removedBy: author(caller).label, removedAt: new Date() })
    .where(and(eq(specAttachments.specId, specId), eq(specAttachments.name, name), isNull(specAttachments.removedFromRevision)))
    .returning({ id: specAttachments.id });
  if (!row) return fail(404, `This spec has no attachment named ${name}`);
  return { ok: true, removedFromRevision: from };
}

/** The file behind `attachment:<name>` on a revision (default the head), for a caller who reaches the spec. */
export async function openSpecAttachment(caller: SpecCaller, specId: string, name: string, opts: { revision?: number }): Promise<
  { ok: true; artifactId: string; storageKey: string | null; uploadState: string | null; filename: string | null; mimeType: string | null } | SpecError
> {
  const spec = await loadSpec(caller, specId, false);
  if (isError(spec)) return spec;
  const n = opts.revision ?? spec.headRevision;
  if (!Number.isInteger(n) || n < 1 || n > spec.headRevision) return fail(404, `Spec has no revision ${n}`);
  const hit = (await applying(specId, n)).find((r) => r.row.name === name);
  if (!hit) return fail(404, `Revision ${n} has no attachment named ${name}`);
  const filename = typeof hit.art.metadata?.filename === 'string' ? hit.art.metadata.filename : null;
  return { ok: true, artifactId: hit.art.id, storageKey: hit.art.storageKey, uploadState: hit.art.uploadState, filename, mimeType: mimeOf(hit.art) };
}
