import { db } from '@buildd/core/db';
import {
  ARTIFACT_LINK_RELATIONS, ARTIFACT_LINK_SUBJECTS, artifactLinks, artifactRevisions, artifacts, conversationMessages,
  conversations, missions, tasks, workspaces,
  type ArtifactLinkRelation, type ArtifactLinkSubject,
} from '@buildd/core/db/schema';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { isUuid } from '@/lib/uuid';
import { resolveWorkspaceAccess, type WorkspaceAccessCaller } from '@/lib/workspace-access';
import { getUserTeamIds } from '@/lib/team-access';
import { isStorageConfigured } from '@/lib/storage';
import { finalizeArtifactUpload } from '@/lib/artifact-upload';

/**
 * Typed artifact links (schema: artifact_links). One artifact, many subjects,
 * no copies. Living Specs owns the table; this module is its only writer.
 *
 * A link is allowed only when the caller could read the artifact and reach the
 * subject, and both belong to the same team: a link never carries an artifact
 * into another team's context, and never lets a caller attach to a subject it
 * cannot see. A `normative_reference` is always pinned to a revision (the
 * table's CHECK enforces it; an unpinned request pins the current body).
 */

/** The subject kinds that exist today; spec revisions and verifications come later. */
const LINKABLE: ReadonlySet<ArtifactLinkSubject> = new Set(['conversation', 'message', 'task', 'mission', 'plan']);

export type LinkCaller =
  | { kind: 'user'; userId: string }
  | {
    kind: 'account';
    account: Extract<WorkspaceAccessCaller, { account: unknown }>['account'];
    /** A per-task token's confinement: only this workspace's artifacts and subjects. */
    taskScope?: { workspaceId: string } | null;
  };

const accessCaller = (c: LinkCaller): WorkspaceAccessCaller => (c.kind === 'user' ? { userId: c.userId } : { account: c.account });

/** Workspace access, confined to its own workspace for a per-task token. */
async function canAccessWorkspace(caller: LinkCaller, workspaceId: string): Promise<boolean> {
  if (caller.kind === 'account' && caller.taskScope && caller.taskScope.workspaceId !== workspaceId) return false;
  return (await resolveWorkspaceAccess(workspaceId, accessCaller(caller))).ok;
}
const actorOf = (c: LinkCaller) => (c.kind === 'user' ? `user:${c.userId}` : `account:${c.account.id}`);

export type LinkError = { ok: false; status: 400 | 403 | 404 | 409; error: string };
const fail = (status: LinkError['status'], error: string): LinkError => ({ ok: false, status, error });

interface Subject { teamId: string; workspaceId: string | null; ownerUserId?: string }

async function teamOfWorkspace(workspaceId: string | null): Promise<string | null> {
  if (!workspaceId) return null;
  const [w] = await db.select({ teamId: workspaces.teamId }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  return w?.teamId ?? null;
}

async function loadSubject(kind: ArtifactLinkSubject, id: string): Promise<Subject | null> {
  switch (kind) {
    case 'task':
    case 'plan': {
      const [t] = await db.select({ workspaceId: tasks.workspaceId }).from(tasks).where(eq(tasks.id, id)).limit(1);
      const teamId = t ? await teamOfWorkspace(t.workspaceId) : null;
      return t && teamId ? { teamId, workspaceId: t.workspaceId } : null;
    }
    case 'mission': {
      const [m] = await db.select({ teamId: missions.teamId, workspaceId: missions.workspaceId }).from(missions).where(eq(missions.id, id)).limit(1);
      return m ? { teamId: m.teamId, workspaceId: m.workspaceId } : null;
    }
    case 'conversation': {
      const [c] = await db.select({ teamId: conversations.teamId, workspaceId: conversations.workspaceId, ownerUserId: conversations.createdByUserId })
        .from(conversations).where(eq(conversations.id, id)).limit(1);
      return c ?? null;
    }
    case 'message': {
      const [m] = await db.select({ conversationId: conversationMessages.conversationId }).from(conversationMessages).where(eq(conversationMessages.id, id)).limit(1);
      return m ? loadSubject('conversation', m.conversationId) : null;
    }
    default:
      return null;
  }
}

/** Whether the caller may see the subject. Chat subjects are their creator's only. */
async function canReachSubject(caller: LinkCaller, s: Subject): Promise<boolean> {
  if (s.ownerUserId !== undefined) return caller.kind === 'user' && caller.userId === s.ownerUserId;
  if (s.workspaceId) return canAccessWorkspace(caller, s.workspaceId);
  if (caller.kind === 'account' && caller.taskScope) return false;
  return caller.kind === 'user' ? (await getUserTeamIds(caller.userId)).includes(s.teamId) : caller.account.teamId === s.teamId;
}

interface ArtifactRow { id: string; workspaceId: string | null; currentRevision: number; hasBody: boolean; teamId: string | null; uploadState: 'pending' | 'ready' | 'failed' | null }

async function loadArtifact(id: string): Promise<ArtifactRow | null> {
  const [a] = await db
    .select({
      id: artifacts.id, workspaceId: artifacts.workspaceId, currentRevision: artifacts.currentRevision,
      hasBody: sql<boolean>`(${artifacts.content} IS NOT NULL OR ${artifacts.storageKey} IS NOT NULL)`,
      teamId: workspaces.teamId, uploadState: artifacts.uploadState,
    })
    .from(artifacts)
    .leftJoin(workspaces, eq(workspaces.id, artifacts.workspaceId))
    .where(eq(artifacts.id, id))
    .limit(1);
  return a ?? null;
}

async function canReadArtifact(caller: LinkCaller, a: ArtifactRow): Promise<boolean> {
  return !!a.workspaceId && canAccessWorkspace(caller, a.workspaceId);
}

async function revisionExists(a: ArtifactRow, revision: number): Promise<boolean> {
  if (revision === 1 && a.currentRevision === 0 && a.hasBody) return true; // a body from before revisions
  const [r] = await db.select({ n: artifactRevisions.revision }).from(artifactRevisions)
    .where(and(eq(artifactRevisions.artifactId, a.id), eq(artifactRevisions.revision, revision))).limit(1);
  return !!r;
}

export interface LinkInput { subjectKind: unknown; subjectId: unknown; relation: unknown; revision?: unknown }
export type LinkRow = typeof artifactLinks.$inferSelect;

export async function linkArtifact(caller: LinkCaller, artifactId: string, input: LinkInput): Promise<{ ok: true; link: LinkRow } | LinkError> {
  const { subjectKind, subjectId, relation, revision } = input;
  if (!ARTIFACT_LINK_SUBJECTS.includes(subjectKind as ArtifactLinkSubject)) return fail(400, `subjectKind must be one of: ${ARTIFACT_LINK_SUBJECTS.join(', ')}`);
  if (!LINKABLE.has(subjectKind as ArtifactLinkSubject)) return fail(400, `${subjectKind} links are not available yet`);
  if (!ARTIFACT_LINK_RELATIONS.includes(relation as ArtifactLinkRelation)) return fail(400, `relation must be one of: ${ARTIFACT_LINK_RELATIONS.join(', ')}`);
  if (typeof subjectId !== 'string' || !isUuid(subjectId)) return fail(400, 'subjectId must be a UUID');
  if (revision !== undefined && revision !== null && (!Number.isInteger(revision) || (revision as number) < 1)) return fail(400, 'revision must be a positive integer');

  const a = await loadArtifact(artifactId);
  // Missing and unreadable read the same: existence outside reach is not confirmed.
  if (!a || !(await canReadArtifact(caller, a))) return fail(404, 'Artifact not found');
  const subject = await loadSubject(subjectKind as ArtifactLinkSubject, subjectId);
  if (!subject || !(await canReachSubject(caller, subject))) return fail(404, `${subjectKind} not found`);
  if (subject.teamId !== a.teamId) return fail(403, 'An artifact can be linked only to a subject of its own team');
  // An upload is linkable only once its bytes are verified; a pending one gets
  // the same lazy finalize a read gives it (lib/artifact-upload.ts).
  let uploadState = a.uploadState;
  if (uploadState === 'pending' && isStorageConfigured()) {
    const finalized = (await finalizeArtifactUpload(a.id)).state;
    if (finalized === 'ready' || finalized === 'failed') uploadState = finalized;
  }
  if (uploadState === 'pending') return fail(409, 'Artifact upload is still pending: finalize it once its bytes have arrived, then link it');
  if (uploadState === 'failed') return fail(409, 'Artifact upload failed verification and cannot be linked');

  let pinned: number | null = (revision as number | undefined) ?? null;
  if (pinned === null && relation === 'normative_reference') pinned = a.currentRevision > 0 ? a.currentRevision : (a.hasBody ? 1 : null);
  if (relation === 'normative_reference' && pinned === null) return fail(409, 'A normative reference pins a revision, and this artifact has no body yet');
  if (pinned !== null && !(await revisionExists(a, pinned))) return fail(404, `Artifact has no revision ${pinned}`);

  const [link] = await db.insert(artifactLinks)
    .values({ artifactId, artifactRevision: pinned, subjectKind: subjectKind as ArtifactLinkSubject, subjectId, relation: relation as ArtifactLinkRelation, teamId: subject.teamId, createdBy: actorOf(caller) })
    .onConflictDoUpdate({
      target: [artifactLinks.artifactId, artifactLinks.subjectKind, artifactLinks.subjectId, artifactLinks.relation],
      set: { artifactRevision: pinned, createdBy: actorOf(caller) },
    })
    .returning();
  return { ok: true, link };
}

export async function unlinkArtifact(caller: LinkCaller, artifactId: string, linkId: string): Promise<{ ok: true } | LinkError> {
  if (!isUuid(linkId)) return fail(404, 'Link not found');
  const [link] = await db.select().from(artifactLinks).where(and(eq(artifactLinks.id, linkId), eq(artifactLinks.artifactId, artifactId))).limit(1);
  const a = link ? await loadArtifact(artifactId) : null;
  const subject = link ? await loadSubject(link.subjectKind, link.subjectId) : null;
  if (!link || !a || !(await canReadArtifact(caller, a)) || !subject || !(await canReachSubject(caller, subject))) return fail(404, 'Link not found');
  await db.delete(artifactLinks).where(eq(artifactLinks.id, linkId));
  // A mission's context links mirror the legacy contextArtifactIds column, which
  // readers still union in: drop the id there too, or the unlink would not take.
  if (link.subjectKind === 'mission' && link.relation === 'context') {
    await db.update(missions)
      .set({ contextArtifactIds: sql`coalesce(${missions.contextArtifactIds}, '[]'::jsonb) - ${artifactId}::text` })
      .where(eq(missions.id, link.subjectId));
  }
  return { ok: true };
}

/**
 * The dual-write of a mission's `contextArtifactIds`: one `context` link per
 * id, through the same checks as any link. The ids were already authorized by
 * checkContextArtifactIds; an id that fails here is reported, not fatal, since
 * the legacy column still carries it.
 */
export async function linkContextArtifacts(caller: LinkCaller, subjectKind: 'mission', subjectId: string, artifactIds: readonly string[]): Promise<{ linked: string[]; failed: Array<{ artifactId: string; error: string }> }> {
  const linked: string[] = [];
  const failed: Array<{ artifactId: string; error: string }> = [];
  for (const artifactId of artifactIds) {
    const r = await linkArtifact(caller, artifactId, { subjectKind, subjectId, relation: 'context' });
    if (r.ok) linked.push(artifactId); else failed.push({ artifactId, error: r.error });
  }
  return { linked, failed };
}

/** The links of one artifact the caller can read, each with a subject the caller can reach. */
export async function linksOfArtifact(caller: LinkCaller, artifactId: string): Promise<{ ok: true; links: LinkRow[] } | LinkError> {
  const a = await loadArtifact(artifactId);
  if (!a || !(await canReadArtifact(caller, a))) return fail(404, 'Artifact not found');
  const rows = await db.select().from(artifactLinks).where(and(eq(artifactLinks.artifactId, artifactId), eq(artifactLinks.teamId, a.teamId!)));
  const visible: LinkRow[] = [];
  for (const r of rows) {
    const s = await loadSubject(r.subjectKind, r.subjectId);
    if (s && (await canReachSubject(caller, s))) visible.push(r);
  }
  return { ok: true, links: visible };
}

export interface LinkedArtifact {
  linkId: string; artifactId: string; relation: ArtifactLinkRelation; pinnedRevision: number | null;
  title: string | null; type: string; currentRevision: number; contentHash: string | null;
  /** Bytes of the revision the link resolves to (a file's recorded size); null when unknown. */
  sizeBytes: number | null;
}

/**
 * What is linked to a subject: a compact reference manifest (ids, titles,
 * relations, pins and hashes), never the bodies. Read with `get_artifact`.
 * Only artifacts in a workspace of the subject's team, readable by the caller
 * when one is given (a system read, e.g. planning context, passes none).
 */
export async function artifactsLinkedTo(
  subjectKind: ArtifactLinkSubject, subjectId: string, opts: { caller?: LinkCaller; relations?: ArtifactLinkRelation[] } = {},
): Promise<LinkedArtifact[] | LinkError> {
  const subject = await loadSubject(subjectKind, subjectId);
  if (!subject || (opts.caller && !(await canReachSubject(opts.caller, subject)))) return fail(404, `${subjectKind} not found`);
  const rows = await db
    .select({
      linkId: artifactLinks.id, artifactId: artifacts.id, relation: artifactLinks.relation, pinnedRevision: artifactLinks.artifactRevision,
      title: artifacts.title, type: artifacts.type, currentRevision: artifacts.currentRevision, workspaceId: artifacts.workspaceId,
      contentHash: artifactRevisions.contentHash,
      sizeBytes: sql<number | null>`coalesce(
        ${artifactRevisions.sizeBytes}::bigint,
        octet_length(${artifactRevisions.content})::bigint,
        octet_length(${artifacts.content})::bigint,
        CASE WHEN ${artifacts.metadata}->>'sizeBytes' ~ '^[0-9]{1,15}$' THEN (${artifacts.metadata}->>'sizeBytes')::bigint END
      )::float8`,
    })
    .from(artifactLinks)
    .innerJoin(artifacts, eq(artifacts.id, artifactLinks.artifactId))
    .innerJoin(workspaces, and(eq(workspaces.id, artifacts.workspaceId), eq(workspaces.teamId, subject.teamId)))
    .leftJoin(artifactRevisions, and(
      eq(artifactRevisions.artifactId, artifacts.id),
      sql`${artifactRevisions.revision} = coalesce(${artifactLinks.artifactRevision}, ${artifacts.currentRevision})`,
    ))
    .where(and(
      eq(artifactLinks.subjectKind, subjectKind), eq(artifactLinks.subjectId, subjectId), eq(artifactLinks.teamId, subject.teamId),
      ...(opts.relations?.length ? [inArray(artifactLinks.relation, opts.relations)] : []),
    ));
  const out: LinkedArtifact[] = [];
  const readable = new Map<string, boolean>();
  for (const r of rows) {
    if (opts.caller && r.workspaceId) {
      if (!readable.has(r.workspaceId)) readable.set(r.workspaceId, await canAccessWorkspace(opts.caller, r.workspaceId));
      if (!readable.get(r.workspaceId)) continue;
    }
    const { workspaceId: _ws, ...rest } = r;
    out.push(rest);
  }
  return out;
}
