/**
 * Chat attachments outlive nothing they belong to (docs/specs/artifacts-and-sharing.md
 * §10–§11). A paste (C2) or uploaded file (C3) is a workspace-less artifact
 * whose `metadata.chatAttachment` names its team and conversation, linked to
 * the message that carried it. The links carry no foreign key to the message,
 * so when a conversation goes (its team or its creator is deleted, both by
 * cascade) the artifact, its revisions and a file's stored object would stay.
 *
 * An attachment is an orphan when either:
 *  - the conversation it names no longer exists, or
 *  - nothing links to it and it is past STALE_UPLOAD_MS: the message that
 *    would have carried it was never saved (the send failed after the paste
 *    or upload was stored). Unsent uploads with no conversation yet are left to
 *    sweepStaleUploads.
 * Either way it is kept while anything live still refers to it: a link to an
 * existing message, a link to any other kind of subject, or a spec whose body
 * it is. Deleting the row removes its revisions and links (FK cascade); the
 * read ledger is FK-free by design and keeps its content-free rows. A stored
 * object is removed only after its row is gone, so a crash in between leaves a
 * stray object, never a row pointing at nothing.
 */
import { db } from '@buildd/core/db';
import { artifactLinks, artifacts, conversationMessages, conversations, specs } from '@buildd/core/db/schema';
import { and, eq, lt, sql } from 'drizzle-orm';
import { defaultUploadStorage, removeUploadObjects, STALE_UPLOAD_MS, type UploadStorage } from '@/lib/artifact-upload';

const chatAttachment = sql`(${artifacts.workspaceId} IS NULL AND ${artifacts.workerId} IS NULL AND ${artifacts.metadata} #>> '{chatAttachment,source}' IN ('paste', 'upload'))`;

// Anything live still pointing at it: a link to a message that exists, any
// link to another kind of subject, or a spec whose body it is.
const stillReferenced = sql`(
  EXISTS (
    SELECT 1 FROM ${artifactLinks}
    WHERE ${artifactLinks.artifactId} = ${artifacts.id}
      AND (${artifactLinks.subjectKind} <> 'message'
        OR EXISTS (SELECT 1 FROM ${conversationMessages} WHERE ${conversationMessages.id} = ${artifactLinks.subjectId}))
  )
  OR EXISTS (SELECT 1 FROM ${specs} WHERE ${specs.bodyArtifactId} = ${artifacts.id})
)`;

const conversationGone = sql`(
  ${artifacts.metadata} #>> '{chatAttachment,conversationId}' IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM ${conversations}
    WHERE ${conversations.id}::text = ${artifacts.metadata} #>> '{chatAttachment,conversationId}'
  )
)`;

function neverSent(now: Date) {
  return sql`(
    ${artifacts.metadata} #>> '{chatAttachment,conversationId}' IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM ${artifactLinks} WHERE ${artifactLinks.artifactId} = ${artifacts.id})
    AND ${lt(artifacts.createdAt, new Date(now.getTime() - STALE_UPLOAD_MS))}
  )`;
}

function orphan(now: Date, scope: { teamId?: string; conversationId?: string }) {
  return and(
    chatAttachment,
    sql`(${conversationGone} OR ${neverSent(now)})`,
    sql`NOT ${stillReferenced}`,
    scope.teamId ? sql`${artifacts.metadata} #>> '{chatAttachment,teamId}' = ${scope.teamId}` : undefined,
    scope.conversationId ? sql`${artifacts.metadata} #>> '{chatAttachment,conversationId}' = ${scope.conversationId}` : undefined,
  );
}

export interface ChatAttachmentCleanup { removed: number; objectsRemoved: number }

/**
 * Remove orphaned chat attachments, at most `limit` per call. `teamId` or
 * `conversationId` narrow it to what one deletion left behind; without them it
 * is the maintenance sweep. Re-checked in the DELETE itself, so a link made
 * between selection and delete still saves the row.
 */
export async function removeOrphanChatAttachments(opts: {
  teamId?: string;
  conversationId?: string;
  now?: Date;
  limit?: number;
  storage?: UploadStorage;
} = {}): Promise<ChatAttachmentCleanup> {
  const now = opts.now ?? new Date();
  const storage = opts.storage ?? defaultUploadStorage;
  const where = orphan(now, opts);
  const rows = await db.select({ id: artifacts.id }).from(artifacts).where(where).limit(opts.limit ?? 200);
  let removed = 0, objectsRemoved = 0;
  for (const r of rows) {
    const gone = await db.delete(artifacts)
      .where(and(eq(artifacts.id, r.id), where))
      .returning({ id: artifacts.id, storageKey: artifacts.storageKey });
    if (gone.length === 0) continue;
    removed++;
    const key = gone[0]!.storageKey;
    if (key) {
      await removeUploadObjects(storage, key).then(() => { objectsRemoved++; }, (err) => {
        console.error('[chat-attachments] stored object not removed', err instanceof Error ? err.message : err);
      });
    }
  }
  return { removed, objectsRemoved };
}

/**
 * After a team is deleted: remove its chat attachments in the same request, in
 * bounded batches. Never throws; anything left is the maintenance sweep's.
 */
export async function removeTeamChatAttachments(teamId: string, opts: { storage?: UploadStorage; batches?: number } = {}): Promise<ChatAttachmentCleanup> {
  const total: ChatAttachmentCleanup = { removed: 0, objectsRemoved: 0 };
  const limit = 200;
  try {
    for (let i = 0; i < (opts.batches ?? 10); i++) {
      const r = await removeOrphanChatAttachments({ teamId, limit, storage: opts.storage });
      total.removed += r.removed;
      total.objectsRemoved += r.objectsRemoved;
      if (r.removed < limit) break;
    }
  } catch (err) {
    console.error('[chat-attachments] team cleanup stopped', err instanceof Error ? err.message : err);
  }
  return total;
}
