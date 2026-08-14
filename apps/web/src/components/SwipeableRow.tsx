'use client';

import { useState, useRef, useCallback, useContext, createContext, useEffect, useId, type ReactNode, type JSX } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

export type SwipeCardType =
  | 'gate-card'        // Waiting-on-you gate card (Home, escalation inbox)
  | 'escalation-card'  // Escalation proposal card (escalation inbox)
  | 'blocked-task'     // Blocked task row (Activity list, mission timeline)
  | 'needs-attention'  // Needs-attention mission card (Home, missions list)
  | 'running-task'     // Running / queued task (no left swipe action)
  | 'completed-task';  // Completed task row (Activity list, mission timeline)

export type SwipeAction =
  | 'snooze-24h'
  | 'snooze-3d'
  | 'snooze-7d'
  | 'snooze-notification';

export type MenuActionId =
  | SwipeAction
  | 'open-github'
  | 'cancel-task'
  | 'file-anyway'
  | 'ignore'
  | 'view-pr'
  | 'view-blocked-tasks'
  | 'go-to-pr';

export interface TrailingActionConfig {
  action: SwipeAction;
  label: string;
  bgColor: string;
}

export interface MenuAction {
  action: MenuActionId;
  label: string;
  href?: string;
  destructive?: boolean;
}

// ─── Pure logic (exported for tests) ─────────────────────────────────────────

/**
 * Classify a pointer gesture by the angle of travel.
 * Returns 'horizontal' if < 30° from horizontal (swipe wins),
 * 'vertical' if > 60° from horizontal (scroll wins),
 * 'ambiguous' between 30° and 60°.
 */
export function classifyGestureAngle(
  dx: number,
  dy: number,
): 'horizontal' | 'vertical' | 'ambiguous' {
  const angleFromHorizontal =
    Math.abs(Math.atan2(Math.abs(dy), Math.abs(dx)) * (180 / Math.PI));
  if (angleFromHorizontal < 30) return 'horizontal';
  if (angleFromHorizontal > 60) return 'vertical';
  return 'ambiguous';
}

/** Per §2.2 swipe action table — left swipe trailing action per card type. */
export function getTrailingAction(cardType: SwipeCardType): TrailingActionConfig | null {
  switch (cardType) {
    case 'gate-card':
      return { action: 'snooze-24h', label: 'Snooze 24 h', bgColor: 'var(--accent)' };
    case 'escalation-card':
      // Acknowledge was client-local only (evaporated on reload, nothing consumed it).
      // Use the menu actions (file-anyway, ignore) for escalation decisions.
      return null;
    case 'blocked-task':
      return { action: 'snooze-notification', label: 'Snooze', bgColor: 'var(--surface-4)' };
    case 'needs-attention':
      return { action: 'snooze-24h', label: 'Snooze 24 h', bgColor: 'var(--surface-4)' };
    case 'completed-task':
      // Dismiss was client-local only (evaporated on reload, nothing consumed it).
      // Completed tasks need no swipe action — use the filter to hide them.
      return null;
    case 'running-task':
      return null; // §2.2: running/queued has no swipe action
  }
}

/** Per §2.2 ⋯ menu contents per card type. */
export function getMenuActions(
  cardType: SwipeCardType,
  opts: { prUrl?: string | null; taskId?: string },
): MenuAction[] {
  switch (cardType) {
    case 'gate-card':
      return [
        { action: 'snooze-24h', label: 'Snooze 24 h' },
        { action: 'snooze-3d', label: 'Snooze 3 d' },
        { action: 'snooze-7d', label: 'Snooze 7 d' },
        ...(opts.prUrl
          ? [{ action: 'open-github' as const, label: 'Open in GitHub', href: opts.prUrl }]
          : []),
      ];
    case 'escalation-card':
      return [
        { action: 'file-anyway', label: 'File anyway' },
        { action: 'ignore', label: 'Ignore' },
      ];
    case 'blocked-task':
      return [
        ...(opts.prUrl
          ? [{ action: 'go-to-pr' as const, label: 'Go to blocking PR', href: opts.prUrl }]
          : []),
        { action: 'snooze-notification', label: 'Snooze notification' },
      ];
    case 'needs-attention':
      return [
        { action: 'snooze-24h', label: 'Snooze 24 h' },
        { action: 'view-blocked-tasks', label: 'View blocked tasks' },
      ];
    case 'running-task':
      return [{ action: 'cancel-task', label: 'Cancel task', destructive: true }];
    case 'completed-task':
      return [
        ...(opts.prUrl
          ? [{ action: 'view-pr' as const, label: 'View PR ↗', href: opts.prUrl }]
          : []),
      ];
  }
}

// ─── Trailing action icon ─────────────────────────────────────────────────────

function TrailingActionIcon({ action }: { action: SwipeAction }): JSX.Element {
  switch (action) {
    case 'snooze-24h':
    case 'snooze-3d':
    case 'snooze-7d':
      return (
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
          <circle cx="11" cy="11" r="8" stroke="white" strokeWidth="1.5" />
          <path d="M11 7V11L13.5 13.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'snooze-notification':
      return (
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
          <path d="M8 16c0 1.1.9 2 2 2h2c1.1 0 2-.9 2-2" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
          <path d="M5.5 14.5C6.3 13.5 6.75 12 6.75 10.5 6.75 8 8.65 6 11 6s4.25 2 4.25 4.5c0 1.5.45 3 1.25 4H5.5z" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          <line x1="4" y1="4" x2="18" y2="18" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
  }
}

/**
 * Compute the next focused menu item index for keyboard navigation.
 * Exported for unit testing.
 */
export function nextFocusIdx(currentIdx: number, direction: 'up' | 'down', count: number): number {
  return direction === 'down' ? Math.min(currentIdx + 1, count - 1) : Math.max(currentIdx - 1, 0);
}

/** Returns the undo message string for a given swipe action. */
function undoMessage(action: SwipeAction): string {
  switch (action) {
    case 'snooze-24h': return 'Snoozed 24 h';
    case 'snooze-3d': return 'Snoozed 3 d';
    case 'snooze-7d': return 'Snoozed 7 d';
    case 'snooze-notification': return 'Snoozed';
  }
}

// ─── Undo context ─────────────────────────────────────────────────────────────

interface SwipeContextValue {
  registerUndo: (message: string, undo: () => void) => void;
}

const SwipeContext = createContext<SwipeContextValue>({
  registerUndo: () => {},
});

// ─── SwipeProvider ────────────────────────────────────────────────────────────

export function SwipeProvider({ children }: { children: ReactNode }) {
  const [undoState, setUndoState] = useState<{
    message: string;
    undo: () => void;
  } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const registerUndo = useCallback((message: string, undo: () => void) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setUndoState({ message, undo });
    timerRef.current = setTimeout(() => setUndoState(null), 4000);
  }, []);

  const handleUndo = useCallback(() => {
    if (!undoState) return;
    undoState.undo();
    setUndoState(null);
    if (timerRef.current) clearTimeout(timerRef.current);
  }, [undoState]);

  return (
    <SwipeContext.Provider value={{ registerUndo }}>
      {children}
      {undoState && (
        // Fixed above tab bar (z-20), 12pt gap. Uses ink bg + copper hard shadow per §2.3.
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-20 left-1/2 z-30 flex items-center gap-2 px-4 py-2.5 font-mono text-[12px] font-semibold text-white select-none"
          style={{
            transform: 'translateX(-50%)',
            background: '#101216',
            boxShadow: '3px 3px 0 0 var(--accent)',
            borderRadius: 0,
          }}
        >
          <span>{undoState.message}</span>
          <span className="text-white/40">·</span>
          <button
            className="underline underline-offset-2 hover:text-white/80 transition-colors"
            onClick={handleUndo}
          >
            Undo
          </button>
        </div>
      )}
    </SwipeContext.Provider>
  );
}

// ─── SwipeableRow ─────────────────────────────────────────────────────────────

const COMMIT_THRESHOLD_PX = 10; // horizontal travel before swipe is committed
const FIRE_THRESHOLD_PX = -72;  // must swipe left ≥72 pt to trigger action
export const REVEAL_WIDTH_PX = 80;   // width of revealed trailing action slot
// Must match the ⋯ button's w-9 class (9 * 4px = 36px).
// Trailing action is pinned right: MENU_BTN_WIDTH so it never overlaps the button.
export const MENU_BTN_WIDTH = 36;

export interface SwipeableRowProps {
  cardType: SwipeCardType;
  taskTitle: string;
  prUrl?: string | null;
  taskId?: string;
  children: ReactNode;
  className?: string;
  /** Called for menu actions that require external handling (e.g. navigation). */
  onMenuAction?: (action: MenuActionId) => void;
}

export function SwipeableRow({
  cardType,
  taskTitle,
  prUrl,
  taskId,
  children,
  className = '',
  onMenuAction,
}: SwipeableRowProps) {
  const { registerUndo } = useContext(SwipeContext);
  const [dismissed, setDismissed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [translateX, setTranslateX] = useState(0);
  const [isAnimating, setIsAnimating] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuBtnRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();

  const gestureRef = useRef<{
    active: boolean;
    startX: number;
    startY: number;
    direction: 'none' | 'horizontal' | 'vertical';
    committed: boolean;
  }>({ active: false, startX: 0, startY: 0, direction: 'none', committed: false });

  const trailingAction = getTrailingAction(cardType);
  const menuActions = getMenuActions(cardType, { prUrl, taskId });

  // ── Keyboard navigation when menu sheet is open (§2.4) ──────────────────
  useEffect(() => {
    if (!menuOpen) return;
    // Move focus to first menu item when sheet opens
    const first = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]');
    first?.focus();

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setMenuOpen(false);
        // §2.4: focus must return to the ⋯ button that opened the sheet
        menuBtnRef.current?.focus();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const items = Array.from(
          menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
        );
        if (items.length === 0) return;
        const idx = items.indexOf(document.activeElement as HTMLElement);
        items[nextFocusIdx(idx, e.key === 'ArrowDown' ? 'down' : 'up', items.length)]?.focus();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [menuOpen]);

  // ── Spring-back animation ────────────────────────────────────────────────

  const springBack = useCallback(() => {
    setIsAnimating(true);
    setTranslateX(0);
    setTimeout(() => setIsAnimating(false), 320);
  }, []);

  // ── Action dispatch ──────────────────────────────────────────────────────

  const fireAction = useCallback(
    (action: SwipeAction | MenuActionId) => {
      setMenuOpen(false);
      switch (action) {
        case 'snooze-24h':
        case 'snooze-3d':
        case 'snooze-7d':
        case 'snooze-notification': {
          setDismissed(true);
          springBack();
          registerUndo(undoMessage(action as SwipeAction), () => setDismissed(false));
          break;
        }
        case 'file-anyway': {
          setDismissed(true);
          springBack();
          registerUndo('Filed anyway', () => setDismissed(false));
          break;
        }
        case 'ignore': {
          setDismissed(true);
          springBack();
          registerUndo('Ignored', () => setDismissed(false));
          break;
        }
        case 'cancel-task': {
          if (taskId) {
            setDismissed(true);
            fetch(`/api/tasks/${taskId}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status: 'cancelled' }),
            }).catch(() => setDismissed(false));
            registerUndo('Task cancelled', () => {
              setDismissed(false);
              fetch(`/api/tasks/${taskId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'pending' }),
              });
            });
          } else {
            onMenuAction?.('cancel-task');
          }
          break;
        }
        default:
          onMenuAction?.(action as MenuActionId);
          springBack();
      }
    },
    [springBack, registerUndo, taskId, onMenuAction],
  );

  // ── Pointer event handlers ───────────────────────────────────────────────

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (!trailingAction) return;
    const g = gestureRef.current;
    g.active = true;
    g.startX = e.clientX;
    g.startY = e.clientY;
    g.direction = 'none';
    g.committed = false;
    // Capture the pointer so move/up events keep arriving even if the pointer
    // leaves the element's bounds while the card translates during a swipe.
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [trailingAction]);

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const g = gestureRef.current;
      if (!g.active || !trailingAction) return;
      if (g.direction === 'vertical') return;

      const dx = e.clientX - g.startX;
      const dy = e.clientY - g.startY;

      if (!g.committed) {
        if (Math.abs(dx) < COMMIT_THRESHOLD_PX && Math.abs(dy) < COMMIT_THRESHOLD_PX) return;
        const cls = classifyGestureAngle(dx, dy);
        if (cls === 'vertical') {
          g.direction = 'vertical';
          return;
        }
        if (cls === 'ambiguous') return;
        // Horizontal — only commit for left swipe (dx < 0)
        if (dx >= 0) {
          // Right swipe is reserved per §2.2 — ignore
          g.direction = 'vertical'; // treat as pass-through
          return;
        }
        g.direction = 'horizontal';
        g.committed = true;
        e.preventDefault();
      }

      if (g.committed) {
        const clamped = Math.max(-REVEAL_WIDTH_PX, Math.min(0, dx));
        setTranslateX(clamped);
      }
    },
    [trailingAction],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      const g = gestureRef.current;
      if (!g.active) return;
      g.active = false;

      if (!g.committed || !trailingAction) {
        springBack();
        return;
      }

      const dx = e.clientX - g.startX;
      if (dx <= FIRE_THRESHOLD_PX) {
        fireAction(trailingAction.action);
      } else {
        springBack();
      }

      g.committed = false;
      g.direction = 'none';
    },
    [trailingAction, fireAction, springBack],
  );

  const handlePointerCancel = useCallback(() => {
    const g = gestureRef.current;
    g.active = false;
    g.committed = false;
    g.direction = 'none';
    springBack();
  }, [springBack]);

  // ── Dismiss renders nothing ──────────────────────────────────────────────

  if (dismissed) return null;

  // ─────────────────────────────────────────────────────────────────────────

  return (
    // flex items-stretch so the ⋯ button fills the card height without overflow
    <div
      data-card-type={cardType}
      className={`relative overflow-hidden flex items-stretch ${className}`}
    >
      {/* Trailing action slot (revealed by left swipe, absolute) — §2.1
          Right-offset by MENU_BTN_WIDTH so it never overlaps the ⋯ button.
          At full reveal (translateX = -REVEAL_WIDTH_PX) the card right edge
          aligns with this panel's left edge; the ⋯ button stays to the right. */}
      {trailingAction && (
        <div
          data-trailing-action
          aria-hidden="true"
          className="absolute top-0 bottom-0 flex items-center justify-center pointer-events-none"
          style={{
            width: REVEAL_WIDTH_PX,
            right: MENU_BTN_WIDTH,
            background: trailingAction.bgColor,
          }}
        >
          <TrailingActionIcon action={trailingAction.action} />
          <span className="sr-only">{trailingAction.label}</span>
        </div>
      )}

      {/* Swiping card content (flex-1 so the ⋯ button sits as a sibling) */}
      <div
        className="flex-1 min-w-0 relative bg-surface-1"
        style={{
          transform: `translateX(${translateX}px)`,
          transition: isAnimating
            ? 'transform 0.32s cubic-bezier(0.34, 1.56, 0.64, 1)'
            : undefined,
          touchAction: trailingAction ? 'pan-y' : undefined,
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
      >
        {/* Edge hint: gradient stripe signals swipeability at rest */}
        {trailingAction && (
          <div
            aria-hidden="true"
            className="absolute top-0 right-0 bottom-0 w-8 pointer-events-none"
            style={{
              background: `linear-gradient(to left, ${trailingAction.bgColor}, transparent)`,
              opacity: 0.28,
            }}
          />
        )}
        {children}
      </div>

      {/* ⋯ menu button — only rendered when there are menu actions to show.
          Sibling (not absolute) so it never overlaps card content. */}
      {menuActions.length > 0 && (
        <button
          ref={menuBtnRef}
          type="button"
          className="shrink-0 self-stretch z-10 flex items-center justify-center w-9 text-text-muted hover:text-text-primary transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          style={{ touchAction: 'none' }}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); setMenuOpen(true); }}
          aria-label={`More actions for ${taskTitle}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls={menuId}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
            className="pointer-events-none"
          >
            <circle cx="3" cy="8" r="1.5" fill="currentColor" />
            <circle cx="8" cy="8" r="1.5" fill="currentColor" />
            <circle cx="13" cy="8" r="1.5" fill="currentColor" />
          </svg>
        </button>
      )}

      {/* Bottom sheet menu — §2.4 accessibility fallback */}
      {menuOpen && (
        <div
          className="fixed inset-0 z-50"
          aria-modal="true"
          onClick={() => setMenuOpen(false)}
        >
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/40" />

          {/* Sheet */}
          <div
            className="absolute bottom-0 left-0 right-0 bg-surface-2 border-t border-border-default"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Handle + title */}
            <div className="flex justify-center pt-2 pb-1">
              <div className="w-10 h-1 rounded-full bg-border-default" />
            </div>
            <div className="px-4 py-2 border-b border-border-default">
              <p className="font-mono text-[11px] text-text-muted truncate">{taskTitle}</p>
            </div>

            {/* Menu items */}
            <div ref={menuRef} id={menuId} role="menu" aria-label={`More actions for ${taskTitle}`}>
              {menuActions.map((item) => (
                <button
                  key={item.action}
                  role="menuitem"
                  type="button"
                  className={`w-full text-left px-4 py-3.5 text-[14px] flex items-center min-h-[44px] transition-colors ${
                    item.destructive
                      ? 'text-status-error hover:bg-status-error/5'
                      : 'text-text-primary hover:bg-surface-3'
                  }`}
                  onClick={() => {
                    if (item.href) {
                      window.open(item.href, '_blank', 'noopener,noreferrer');
                      setMenuOpen(false);
                    } else {
                      fireAction(item.action);
                    }
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>

            {/* Safe-area bottom padding */}
            <div style={{ height: 'env(safe-area-inset-bottom, 16px)' }} />
          </div>
        </div>
      )}
    </div>
  );
}
