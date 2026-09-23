'use client';

import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { FOCUSABLE_SELECTOR, captureFocus, createBackdropDismiss, handleDialogKeyDown } from './dialog-focus';

type DialogName =
  /** id of the visible heading that names the dialog */
  | { labelledBy: string; label?: never }
  /** accessible name when there is no visible heading */
  | { label: string; labelledBy?: never };

export type DialogProps = DialogName & {
  open: boolean;
  onClose: () => void;
  /** id of the element that describes the dialog (usually the body text). */
  describedBy?: string;
  /** False while a request is in flight: Escape and backdrop clicks are ignored. */
  dismissible?: boolean;
  /** Element to focus on open. Defaults to the first focusable in the panel. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Classes for the panel. Defaults to the standard centered card shell. */
  className?: string;
  children: ReactNode;
};

const DEFAULT_PANEL =
  'bg-surface-2 rounded-lg shadow-xl w-full max-w-[calc(100vw-2rem)] sm:max-w-sm mx-4 outline-none';

/**
 * Shared modal primitive: role="dialog" + aria-modal, a name, Escape to close,
 * a Tab/Shift+Tab focus trap, focus restored to the opener on close, and a
 * backdrop click that closes (only when the press also started on the backdrop). Build overlays on this instead of a hand-rolled
 * `fixed inset-0` div.
 */
export default function Dialog({
  open,
  onClose,
  labelledBy,
  label,
  describedBy,
  dismissible = true,
  initialFocusRef,
  className = DEFAULT_PANEL,
  children,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const backdrop = useRef(createBackdropDismiss()).current;
  // Callers pass inline closures; keep the effect keyed on `open` only so a
  // re-render does not re-run focus capture/restore.
  const latest = useRef({ onClose, dismissible, initialFocusRef });
  latest.current = { onClose, dismissible, initialFocusRef };

  useEffect(() => {
    if (!open) return;
    const restoreFocus = captureFocus(document);
    const panel = panelRef.current;
    const target =
      latest.current.initialFocusRef?.current ??
      (panel?.querySelector(FOCUSABLE_SELECTOR) as HTMLElement | null) ??
      panel;
    target?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function onKeyDown(e: KeyboardEvent) {
      handleDialogKeyDown(e, {
        panel: panelRef.current,
        activeElement: document.activeElement,
        onClose: latest.current.onClose,
        dismissible: latest.current.dismissible,
      });
    }
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      restoreFocus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onMouseDown={backdrop.onMouseDown}
      onClick={(e) => {
        if (backdrop.shouldClose(e) && dismissible) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-label={label}
        aria-describedby={describedBy}
        tabIndex={-1}
        className={className}
      >
        {children}
      </div>
    </div>
  );
}
