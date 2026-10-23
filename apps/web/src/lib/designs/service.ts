import { createHash, randomUUID } from 'crypto';
import { db } from '@buildd/core/db';
import { artifactRevisions, artifacts, specRevisions, specs, workspaces, type ArtifactLinkSubject } from '@buildd/core/db/schema';
import { ArtifactType } from '@buildd/shared';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { isUuid } from '@/lib/uuid';
import { deleteObject, isStorageConfigured, readObject, uploadBuffer } from '@/lib/storage';
import { buildArtifactKey } from '@/lib/storage-keys';
import { resolveWorkspaceAccess } from '@/lib/workspace-access';
import {
  actorOf, artifactsLinkedTo, canAccessWorkspace, linkArtifact, linksOfArtifact, loadLinkSubject, unlinkArtifact,
  type LinkCaller, type LinkRow,
} from '@/lib/artifact-links';
import { extractScreens, parseScreens, type DesignScreen } from './screens';
import { isAdoptableFile, planAdoption } from './adopt';
import { DESIGN_ATTACH_KINDS, planStore, specPinnedArtifact, type DesignAttachKind } from './store';
import { DESIGN_STORED_CONTENT_TYPE, validateDesignHtml } from './upload';

/**
 * Designs in buildd (Living Spec f43b6a61, slice 1): one HTML export of a
 * design canvas becomes an artifact (metadata.kind = 'design'), stored in
 * object storage, and is attached to a mission, task or spec revision with a
 * `design_reference` artifact link. No schema of its own: revisions are the
 * artifact revisions, so a new export is the next revision of the same design.
 *
 * The HTML is untrusted. It is read as text for its screen markers and never
 * executed; the object is written as inert text (DESIGN_STORED_CONTENT_TYPE).
 */
export const DESIGN_KIND = 'design';
export const DESIGN_RELATION = 'design_reference' as const;

export type DesignError = { ok: false; status: 400 | 403 | 404 | 409 | 413 | 415 | 503; error: string; field?: string };
const fail = (status: DesignError['status'], error: string, field?: string): DesignError => ({ ok: false, status, error, ...(field ? { field } : {}) });

export interface AttachInput { kind: DesignAttachKind; id: string; /** spec only: the spec revision number; the head when omitted. */ revision?: number }
export interface DesignView {
  id: string; title: string | null; workspaceId: string | null; revision: number;
  screens: DesignScreen[]; source: string | null; sizeBytes: number | null;
}
const view = (a: { id: string; title: string | null; workspaceId: string | null; currentRevision: number; metadata: unknown }): DesignView => {
  const m = (a.metadata ?? {}) as { screens?: DesignScreen[]; source?: string; sizeBytes?: number };
  return { id: a.id, title: a.title, workspaceId: a.workspaceId, revision: a.currentRevision, screens: m.screens ?? [], source: m.source ?? null, sizeBytes: m.sizeBytes ?? null };
};

interface Target { subjectKind: ArtifactLinkSubject; subjectId: string; workspaceId: string | null; /** spec: the revision number this resolves to. */ specRevision?: number }

async function resolveTarget(input: AttachInput): Promise<Target | DesignError> {
  if (!DESIGN_ATTACH_KINDS.includes(input.kind)) return fail(400, `attachTo.kind must be one of: ${DESIGN_ATTACH_KINDS.join(', ')}`, 'attachTo');
  if (typeof input.id !== 'string' || !isUuid(input.id)) return fail(400, 'attachTo.id must be a UUID', 'attachTo');
  if (input.revision !== undefined && (!Number.isInteger(input.revision) || input.revision < 1)) return fail(400, 'attachTo.revision must be a positive integer', 'attachTo');
  if (input.kind === 'spec') {
    const [spec] = await db.select({ headRevision: specs.headRevision, workspaceId: specs.workspaceId }).from(specs).where(eq(specs.id, input.id)).limit(1);
    if (!spec) return fail(404, 'spec not found');
    const revision = input.revision ?? spec.headRevision;
    const [rev] = await db.select({ id: specRevisions.id }).from(specRevisions)
      .where(and(eq(specRevisions.specId, input.id), eq(specRevisions.revision, revision))).limit(1);
    if (!rev) return fail(404, `spec has no revision ${revision}`);
    return { subjectKind: 'spec_revision', subjectId: rev.id, workspaceId: spec.workspaceId, specRevision: revision };
  }
  const subject = await loadLinkSubject(input.kind, input.id);
  if (!subject) return fail(404, `${input.kind} not found`);
  return { subjectKind: input.kind, subjectId: input.id, workspaceId: subject.workspaceId };
}

const isErr = (v: unknown): v is DesignError => !!v && typeof v === 'object' && (v as { ok?: unknown }).ok === false;

async function loadDesign(caller: LinkCaller, designId: string) {
  if (!isUuid(designId)) return null;
  const [a] = await db.select({
    id: artifacts.id, title: artifacts.title, workspaceId: artifacts.workspaceId, currentRevision: artifacts.currentRevision,
    metadata: artifacts.metadata, storageKey: artifacts.storageKey,
  }).from(artifacts).where(and(eq(artifacts.id, designId), sql`${artifacts.metadata}->>'kind' = ${DESIGN_KIND}`)).limit(1);
  // Missing, not a design and unreachable read the same.
  if (!a || !a.workspaceId || !(await canAccessWorkspace(caller, a.workspaceId))) return null;
  return a;
}

/** An adopted file is read whole to find its screens; a larger one is not a design export. */
const ADOPT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * A design to attach: a design artifact, or an HTML file already in buildd that
 * declares its screens, which is marked a design here (its bytes and revisions
 * are untouched). An artifact the caller cannot reach, or that is neither,
 * reads as not found.
 */
async function loadDesignOrAdopt(caller: LinkCaller, designId: string): Promise<Awaited<ReturnType<typeof loadDesign>> | DesignError> {
  const design = await loadDesign(caller, designId);
  if (design || !isUuid(designId)) return design;
  const [a] = await db.select({
    id: artifacts.id, title: artifacts.title, workspaceId: artifacts.workspaceId, currentRevision: artifacts.currentRevision,
    metadata: artifacts.metadata, storageKey: artifacts.storageKey, uploadState: artifacts.uploadState,
  }).from(artifacts).where(eq(artifacts.id, designId)).limit(1);
  const metadata = (a?.metadata ?? null) as Record<string, unknown> | null;
  if (!a || !a.workspaceId || !(await canAccessWorkspace(caller, a.workspaceId))) return null;
  if (!isAdoptableFile({ storageKey: a.storageKey, metadata }) || (a.uploadState && a.uploadState !== 'ready')) return null;
  if (!isStorageConfigured()) return fail(503, 'Storage not configured');
  const bytes = await readObject(a.storageKey!, ADOPT_MAX_BYTES);
  if (!bytes) return fail(413, 'This file could not be read as a design (missing, or over 8 MB)');
  const plan = planAdoption(bytes.toString('utf8'));
  if (!plan.ok) return fail(400, plan.message, plan.field);
  const patch = { kind: DESIGN_KIND, screens: plan.screens };
  await db.update(artifacts)
    .set({ metadata: sql`coalesce(${artifacts.metadata}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb` })
    .where(eq(artifacts.id, a.id));
  return { ...a, metadata: { ...(metadata ?? {}), ...patch } };
}

export interface StoreInput {
  html: unknown;
  /** The content type the request declared, when it declared one. */
  declaredType?: string | null;
  title?: string;
  screens?: unknown;
  source?: string;
  /** A new export of this design becomes its next revision. */
  designId?: string;
  /** A workspace id, repo name or owner/repo; needed only when nothing else names one. */
  workspaceId?: string;
  attachTo?: AttachInput;
  /** Pin the attachment to a revision; a mission or task link follows the current one when omitted. */
  pin?: number;
}

export interface StoreResult { ok: true; design: DesignView; attached: { linkId: string; pinnedRevision: number | null } | null; attachError?: string }

export async function storeDesign(caller: LinkCaller, input: StoreInput): Promise<StoreResult | DesignError> {
  const checked = validateDesignHtml(input.html, input.declaredType);
  if (!checked.ok) return fail(checked.status, checked.error, 'html');
  const parsed = input.screens !== undefined && input.screens !== null ? parseScreens(input.screens) : extractScreens(input.html as string);
  if (!parsed.ok) return fail(400, parsed.message, parsed.field);
  if (input.title !== undefined && (typeof input.title !== 'string' || input.title.length > 200)) return fail(400, 'title must be at most 200 characters', 'title');
  if (input.source !== undefined && (typeof input.source !== 'string' || input.source.length > 2000)) return fail(400, 'source must be at most 2000 characters', 'source');

  const target = input.attachTo ? await resolveTarget(input.attachTo) : null;
  if (isErr(target)) return target;

  const existing = input.designId ? await loadDesign(caller, input.designId) : null;
  if (input.designId && !existing) return fail(404, 'design not found');

  let workspaceId: string | null = existing?.workspaceId ?? target?.workspaceId ?? null;
  if (input.workspaceId) {
    const ref = await resolveWorkspaceAccess(input.workspaceId, 'userId' in caller ? { userId: caller.userId } : { account: caller.account });
    if (!ref.ok) return fail(ref.status === 404 ? 404 : 403, ref.error);
    if (workspaceId && workspaceId !== ref.workspace.id) return fail(400, 'workspaceId does not match the workspace of the design or of what it is attached to', 'workspaceId');
    workspaceId = ref.workspace.id;
  }
  if (!workspaceId) return fail(400, 'workspaceId is required when the design is not attached to something that belongs to a workspace', 'workspaceId');
  if (!(await canAccessWorkspace(caller, workspaceId))) return fail(404, 'workspace not found');
  const [ws] = await db.select({ dataClass: workspaces.dataClass }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (ws?.dataClass === 'sensitive') return fail(403, 'Content upload is not permitted for sensitive workspaces');
  if (!isStorageConfigured()) return fail(503, 'Storage not configured');

  const plan = planStore({
    ...(existing ? { existing: { id: existing.id, currentRevision: existing.currentRevision } } : {}),
    screens: parsed.screens,
    ...(input.attachTo ? { attachTo: { kind: input.attachTo.kind, id: input.attachTo.id } } : {}),
    bytes: checked.bytes.byteLength,
  });

  const id = existing?.id ?? randomUUID();
  const storageKey = buildArtifactKey(workspaceId, id, existing ? `design-r${plan.revision}.html` : 'design.html');
  const sha256 = createHash('sha256').update(checked.bytes).digest('hex');
  const designMeta = {
    kind: DESIGN_KIND, filename: 'design.html', mimeType: DESIGN_STORED_CONTENT_TYPE, sizeBytes: checked.bytes.byteLength,
    screens: parsed.screens, ...(input.source !== undefined ? { source: input.source } : {}),
  };
  await uploadBuffer(storageKey, checked.bytes, DESIGN_STORED_CONTENT_TYPE);

  let revision: number;
  try {
    if (existing) {
      // Compare-and-swap on the revision the plan was made from: two exports
      // racing cannot both become the same revision.
      const rows = await db.update(artifacts)
        .set({
          storageKey, uploadState: 'ready', contentAuthor: actorOf(caller), updatedAt: new Date(),
          ...(input.title ? { title: input.title } : {}),
          metadata: sql`coalesce(${artifacts.metadata}, '{}'::jsonb) || ${JSON.stringify(designMeta)}::jsonb`,
        })
        .where(and(eq(artifacts.id, id), eq(artifacts.currentRevision, existing.currentRevision)))
        .returning({ currentRevision: artifacts.currentRevision });
      if (rows.length === 0) {
        await deleteObject(storageKey).catch(() => {});
        return fail(409, 'The design changed while this export was uploading; send it again');
      }
      revision = rows[0]!.currentRevision;
    } else {
      const [row] = await db.insert(artifacts).values({
        id, workspaceId, type: ArtifactType.FILE, title: input.title || 'Design', storageKey, uploadState: 'ready',
        contentAuthor: actorOf(caller), shareToken: null, visibility: 'private', metadata: designMeta,
      }).returning({ currentRevision: artifacts.currentRevision });
      revision = row!.currentRevision;
    }
  } catch (err) {
    await deleteObject(storageKey).catch(() => {});
    throw err;
  }
  // The revision row the trigger just recorded gets its hash (NULL -> value is the one change it allows).
  await db.update(artifactRevisions)
    .set({ contentHash: sha256, sizeBytes: checked.bytes.byteLength })
    .where(and(eq(artifactRevisions.artifactId, id), eq(artifactRevisions.revision, revision), isNull(artifactRevisions.contentHash)));

  let attached: StoreResult['attached'] = null;
  let attachError: string | undefined;
  if (target) {
    // A spec revision pins the design it was written against; a mission or task follows the latest.
    const pin = input.pin ?? (target.subjectKind === 'spec_revision' ? revision : undefined);
    const linked = await linkArtifact(caller, id, { subjectKind: target.subjectKind, subjectId: target.subjectId, relation: DESIGN_RELATION, ...(pin ? { revision: pin } : {}) });
    if (linked.ok) attached = { linkId: linked.link.id, pinnedRevision: linked.link.artifactRevision };
    else attachError = linked.error;
  }

  const [row] = await db.select({ id: artifacts.id, title: artifacts.title, workspaceId: artifacts.workspaceId, currentRevision: artifacts.currentRevision, metadata: artifacts.metadata })
    .from(artifacts).where(eq(artifacts.id, id)).limit(1);
  return { ok: true, design: view(row!), attached, ...(attachError ? { attachError } : {}) };
}

export async function attachDesign(caller: LinkCaller, designId: string, input: { attachTo: AttachInput; pin?: number }): Promise<{ ok: true; link: LinkRow } | DesignError> {
  const design = await loadDesignOrAdopt(caller, designId);
  if (isErr(design)) return design;
  if (!design) return fail(404, 'design not found');
  const target = await resolveTarget(input.attachTo);
  if (isErr(target)) return target;
  const pin = input.pin ?? (target.subjectKind === 'spec_revision' ? design.currentRevision : undefined);
  const linked = await linkArtifact(caller, design.id, { subjectKind: target.subjectKind, subjectId: target.subjectId, relation: DESIGN_RELATION, ...(pin ? { revision: pin } : {}) });
  return linked.ok ? linked : fail(linked.status, linked.error);
}

export async function detachDesign(caller: LinkCaller, designId: string, linkId: string): Promise<{ ok: true } | DesignError> {
  const design = await loadDesign(caller, designId);
  if (!design) return fail(404, 'design not found');
  // Only a design link: this is not a way to remove an artifact's other links.
  const links = await linksOfArtifact(caller, design.id);
  if (!links.ok) return fail(links.status, links.error);
  if (!links.links.some(l => l.id === linkId && l.relation === DESIGN_RELATION)) return fail(404, 'Link not found');
  const r = await unlinkArtifact(caller, design.id, linkId);
  return r.ok ? r : fail(r.status, r.error);
}

export interface DesignListEntry extends DesignView {
  linkId?: string; pinnedRevision?: number | null;
  /** The design the spec revision itself pins (not an attachment); there is no link to remove. */
  specPin?: true;
}

export async function listDesigns(
  caller: LinkCaller, scope: { attachTo: AttachInput } | { workspaceId: string },
): Promise<{ ok: true; designs: DesignListEntry[] } | DesignError> {
  if ('attachTo' in scope) {
    const target = await resolveTarget(scope.attachTo);
    if (isErr(target)) return target;
    const linked = await artifactsLinkedTo(target.subjectKind, target.subjectId, { caller, relations: [DESIGN_RELATION] });
    if (!Array.isArray(linked)) return fail(linked.status, linked.error);
    // A spec revision pins a design on the revision itself, with no link: list it, labelled as a pin.
    let pin: { artifactId: string; revision: number } | null = null;
    if (target.subjectKind === 'spec_revision') {
      const [rev] = await db.select({ design: specRevisions.design }).from(specRevisions).where(eq(specRevisions.id, target.subjectId)).limit(1);
      pin = specPinnedArtifact(rev?.design);
    }
    if (linked.length === 0 && !pin) return { ok: true, designs: [] };
    const wanted = [...linked.map(l => l.artifactId), ...(pin ? [pin.artifactId] : [])];
    const rows = await db.select({ id: artifacts.id, title: artifacts.title, workspaceId: artifacts.workspaceId, currentRevision: artifacts.currentRevision, metadata: artifacts.metadata })
      .from(artifacts).where(and(inArray(artifacts.id, wanted), sql`${artifacts.metadata}->>'kind' = ${DESIGN_KIND}`));
    const byId = new Map(rows.map(r => [r.id, r]));
    const designs: DesignListEntry[] = linked.flatMap(l => {
      const r = byId.get(l.artifactId);
      return r ? [{ ...view(r), linkId: l.linkId, pinnedRevision: l.pinnedRevision }] : [];
    });
    const pinned = pin && !linked.some(l => l.artifactId === pin!.artifactId) ? byId.get(pin.artifactId) : undefined;
    if (pin && pinned && (await canAccessWorkspace(caller, pinned.workspaceId ?? ''))) {
      designs.push({ ...view(pinned), pinnedRevision: pin.revision, specPin: true });
    }
    return { ok: true, designs };
  }
  const ref = await resolveWorkspaceAccess(scope.workspaceId, 'userId' in caller ? { userId: caller.userId } : { account: caller.account });
  if (!ref.ok || !(await canAccessWorkspace(caller, ref.workspace.id))) return fail(404, 'workspace not found');
  const rows = await db.select({ id: artifacts.id, title: artifacts.title, workspaceId: artifacts.workspaceId, currentRevision: artifacts.currentRevision, metadata: artifacts.metadata })
    .from(artifacts).where(and(eq(artifacts.workspaceId, ref.workspace.id), sql`${artifacts.metadata}->>'kind' = ${DESIGN_KIND}`))
    .orderBy(sql`${artifacts.updatedAt} desc`).limit(100);
  return { ok: true, designs: rows.map(view) };
}
