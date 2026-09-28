/**
 * A new chat's first message, parked across the navigation to its page. The
 * conversation page sends it on arrival, once. The kit's
 * `createPendingMessages` (session storage, read-and-clear), under buildd's
 * key prefix so a message parked by an older tab still lands.
 */
import { createPendingMessages } from '@builddai/ai-kit/chat/react';

const pending = createPendingMessages({ prefix: 'buildd-chat-pending:' });

export const PENDING_KEY = (id: string) => pending.key(id);

export function parkPending(id: string, text: string): void {
  pending.park(id, text);
}

/** Read and clear. */
export function takePending(id: string): string | null {
  return pending.take(id);
}
