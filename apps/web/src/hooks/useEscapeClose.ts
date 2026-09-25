import { useEffect, type RefObject } from 'react';

/**
 * Disclosure helper: while `open`, Escape calls `close` and moves focus back
 * to the trigger, so keyboard users are not left on a node that just unmounted.
 */
export function useEscapeClose(
  open: boolean,
  close: () => void,
  triggerRef: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      close();
      triggerRef.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, close, triggerRef]);
}
