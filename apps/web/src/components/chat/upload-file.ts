'use client';

import type { ChatFileDraft } from '@buildd/shared';

/**
 * Upload one chat image or file (Living Specs C3): start it, PUT the bytes
 * straight to storage (relayed through the server when the browser's direct
 * PUT is refused and the file is small enough), then finalize with the hash
 * computed here. Resolves only with a verified, ready upload; anything else
 * rejects with a short reason the card shows. Aborting takes the upload back.
 */

/** The relay route's ceiling (lib/artifact-chat-files.ts MAX_RELAYED_UPLOAD_BYTES). */
const MAX_RELAYED_BYTES = 4 * 1024 * 1024;

async function sha256Hex(file: Blob): Promise<string | null> {
  if (typeof crypto === 'undefined' || !crypto.subtle) return null;
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

async function errorOf(res: Response, fallback: string): Promise<Error> {
  const body = await res.json().catch(() => null) as { error?: string; code?: string } | null;
  if (body?.code === 'file_too_large') return new Error('Too large');
  if (body?.code === 'file_type_unsupported') return new Error('File type not supported');
  return new Error(fallback);
}

export async function uploadChatFile(file: File, signal: AbortSignal, teamId: string | null): Promise<ChatFileDraft> {
  const mediaType = file.type;
  const start = await fetch('/api/chat/uploads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: file.name, mediaType, sizeBytes: file.size, ...(teamId ? { teamId } : {}) }),
    signal,
  });
  if (!start.ok) throw await errorOf(start, 'Upload failed');
  const { artifactId, uploadUrl } = await start.json() as { artifactId: string; uploadUrl: string };
  // A cancel after this point takes the upload back.
  signal.addEventListener('abort', () => { void discardChatUpload(artifactId); }, { once: true });

  let stored = false;
  try {
    const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': mediaType }, body: file, signal });
    stored = put.ok;
  } catch (e) {
    if (signal.aborted) throw e;
    // A refused direct PUT (e.g. the bucket's CORS) surfaces as a network error.
  }
  if (!stored && file.size <= MAX_RELAYED_BYTES) {
    const relay = await fetch(`/api/chat/uploads/${artifactId}/content`, { method: 'PUT', headers: { 'Content-Type': mediaType }, body: file, signal });
    stored = relay.ok;
  }
  if (!stored) throw new Error('Upload failed');

  const sha256 = await sha256Hex(file).catch(() => null);
  const fin = await fetch(`/api/chat/uploads/${artifactId}/finalize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sha256 ? { sha256 } : {}),
    signal,
  });
  const result = await fin.json().catch(() => null) as { state?: string } | null;
  if (!fin.ok || result?.state !== 'ready') throw new Error('Upload check failed');
  return { kind: 'file', id: artifactId, name: file.name || 'file', mediaType, sizeBytes: file.size };
}

/** Take back an upload that will not be sent. Best effort: the sweep removes what this misses. */
export async function discardChatUpload(artifactId: string): Promise<void> {
  await fetch(`/api/chat/uploads/${artifactId}`, { method: 'DELETE' }).catch(() => {});
}
