import { randomUUID } from 'node:crypto';
import { db } from '@buildd/core/db';
import { artifactLinks, artifactRevisions, artifacts, conversationMessages } from '@buildd/core/db/schema';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  ArtifactType, CHAT_FILE_MEDIA_TYPES, CHAT_FILE_PART_TYPE, CHAT_MAX_FILE_BYTES,
  type ChatFileDraft, type ChatFileRef, type ChatMessagePart,
} from '@buildd/shared';
import { isUuid } from '@/lib/uuid';
import { buildChatUploadKey } from '@/lib/storage-keys';
import { uploadBuffer } from '@/lib/storage';
import { defaultUploadStorage, finalizeArtifactUpload, type FinalizeResult, type UploadStorage } from '@/lib/artifact-upload';
import { MAX_ATTACHMENTS_PER_MESSAGE, type AttachmentError } from '@/lib/artifact-chat-attachments';

/**
 * Images and files attached to chat messages (Living Specs C3;
 * docs/specs/artifacts-and-sharing.md §11).
 *
 * The original bytes go up before the message is sent: `createChatUpload`
 * makes a `pending` artifact and a presigned PUT signed for the exact size and
 * media type, `finalizeChatUpload` checks the stored object (lib/artifact-upload.ts:
 * size, type, sha256) and marks it `ready` or `failed`. The message then names
 * the ready upload in a `data-file` part; `bindChatFiles` refuses anything not
 * ready, ties the upload to the conversation (once), and the turn links it to
 * the saved message. An upload never sent has no link, so the stale-upload
 * sweep removes it; `cancelChatUpload` removes one at once.
 *
 * Like a paste (lib/artifact-chat-attachments.ts) the artifact has no workspace
 * and no worker, so the artifact routes never reach it. Before send only its
 * uploader can finalize or cancel it; after send it is read through its
 * conversation only, by the conversation's owner.
 */

export const CHAT_FILE_TYPES: readonly string[] = CHAT_FILE_MEDIA_TYPES;
export const MAX_CHAT_FILE_BYTES = CHAT_MAX_FILE_BYTES;
const MAX_NAME_CHARS = 200;

const fail = (status: 400 | 409, code: string, error: string): AttachmentError => ({ ok: false, status, code, error });

/** `Image/PNG; x=y` -> `image/png`. */
export function chatMediaType(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.split(';')[0]!.trim().toLowerCase();
  return CHAT_FILE_TYPES.includes(t) ? t : null;
}

/** What the artifact row records about a chat upload. */
interface ChatUploadMeta {
  teamId: string;
  ownerUserId: string;
  /** Null until the message that carries it is sent; then fixed. */
  conversationId: string | null;
  source: 'upload';
}

function uploadMetaOf(metadata: unknown): ChatUploadMeta | null {
  const m = (metadata as { chatAttachment?: Partial<ChatUploadMeta> } | null)?.chatAttachment;
  if (!m || m.source !== 'upload' || typeof m.teamId !== 'string' || typeof m.ownerUserId !== 'string') return null;
  return { teamId: m.teamId, ownerUserId: m.ownerUserId, conversationId: typeof m.conversationId === 'string' ? m.conversationId : null, source: 'upload' };
}

export type CreateUploadResult =
  | { ok: true; artifactId: string; storageKey: string; mediaType: string; sizeBytes: number; name: string }
  | { ok: false; status: 400 | 413; code: string; error: string };

/** Validate and record a new upload. The caller signs the PUT for `storageKey`. */
export async function createChatUpload(args: {
  teamId: string; userId: string; name: unknown; mediaType: unknown; sizeBytes: unknown;
}): Promise<CreateUploadResult> {
  const mediaType = chatMediaType(args.mediaType);
  if (!mediaType) return { ok: false, status: 400, code: 'file_type_unsupported', error: `file type must be one of ${CHAT_FILE_TYPES.join(', ')}` };
  const size = args.sizeBytes;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) return { ok: false, status: 400, code: 'file_size_invalid', error: 'sizeBytes must be a positive integer' };
  if (size > MAX_CHAT_FILE_BYTES) return { ok: false, status: 413, code: 'file_too_large', error: `a file is at most ${MAX_CHAT_FILE_BYTES / (1024 * 1024)} MB` };
  const name = (typeof args.name === 'string' ? args.name.trim() : '').slice(0, MAX_NAME_CHARS) || 'file';
  const id = randomUUID();
  const storageKey = buildChatUploadKey(args.teamId, id, name);
  const meta: ChatUploadMeta = { teamId: args.teamId, ownerUserId: args.userId, conversationId: null, source: 'upload' };
  await db.insert(artifacts).values({
    id,
    workspaceId: null,
    workerId: null,
    type: ArtifactType.FILE,
    title: name,
    storageKey,
    uploadState: 'pending',
    shareToken: null,
    visibility: 'private',
    contentAuthor: `user:${args.userId}`,
    metadata: { filename: name, mimeType: mediaType, sizeBytes: size, chatAttachment: meta },
  });
  return { ok: true, artifactId: id, storageKey, mediaType, sizeBytes: size, name };
}

export const isImage = (mediaType: string): boolean => mediaType.startsWith('image/');

interface UploadRow {
  id: string; storageKey: string | null; uploadState: string | null; title: string | null;
  workspaceId: string | null; workerId: string | null; metadata: unknown; currentRevision: number;
}

async function uploadRow(artifactId: string): Promise<UploadRow | null> {
  if (!isUuid(artifactId)) return null;
  const [row] = await db.select({
    id: artifacts.id, storageKey: artifacts.storageKey, uploadState: artifacts.uploadState, title: artifacts.title,
    workspaceId: artifacts.workspaceId, workerId: artifacts.workerId, metadata: artifacts.metadata, currentRevision: artifacts.currentRevision,
  }).from(artifacts).where(eq(artifacts.id, artifactId.toLowerCase())).limit(1);
  return row ?? null;
}

/** The caller's own upload, before or after send; anything else reads as not found. */
async function ownUpload(artifactId: string, userId: string, teamIds: readonly string[]) {
  const row = await uploadRow(artifactId);
  const meta = row ? uploadMetaOf(row.metadata) : null;
  if (!row || !meta || row.workspaceId !== null || row.workerId !== null || !row.storageKey) return null;
  if (meta.ownerUserId !== userId || !teamIds.includes(meta.teamId)) return null;
  return { row, meta };
}

/** Verify the uploader's bytes (size, type, optional sha256). Only the uploader may. */
export async function finalizeChatUpload(
  artifactId: string, userId: string, teamIds: readonly string[],
  opts: { expectedSha256?: string | null; storage?: UploadStorage } = {},
): Promise<FinalizeResult> {
  const own = await ownUpload(artifactId, userId, teamIds);
  if (!own) return { state: 'missing' };
  return finalizeArtifactUpload(own.row.id, opts);
}

/** Largest body the relay route takes: under the platform's 4.5 MB request ceiling. */
export const MAX_RELAYED_UPLOAD_BYTES = 4 * 1024 * 1024;

/**
 * Store an upload's bytes on the uploader's behalf (the relay for a refused
 * direct PUT). Exactly the signed size and media type, only while pending.
 */
export async function storeChatUploadBytes(
  artifactId: string, userId: string, teamIds: readonly string[], bytes: Buffer, contentType: string | null,
  put: (key: string, body: Buffer, type: string) => Promise<void> = uploadBuffer,
): Promise<{ ok: true } | { ok: false; status: 400 | 404 | 409 | 413; error: string }> {
  const own = await ownUpload(artifactId, userId, teamIds);
  if (!own) return { ok: false, status: 404, error: 'Upload not found' };
  if (own.row.uploadState !== 'pending') return { ok: false, status: 409, error: 'This upload already finished' };
  const meta = own.row.metadata as { mimeType?: unknown; sizeBytes?: unknown } | null;
  if (bytes.byteLength > MAX_RELAYED_UPLOAD_BYTES) return { ok: false, status: 413, error: 'Too large to relay; upload it directly' };
  if (bytes.byteLength !== Number(meta?.sizeBytes)) return { ok: false, status: 400, error: 'The body is not the size the upload was started with' };
  const type = chatMediaType(meta?.mimeType);
  if (!type || chatMediaType(contentType) !== type) return { ok: false, status: 400, error: 'The body is not the type the upload was started with' };
  await put(own.row.storageKey!, bytes, type);
  return { ok: true };
}

/**
 * Take an upload back before it is sent: the row and its object go. One a
 * message already carries (it has a link) is kept.
 */
export async function cancelChatUpload(
  artifactId: string, userId: string, teamIds: readonly string[], storage: UploadStorage = defaultUploadStorage,
): Promise<{ ok: true; removed: boolean } | { ok: false; status: 404 | 409; error: string }> {
  const own = await ownUpload(artifactId, userId, teamIds);
  if (!own) return { ok: false, status: 404, error: 'Upload not found' };
  const gone = await db.delete(artifacts)
    .where(and(
      eq(artifacts.id, own.row.id),
      sql`NOT EXISTS (SELECT 1 FROM ${artifactLinks} WHERE ${artifactLinks.artifactId} = ${artifacts.id})`,
    ))
    .returning({ id: artifacts.id });
  if (gone.length === 0) return { ok: false, status: 409, error: 'This file was already sent' };
  await storage.remove(own.row.storageKey!).catch(() => {});
  return { ok: true, removed: true };
}

/** The file drafts a user message carries, validated. */
export function fileDraftsOf(parts: readonly ChatMessagePart[]): { ok: true; drafts: ChatFileDraft[] } | AttachmentError {
  const raw = parts.filter(p => p.type === CHAT_FILE_PART_TYPE);
  if (raw.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    return fail(400, 'too_many_attachments', `a message carries at most ${MAX_ATTACHMENTS_PER_MESSAGE} files`);
  }
  const drafts: ChatFileDraft[] = [];
  const seen = new Set<string>();
  for (const p of raw) {
    const d = (p as { data?: Partial<ChatFileDraft> }).data;
    if (!d || typeof d.id !== 'string' || !isUuid(d.id)) return fail(400, 'file_invalid', 'a file needs the id of its upload');
    const id = d.id.toLowerCase();
    if (seen.has(id)) return fail(400, 'file_invalid', 'a file appears twice in one message');
    seen.add(id);
    // Name, type and size are read from the upload itself, never from the part.
    drafts.push({ kind: 'file', id, name: String(d.name ?? ''), mediaType: String(d.mediaType ?? ''), sizeBytes: Number(d.sizeBytes ?? 0) });
  }
  return { ok: true, drafts };
}

/**
 * Tie each ready upload to this conversation and return the references the
 * saved message keeps. Refused, with nothing changed for the refused one: an
 * upload that is not the sender's, not ready (uploading, failed), or already
 * sent in another conversation. A retry of the same message in the same
 * conversation is the same file (identity fixed at send).
 */
export async function bindChatFiles(
  conv: { id: string; teamId: string }, userId: string, drafts: readonly ChatFileDraft[],
): Promise<{ ok: true; refs: ChatFileRef[] } | AttachmentError> {
  const refs: ChatFileRef[] = [];
  for (const d of drafts) {
    const own = await ownUpload(d.id, userId, [conv.teamId]);
    if (!own) return fail(409, 'file_not_found', 'this file is not one of your uploads; attach it again');
    if (own.row.uploadState !== 'ready') {
      return fail(409, 'file_not_ready', own.row.uploadState === 'failed' ? 'this file failed its upload check; attach it again' : 'this file has not finished uploading');
    }
    if (own.meta.conversationId && own.meta.conversationId !== conv.id) {
      return fail(409, 'file_taken', 'this file was sent in another conversation; attach it again');
    }
    if (!own.meta.conversationId) {
      // Fixed once: only while still unbound, so two conversations can never both claim it.
      const bound = await db.update(artifacts)
        .set({ metadata: sql`jsonb_set(${artifacts.metadata}, '{chatAttachment,conversationId}', to_jsonb(${conv.id}::text))` })
        .where(and(
          eq(artifacts.id, own.row.id),
          sql`${artifacts.metadata} #>> '{chatAttachment,conversationId}' IS NULL`,
        ))
        .returning({ id: artifacts.id });
      if (bound.length === 0) {
        const again = await ownUpload(d.id, userId, [conv.teamId]);
        if (again?.meta.conversationId !== conv.id) return fail(409, 'file_taken', 'this file was sent in another conversation; attach it again');
      }
    }
    const revision = own.row.currentRevision > 0 ? own.row.currentRevision : 1;
    const [rev] = await db.select({ contentHash: artifactRevisions.contentHash, sizeBytes: artifactRevisions.sizeBytes }).from(artifactRevisions)
      .where(and(eq(artifactRevisions.artifactId, own.row.id), eq(artifactRevisions.revision, revision))).limit(1);
    const meta = own.row.metadata as { mimeType?: unknown; sizeBytes?: unknown; filename?: unknown } | null;
    if (!rev?.contentHash) return fail(409, 'file_not_ready', 'this file has not finished uploading');
    refs.push({
      artifactId: own.row.id,
      revision,
      sha256: rev.contentHash,
      name: own.row.title ?? String(meta?.filename ?? 'file'),
      mediaType: chatMediaType(meta?.mimeType) ?? 'application/octet-stream',
      sizeBytes: rev.sizeBytes ?? Number(meta?.sizeBytes ?? 0),
    });
  }
  return { ok: true, refs };
}

/** The message part that stands in for a stored file. */
export const fileRefPart = (ref: ChatFileRef): ChatMessagePart => ({ type: CHAT_FILE_PART_TYPE, data: ref } as ChatMessagePart);

/** A stored file reference, from a saved part. */
export function fileRefOf(part: ChatMessagePart): ChatFileRef | null {
  if (part.type !== CHAT_FILE_PART_TYPE) return null;
  const d = (part as { data?: Partial<ChatFileRef> }).data;
  if (!d || typeof d.artifactId !== 'string' || typeof d.revision !== 'number' || typeof d.sha256 !== 'string') return null;
  return {
    artifactId: d.artifactId, revision: d.revision, sha256: d.sha256,
    name: String(d.name ?? 'file'), mediaType: String(d.mediaType ?? 'application/octet-stream'), sizeBytes: Number(d.sizeBytes ?? 0),
  };
}

export interface ConversationFile extends ChatFileRef { messageId: string; storageKey: string }

/** Every file this conversation's messages carry, oldest message first. */
export async function conversationFiles(conversationId: string, artifactIds?: readonly string[]): Promise<ConversationFile[]> {
  if (artifactIds && artifactIds.length === 0) return [];
  const rows = await db.select({
    artifactId: artifactLinks.artifactId,
    revision: artifactLinks.artifactRevision,
    messageId: conversationMessages.id,
    title: artifacts.title,
    metadata: artifacts.metadata,
    workspaceId: artifacts.workspaceId,
    storageKey: artifacts.storageKey,
    uploadState: artifacts.uploadState,
    contentHash: artifactRevisions.contentHash,
    sizeBytes: artifactRevisions.sizeBytes,
  })
    .from(artifactLinks)
    .innerJoin(conversationMessages, eq(conversationMessages.id, artifactLinks.subjectId))
    .innerJoin(artifacts, eq(artifacts.id, artifactLinks.artifactId))
    .innerJoin(artifactRevisions, and(eq(artifactRevisions.artifactId, artifactLinks.artifactId), eq(artifactRevisions.revision, artifactLinks.artifactRevision)))
    .where(and(
      eq(artifactLinks.subjectKind, 'message'),
      eq(artifactLinks.relation, 'context'),
      eq(conversationMessages.conversationId, conversationId),
      ...(artifactIds ? [inArray(artifactLinks.artifactId, [...artifactIds])] : []),
    ))
    .orderBy(conversationMessages.createdAt);
  return rows
    // Only this conversation's own, verified uploads: a link can never make another artifact readable here.
    .filter(r => r.workspaceId === null && r.uploadState === 'ready' && !!r.storageKey && !!r.contentHash
      && uploadMetaOf(r.metadata)?.conversationId === conversationId)
    .map(r => {
      const meta = r.metadata as { mimeType?: unknown; sizeBytes?: unknown } | null;
      return {
        artifactId: r.artifactId, revision: r.revision ?? 1, sha256: r.contentHash!, name: r.title ?? 'file',
        mediaType: chatMediaType(meta?.mimeType) ?? 'application/octet-stream',
        sizeBytes: r.sizeBytes ?? Number(meta?.sizeBytes ?? 0), messageId: r.messageId, storageKey: r.storageKey!,
      };
    });
}

/** The storage key of a ready chat upload (and only of one). */
export async function chatUploadKey(artifactId: string): Promise<string | null> {
  const row = await uploadRow(artifactId);
  if (!row || row.workspaceId !== null || row.uploadState !== 'ready' || !uploadMetaOf(row.metadata)) return null;
  return row.storageKey;
}

/** One file of this conversation, for its download. The caller has proven it owns the conversation. */
export async function conversationFile(conversationId: string, artifactId: string): Promise<ConversationFile | null> {
  if (!isUuid(artifactId)) return null;
  const [f] = await conversationFiles(conversationId, [artifactId.toLowerCase()]);
  return f ?? null;
}
