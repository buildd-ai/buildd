/**
 * Pages that hold their own primary action in the floating Ask button's corner.
 * The spec page puts Approve there while a revision waits, and the Ask button
 * would otherwise sit on top of it, louder. A counted hold, like
 * needs-input-hidden.ts: the page mounts deep in the tree, the button lives in
 * the chat canvas provider. ⌘K still opens the canvas while the button hides.
 */
import { useEffect, useSyncExternalStore } from 'react';

let holds = 0;
const listeners = new Set<() => void>();
const publish = () => { for (const l of listeners) l(); };

/** Hide the Ask button until the returned release is called (idempotent, counted). */
export function hideAskButton(): () => void {
  holds += 1;
  publish();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds = Math.max(0, holds - 1);
    publish();
  };
}

export function askButtonHiddenSnapshot(): boolean {
  return holds > 0;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Whether a page holds the Ask button's corner right now. */
export function useAskButtonHidden(): boolean {
  return useSyncExternalStore(subscribe, askButtonHiddenSnapshot, askButtonHiddenSnapshot);
}

/** While mounted and `active`, the Ask button hides. */
export function useHideAskButton(active: boolean): void {
  useEffect(() => (active ? hideAskButton() : undefined), [active]);
}
