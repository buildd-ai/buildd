/**
 * DOM-free focus logic for the shared Dialog primitive, kept separate so it can
 * be unit-tested without a browser (the web tests render with
 * react-dom/server, which never runs effects).
 */

export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

interface Focusable {
  focus(): void;
}

interface DialogPanel extends Focusable {
  querySelectorAll(selector: string): ArrayLike<unknown>;
  contains(node: unknown): boolean;
}

interface KeyEventLike {
  key: string;
  shiftKey: boolean;
  preventDefault(): void;
}

export interface DialogKeyContext {
  panel: DialogPanel | null;
  activeElement: unknown;
  onClose: () => void;
  /** False while a request is in flight: Escape is ignored. */
  dismissible: boolean;
}

/**
 * Escape closes (when dismissible); Tab / Shift+Tab wrap inside the panel so
 * focus cannot walk out behind the backdrop.
 */
export function handleDialogKeyDown(e: KeyEventLike, ctx: DialogKeyContext): void {
  if (e.key === 'Escape') {
    if (!ctx.dismissible) return;
    e.preventDefault();
    ctx.onClose();
    return;
  }
  if (e.key !== 'Tab' || !ctx.panel) return;

  const focusables = Array.from(ctx.panel.querySelectorAll(FOCUSABLE_SELECTOR)) as Focusable[];
  if (focusables.length === 0) {
    e.preventDefault();
    ctx.panel.focus();
    return;
  }

  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const inside = ctx.activeElement != null && ctx.panel.contains(ctx.activeElement);

  if (!inside) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  } else if (e.shiftKey && (ctx.activeElement === first || ctx.activeElement === ctx.panel)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && ctx.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

/**
 * Remembers what had focus when a dialog opened; the returned function puts
 * focus back there when it closes.
 */
export function captureFocus(doc: { activeElement: unknown }): () => void {
  const opener = doc.activeElement as Partial<Focusable> | null;
  return () => {
    if (opener && typeof opener.focus === 'function') opener.focus();
  };
}

interface BackdropEventLike {
  target: unknown;
  currentTarget: unknown;
}

/**
 * Backdrop-click dismissal that ignores drags: a press that starts inside the
 * panel (e.g. selecting text) and is released over the backdrop still fires a
 * click on the backdrop, so closing on `click` alone throws away the dialog.
 * Close only when both the mousedown and the click landed on the backdrop.
 */
export function createBackdropDismiss() {
  let pressedOnBackdrop = false;
  return {
    onMouseDown(e: BackdropEventLike): void {
      pressedOnBackdrop = e.target === e.currentTarget;
    },
    shouldClose(e: BackdropEventLike): boolean {
      const close = pressedOnBackdrop && e.target === e.currentTarget;
      pressedOnBackdrop = false;
      return close;
    },
  };
}
