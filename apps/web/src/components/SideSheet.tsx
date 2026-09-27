'use client';

/**
 * SideSheet: the one place a page opens a panel beside its content — a task,
 * Records, Notes, goal criteria, settings, an edit form. Docked at 420px on
 * the right at md+ (no backdrop: the page stays readable and clickable), a
 * tall bottom sheet on a phone (backdrop, `<main>` scroll locked, focus kept
 * inside).
 *
 * Sheets stack (lib/side-sheet-stack.ts): opening Records over a task shows
 * Records in the same place with `‹ Back` to the task, never a centered modal
 * over the docked sheet. Back and Escape pop the top sheet; ✕ closes them all.
 *
 * Confirmations for destructive actions are not sheets; they stay dialogs.
 */
import { useEffect, useId, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { lockScroll, nextTrappedFocus } from '@/components/BottomSheet';
import {
  closeAllSheets, getServerSheetStack, getSheetStack, pushSheet, removeSheet, sheetPosition, subscribeSheets, updateSheet,
} from '@/lib/side-sheet-stack';

/** md breakpoint: at and above it the sheet docks right instead of sliding up. */
export const SIDE_SHEET_DOCK_QUERY = '(min-width: 768px)';

export type SideSheetLayout = 'sheet' | 'docked';

function subscribeDock(onChange: () => void) {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mq = window.matchMedia(SIDE_SHEET_DOCK_QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}
const readDock = () => typeof window !== 'undefined' && !!window.matchMedia?.(SIDE_SHEET_DOCK_QUERY).matches;

/** Mobile-first: `sheet` on the server and below md, `docked` at md+. */
export function useSideSheetLayout(): SideSheetLayout {
  return useSyncExternalStore(subscribeDock, readDock, () => false) ? 'docked' : 'sheet';
}

export interface SideSheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  testId?: string;
  /** Force a layout (tests, a caller that already knows). Default: by viewport. */
  layout?: SideSheetLayout;
  /** Extra attributes on the panel. */
  panelData?: Readonly<Record<`data-${string}`, string>>;
  /** Phone only: rendered above the header (a drag handle). */
  handle?: ReactNode;
  /** Changing this brings an already-open sheet back to the top (the task sheet stepping to another task). */
  frontKey?: string;
  /** Drop the body padding for full-bleed rows. */
  flush?: boolean;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const noopSubscribe = () => () => {};
function useCanPortal(): boolean {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}

export default function SideSheet({ open, onClose, title, children, testId, layout: forced, panelData, handle, frontKey, flush = false }: SideSheetProps) {
  const id = useId();
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const canPortal = useCanPortal();
  const viewportLayout = useSideSheetLayout();
  const layout = forced ?? viewportLayout;
  const docked = layout === 'docked';
  const stack = useSyncExternalStore(subscribeSheets, getSheetStack, getServerSheetStack);
  const { top, below } = sheetPosition(stack, id);

  // Register while open; a new frontKey moves the sheet back to the top.
  useEffect(() => {
    if (!open) return;
    pushSheet({ id, title, close: () => closeRef.current() });
    return () => removeSheet(id);
    // Title changes are applied in place below, without reordering.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, id, frontKey]);
  useEffect(() => {
    if (open) updateSheet({ id, title, close: () => closeRef.current() });
  }, [open, id, title]);

  // Focus moves in when the sheet comes to the top. `canPortal` is a dep: a
  // sheet hydrated open first mounts in place, then moves into the portal.
  useEffect(() => {
    if (!open || !top) return;
    const el = panelRef.current;
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
  }, [open, top, canPortal]);

  // Escape pops the top sheet; on a phone Tab stays inside it.
  useEffect(() => {
    if (!open || !top) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeRef.current();
        return;
      }
      const panel = panelRef.current;
      if (e.key !== 'Tab' || docked || !panel) return;
      const target = nextTrappedFocus(Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)), document.activeElement, e.shiftKey);
      if (target) {
        e.preventDefault();
        target.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, top, docked, canPortal]);

  // A phone sheet covers the page: lock the shell's scroller behind it.
  useEffect(() => {
    if (!open || !top || docked) return;
    const main = document.querySelector<HTMLElement>('main');
    return main ? lockScroll(main) : undefined;
  }, [open, top, docked]);

  if (!open) return null;

  // Before registration (the first render) the stack does not know this sheet yet.
  const closeAll = () => {
    if (!getSheetStack().some(e => e.id === id)) closeRef.current();
    closeAllSheets();
  };

  const sheet = (
    <div data-side-sheet="" className={top ? '' : 'hidden'}>
      {!docked && <div aria-hidden="true" onClick={closeAll} className="fixed inset-0 z-50 bg-black/50" />}
      <aside
        ref={panelRef}
        role="dialog"
        aria-label={title}
        aria-modal={docked ? undefined : true}
        tabIndex={-1}
        data-testid={testId}
        data-layout={layout}
        {...(panelData ?? {})}
        className={`fixed flex flex-col bg-surface-1 focus:outline-none focus-visible:outline-none ${
          docked
            ? 'bottom-0 right-0 top-0 z-40 w-[420px] max-w-full border-l-2 border-border-strong'
            : 'inset-x-0 bottom-0 z-50 h-[88dvh] overflow-hidden border-t-2 border-border-strong pb-[env(safe-area-inset-bottom)]'
        }`}
      >
        {!docked && handle}
        <div className="flex min-h-12 shrink-0 items-center gap-1 border-b border-border-default px-2">
          {below && (
            <button
              type="button"
              data-testid="side-sheet-back"
              onClick={() => closeRef.current()}
              aria-label={`Back to ${below.title}`}
              className="flex h-11 shrink-0 items-center gap-1 px-2 font-mono text-[12px] text-text-secondary hover:text-text-primary"
            >
              <span aria-hidden="true">‹</span> Back
            </button>
          )}
          <h2 className={`min-w-0 flex-1 truncate font-mono text-[13px] font-semibold text-text-primary ${below ? '' : 'pl-2'}`}>{title}</h2>
          <button
            type="button"
            data-testid="side-sheet-close"
            onClick={closeAll}
            aria-label="Close"
            className="flex h-11 w-11 shrink-0 items-center justify-center text-text-muted hover:text-text-primary"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className={`min-h-0 flex-1 overflow-y-auto overscroll-contain ${flush ? '' : 'p-4'}`}>{children}</div>
      </aside>
    </div>
  );

  // Portal to <body>, as BottomSheet does: a sticky ancestor would otherwise
  // trap the fixed panel under the bottom nav.
  return canPortal ? createPortal(sheet, document.body) : sheet;
}
