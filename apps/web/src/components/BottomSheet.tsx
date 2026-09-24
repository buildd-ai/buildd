'use client';

import { useEffect, useRef } from 'react';

interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  /**
   * The element whose scroll is locked while the sheet is open. Defaults to
   * `document.body`, so existing consumers see no change. The app shell scrolls
   * inside `<main class="overflow-y-auto">` (`(protected)/layout.tsx`), where a
   * body lock does nothing — the mission task sheet passes `<main>` here.
   */
  lockTarget?: () => HTMLElement | null;
  /**
   * `auto` (default): content height, capped at 85vh.
   * `tall`: a fixed 88% sheet whose body scrolls — the task sheet over a mission.
   */
  height?: 'auto' | 'tall';
  /** `data-testid` on the dialog panel. */
  testId?: string;
}

/** The element to lock: `lockTarget()` when it resolves, else `body`. */
export function resolveLockTarget(
  lockTarget: (() => HTMLElement | null) | undefined,
  body: HTMLElement,
): HTMLElement {
  return lockTarget?.() ?? body;
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
}: BottomSheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Read through a ref so an inline `() => main` does not re-run the lock effect every render.
  const lockTargetRef = useRef(lockTarget);
  lockTargetRef.current = lockTarget;

  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKey);
    const unlock = lockScroll(resolveLockTarget(lockTargetRef.current, document.body));
    return () => {
      document.removeEventListener('keydown', handleKey);
      unlock();
    };
  }, [open, onClose]);

  if (!open) return null;

  const tall = height === 'tall';

  return (
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
        className={`relative w-full max-w-lg bg-surface-1 border-t border-border-default rounded-t-lg shadow-lg pb-[env(safe-area-inset-bottom)] ${
          tall ? 'flex flex-col h-[88dvh] overflow-hidden' : 'max-h-[85vh] overflow-y-auto'
        }`}
      >
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
        <div className={tall ? 'flex-1 min-h-0 overflow-y-auto overscroll-contain p-4' : 'p-4'}>{children}</div>
      </div>
    </div>
  );
}
