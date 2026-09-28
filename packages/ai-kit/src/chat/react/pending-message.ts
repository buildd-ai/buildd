/**
 * A new chat's first message, parked across the navigation to its page. The
 * page that starts a chat creates the conversation, parks the text under its
 * id and navigates; the conversation page takes it on arrival and sends it,
 * once. `take` reads and clears, so a reload never sends it twice.
 *
 * Session storage by default (per tab, gone when the tab closes). Private
 * mode or a storage error degrades to "nothing parked", never a throw.
 */

/** The subset of `Storage` this needs, so a test or native shell can pass its own. */
export interface PendingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PendingMessages {
  /** The storage key for a conversation. */
  key(conversationId: string): string;
  park(conversationId: string, text: string): void;
  /** Read and clear. Null when nothing is parked. */
  take(conversationId: string): string | null;
}

export const DEFAULT_PENDING_PREFIX = 'kit-chat-pending:';

function sessionStore(): PendingStorage | null {
  try {
    return typeof window !== 'undefined' && window.sessionStorage ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

export function createPendingMessages(opts: { prefix?: string; storage?: () => PendingStorage | null } = {}): PendingMessages {
  const prefix = opts.prefix ?? DEFAULT_PENDING_PREFIX;
  const storage = opts.storage ?? sessionStore;
  const key = (id: string) => `${prefix}${id}`;
  return {
    key,
    park(id, text) {
      try { storage()?.setItem(key(id), text); } catch { /* private mode */ }
    },
    take(id) {
      try {
        const s = storage();
        if (!s) return null;
        const text = s.getItem(key(id));
        s.removeItem(key(id));
        return text;
      } catch {
        return null;
      }
    },
  };
}
