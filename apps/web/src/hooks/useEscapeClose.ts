import { useEffect, type RefObject } from 'react';

/**
 * Something else on the page that owns Escape: a dialog, or a text field whose
 * own Escape handling (clearing, cancelling an edit) must not also close us.
 */
const OWNS_ESCAPE = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  'dialog',
  'input',
  'textarea',
  'select',
  '[contenteditable=""]',
  '[contenteditable="true"]',
].join(',');

/**
 * Disclosure helper: while `open`, Escape calls `close` and moves focus back
 * to the trigger, so keyboard users are not left on a node that just unmounted.
 *
 * Listens on document (focus may be anywhere in the panel), so it stands down
 * when the key was already handled (`defaultPrevented`) or when it came from
 * outside `rootRef` inside a dialog or an editable field that owns Escape.
 */
export function useEscapeClose(
  open: boolean,
  close: () => void,
  triggerRef: RefObject<HTMLElement | null>,
  rootRef: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const target = e.target instanceof Element ? e.target : null;
      const inside = !!target && !!rootRef.current?.contains(target);
      if (!inside && target?.closest(OWNS_ESCAPE)) return;
      close();
      triggerRef.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, close, triggerRef, rootRef]);
}
