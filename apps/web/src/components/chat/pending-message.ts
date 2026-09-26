/**
 * A new chat's first message, parked across the navigation to its page. The
 * conversation page sends it on arrival, once.
 */
export const PENDING_KEY = (id: string) => `buildd-chat-pending:${id}`;

export function parkPending(id: string, text: string): void {
  try { window.sessionStorage.setItem(PENDING_KEY(id), text); } catch { /* private mode */ }
}

/** Read and clear. */
export function takePending(id: string): string | null {
  try {
    const text = window.sessionStorage.getItem(PENDING_KEY(id));
    window.sessionStorage.removeItem(PENDING_KEY(id));
    return text;
  } catch {
    return null;
  }
}
