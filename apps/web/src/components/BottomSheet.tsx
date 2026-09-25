'use client';

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { findScrollRoot } from '@/lib/scroll-root';

interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  /**
   * The element whose scroll is locked while the sheet is open. Defaults to the
   * shell's scroll root (`<main data-scroll-root>`, see lib/scroll-root.ts), or
   * `document.body` outside the shell — a body lock does nothing inside the shell.
   */
  lockTarget?: () => HTMLElement | null;
  /**
   * `auto` (default): content height, capped at 85vh.
   * `tall`: a fixed 88% sheet whose body scrolls — the task sheet over a mission.
   */
  height?: 'auto' | 'tall';
  /** `data-testid` on the dialog panel. */
  testId?: string;
  /**
   * Rendered at the very top of the panel, above the title bar and outside the
   * scrolling body — a drag handle stays put while the content scrolls.
   */
  handle?: React.ReactNode;
  /**
   * Modal focus: move focus into the panel when it opens and keep Tab inside it
   * until it closes. Off by default so existing consumers see no change.
   */
  trapFocus?: boolean;
  /** Drop the body's p-4 — for full-bleed rows (a list of options) that pad themselves. */
  flush?: boolean;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The element Tab should move to from `active`, or null to let the browser move. */
export function nextTrappedFocus(
  focusables: readonly HTMLElement[],
  active: Element | null,
  backwards: boolean,
): HTMLElement | null {
  if (focusables.length === 0) return null;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const inside = active !== null && focusables.includes(active as HTMLElement);
  if (backwards) return !inside || active === first ? last : null;
  return !inside || active === last ? first : null;
}

/** The element to lock: `lockTarget()` when it resolves, else `fallback` (the scroll root). */
export function resolveLockTarget(
  lockTarget: (() => HTMLElement | null) | undefined,
  fallback: HTMLElement,
): HTMLElement {
  return lockTarget?.() ?? fallback;
}

const noopSubscribe = () => () => {};
/** False during SSR and hydration, true after — so the portal never causes a hydration mismatch. */
function useCanPortal(): boolean {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}

/** Hide overflow on `el`; the returned function restores the previous value. */
export function lockScroll(el: HTMLElement): () => void {
  const prev = el.style.overflow;
  el.style.overflow = 'hidden';
  return () => {
    el.style.overflow = prev;
  };
}

/**
 * The one disclosure mechanism for tag-tap payoff (docs — mission-card
 * density spec §2: "bottom sheet ... one mechanism only"). Sheet mechanics
 * (backdrop, Escape-to-close, scroll lock) follow the existing hand-rolled
 * pattern in ArtifactViewer.tsx — no shared primitive existed before this.
 */
export default function BottomSheet({
  open,
  onClose,
  title,
  children,
  lockTarget,
  height = 'auto',
  testId,
  handle,
  trapFocus = false,
  flush = false,
}: BottomSheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Read through a ref so an inline `() => main` does not re-run the lock effect every render.
  const lockTargetRef = useRef(lockTarget);
  lockTargetRef.current = lockTarget;

  const trapRef = useRef(trapFocus);
  trapRef.current = trapFocus;

  const canPortal = useCanPortal();

  // `canPortal` is a dep: a sheet hydrated already open (?task= on a hard load)
  // first mounts in place, then moves into the portal as a NEW node. Re-running
  // here re-focuses the live panel; the handler also reads panelRef on each key,
  // so the Tab trap never searches the detached in-place node.
  useEffect(() => {
    if (!open) return;
    const initial = panelRef.current;
    if (trapRef.current && initial && !initial.contains(document.activeElement)) {
      initial.focus({ preventScroll: true });
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
      const panel = panelRef.current;
      if (e.key !== 'Tab' || !trapRef.current || !panel) return;
      const target = nextTrappedFocus(
        Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)),
        document.activeElement,
        e.shiftKey,
      );
      if (target) {
        e.preventDefault();
        target.focus();
      }
    }
    document.addEventListener('keydown', handleKey);
    const unlock = lockScroll(resolveLockTarget(lockTargetRef.current, findScrollRoot(document)));
    return () => {
      document.removeEventListener('keydown', handleKey);
      unlock();
    };
  }, [open, onClose, canPortal]);

  if (!open) return null;

  const tall = height === 'tall';

  const sheet = (
    <div className="fixed inset-0 z-50 flex items-end justify-center" role="presentation">
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid={testId}
        tabIndex={trapFocus ? -1 : undefined}
        className={`relative w-full max-w-lg bg-surface-1 border-t border-border-default rounded-t-lg shadow-lg pb-[env(safe-area-inset-bottom)] focus:outline-none ${
          tall ? 'flex flex-col h-[88dvh] overflow-hidden' : 'max-h-[85vh] overflow-y-auto'
        }`}
      >
        {handle}
        <div className="sticky top-0 flex items-center justify-between px-4 py-3 border-b border-border-default bg-surface-1">
          <h2 className="text-[13px] font-semibold text-text-primary">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="-mr-2 w-11 h-11 flex items-center justify-center text-text-muted hover:text-text-primary transition-colors"
            aria-label="Close"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className={`${tall ? 'flex-1 min-h-0 overflow-y-auto overscroll-contain' : ''} ${flush ? '' : 'p-4'}`}>{children}</div>
      </div>
    </div>
  );

  // Portal to <body>: a fixed/sticky ancestor (the mobile header, a masthead)
  // creates a stacking context, and inside it z-50 still paints under the
  // bottom nav (z-20). React events still bubble through the component tree.
  return canPortal ? createPortal(sheet, document.body) : sheet;
}
