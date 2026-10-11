/**
 * A new chat's first message, parked across the navigation to its page. The
 * conversation page sends it on arrival, once. The kit's
 * `createPendingMessages` (session storage, read-and-clear), under buildd's
 * key prefix so a message parked by an older tab still lands.
 */
import { createPendingMessages } from '@builddai/ai-kit/chat/react';
import type { ChatAttachmentDraft } from '@buildd/shared';

const pending = createPendingMessages({ prefix: 'buildd-chat-pending:' });

export const PENDING_KEY = (id: string) => pending.key(id);

export function parkPending(id: string, text: string, attachments: readonly ChatAttachmentDraft[] = []): void {
  pending.park(id, text);
  // Long pastes ride beside the text, ids and all, so the first send keeps its identities.
  try {
    if (attachments.length > 0) window.sessionStorage.setItem(ATTACHMENTS_KEY(id), JSON.stringify(attachments));
  } catch { /* private mode or quota: the text still goes; the paste stays in the composer only */ }
}

const ATTACHMENTS_KEY = (id: string) => `buildd-chat-pending-attachments:${id}`;

/** Read and clear the parked attachments. */
export function takePendingAttachments(id: string): ChatAttachmentDraft[] {
  try {
    const raw = window.sessionStorage.getItem(ATTACHMENTS_KEY(id));
    window.sessionStorage.removeItem(ATTACHMENTS_KEY(id));
    const parsed = raw ? JSON.parse(raw) as unknown : null;
    return Array.isArray(parsed)
      ? parsed.filter((a): a is ChatAttachmentDraft => !!a && typeof a.id === 'string' && typeof a.text === 'string' && typeof a.title === 'string')
      : [];
  } catch {
    return [];
  }
}

/** Read and clear. */
export function takePending(id: string): string | null {
  return pending.take(id);
}
