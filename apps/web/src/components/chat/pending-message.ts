/**
 * A new chat's first message, parked across the navigation to its page. The
 * conversation page sends it on arrival, once. The kit's
 * `createPendingMessages` (session storage, read-and-clear), under buildd's
 * key prefix so a message parked by an older tab still lands.
 */
import { createPendingMessages } from '@builddai/ai-kit/chat/react';
import type { ChatDraftAttachment } from '@buildd/shared';

const pending = createPendingMessages({ prefix: 'buildd-chat-pending:' });

export const PENDING_KEY = (id: string) => pending.key(id);

export function parkPending(id: string, text: string, attachments: readonly ChatDraftAttachment[] = []): void {
  pending.park(id, text);
  // Long pastes and ready uploads ride beside the text, ids and all, so the
  // first send keeps their identities. A file's browser-local preview does not
  // survive the navigation, so it is not parked.
  try {
    const parked = attachments.map(a => ('kind' in a && a.kind === 'file' ? { kind: a.kind, id: a.id, name: a.name, mediaType: a.mediaType, sizeBytes: a.sizeBytes } : a));
    if (parked.length > 0) window.sessionStorage.setItem(ATTACHMENTS_KEY(id), JSON.stringify(parked));
  } catch { /* private mode or quota: the text still goes; the paste stays in the composer only */ }
}

const ATTACHMENTS_KEY = (id: string) => `buildd-chat-pending-attachments:${id}`;

/** Read and clear the parked attachments. */
export function takePendingAttachments(id: string): ChatDraftAttachment[] {
  try {
    const raw = window.sessionStorage.getItem(ATTACHMENTS_KEY(id));
    window.sessionStorage.removeItem(ATTACHMENTS_KEY(id));
    const parsed = raw ? JSON.parse(raw) as unknown : null;
    return Array.isArray(parsed)
      ? parsed.filter((a): a is ChatDraftAttachment => !!a && typeof a.id === 'string' && (
        (typeof a.text === 'string' && typeof a.title === 'string')
        || (a.kind === 'file' && typeof a.name === 'string' && typeof a.mediaType === 'string' && typeof a.sizeBytes === 'number')))
      : [];
  } catch {
    return [];
  }
}

/** Read and clear. */
export function takePending(id: string): string | null {
  return pending.take(id);
}
