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

/**
 * True when a pointerdown landed on (or inside) an interactive control.
 *
 * Cards embed their own controls — the Merge button, PR links, the ⋯ menu. A
 * swipe gesture must not claim those: capturing the pointer on the container
 * retargets the compatibility mouse events, so `click` fires on the container
 * and the control's onClick never runs.
 *
 * Walks `parentElement` up to (excluding) `stopAt` so it works on real DOM
 * nodes and on plain objects in tests.
 */
const INTERACTIVE_TAGS = new Set([
  'button',
  'a',
  'input',
  'select',
  'textarea',
  'label',
  'summary',
  'option',
]);
const INTERACTIVE_ROLES = new Set(['button', 'link', 'menuitem', 'checkbox', 'switch', 'tab']);

interface InteractiveProbe {
  tagName?: string;
  getAttribute?(name: string): string | null;
  parentElement?: InteractiveProbe | null;
}

export function isInteractiveTarget(
  target: InteractiveProbe | null | undefined,
  stopAt?: InteractiveProbe | null,
): boolean {
  let node: InteractiveProbe | null | undefined = target;
  while (node && node !== stopAt) {
    const tag = node.tagName?.toLowerCase();
    if (tag && INTERACTIVE_TAGS.has(tag)) return true;
    const role = node.getAttribute?.('role');
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    node = node.parentElement ?? null;
  }
  return false;
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

/**
 * Hours for the `/api/action-queue/snooze` POST body. Only the gate-card
 * snoozes (MERGE/REVIEW) are backed by that endpoint today — `null` means
 * "no server-side meaning yet", not "unsupported", and callers fall back to
 * the pre-existing client-local-only behavior for those actions.
 */
export function snoozeDurationHours(action: SwipeAction): number | null {
  switch (action) {
    case 'snooze-24h': return 24;
    case 'snooze-3d': return 72;
    case 'snooze-7d': return 168;
    case 'snooze-notification': return null;
  }
}

/**
 * The status an Undo of "Cancel task" may PATCH back, or `null` for no undo.
 *
 * Cancelling aborts the live worker and releases its path claims, and the
 * PATCH route can only set `pending` (not `assigned`/`in_progress`). So the
 * only cancel that Undo can honestly reverse is one on a task that was still
 * queued. Re-queuing anything else would restart work from scratch (a running
 * task) or spend budget on a fresh run (a failed one). Those cancels ask for
 * confirmation up front instead.
 */
export function cancelUndoStatus(priorStatus: string | null | undefined): 'pending' | null {
  return priorStatus === 'pending' ? 'pending' : null;
}

/**
 * Card type for a task row's ⋯ menu, shared by every task list (task grid,
 * mission timeline). Terminal rows (completed, failed, cancelled) map to
 * 'completed-task', whose menu has no "Cancel task": cancelling finished work
 * is a no-op at best.
 */
export function taskSwipeCardType(status: string, blockedByCount: number): SwipeCardType {
  if (status === 'completed' || status === 'failed' || status === 'cancelled') return 'completed-task';
  if (blockedByCount > 0) return 'blocked-task';
  return 'running-task';
}

/**
 * PATCH a task's status and report whether the server accepted it. A 4xx/5xx
 * counts as a failure. `fetch` only rejects on network errors, so checking
 * `.catch()` alone reported every rejected cancel as a success.
 */
export type PatchTaskStatusResult =
  | { ok: true; task: Record<string, unknown> | null }
  | { ok: false; error: string };

export async function patchTaskStatus(
  taskId: string,
  status: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PatchTaskStatusResult> {
  try {
    const res = await fetchImpl(`/api/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    if (res.ok) {
      // The route returns the updated row. Callers use it to see state the
      // rendered snapshot missed (e.g. a claim that landed after render).
      let task: Record<string, unknown> | null = null;
      try {
        const body = await res.json();
        if (body && typeof body === 'object') task = body as Record<string, unknown>;
      } catch {
        // Unreadable body: the PATCH still succeeded.
      }
      return { ok: true, task };
    }
    let error = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body && typeof body.error === 'string' && body.error) error = body.error;
    } catch {
      // Non-JSON error body: keep the HTTP status.
    }
    return { ok: false, error };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Network error' };
  }
}

export interface CancelTaskDeps {
  taskId: string;
  taskTitle: string;
  /** Status from the rendered snapshot; may be stale by the time of the click. */
  taskStatus?: string | null;
  patch: (taskId: string, status: string) => Promise<PatchTaskStatusResult>;
  confirm: (message: string) => boolean;
  setDismissed: (dismissed: boolean) => void;
  notify: (message: string) => void;
  registerUndo: (message: string, undo: () => unknown) => void;
}

/**
 * The "Cancel task" flow, with its side effects injected so every branch is
 * testable. Resolves to what happened.
 *
 * Undo is offered only when the task was queued at render time AND the cancel
 * response shows no claim. A runner can claim between render and click; the
 * cancel then aborted a fresh worker, and re-queuing would restart it. A claim
 * the response can't rule out (unreadable body) also gets no Undo.
 */
export async function runCancelTask(
  deps: CancelTaskDeps,
): Promise<'declined' | 'failed' | 'cancelled' | 'cancelled-undoable'> {
  const { taskId, taskTitle, patch, setDismissed, notify, registerUndo } = deps;
  const undoStatus = cancelUndoStatus(deps.taskStatus);
  if (!undoStatus && !deps.confirm(`Cancel "${taskTitle}"? This stops its worker and cannot be undone.`)) {
    return 'declined';
  }
  setDismissed(true);
  const result = await patch(taskId, 'cancelled');
  if (!result.ok) {
    setDismissed(false);
    notify(`Cancel failed: ${result.error}`);
    return 'failed';
  }
  const claimedMeanwhile = !result.task || result.task.claimedBy != null;
  if (!undoStatus || claimedMeanwhile) {
    notify('Task cancelled');
    return 'cancelled';
  }
  registerUndo('Task cancelled', async () => {
    setDismissed(false);
    const undo = await patch(taskId, undoStatus);
    if (!undo.ok) {
      setDismissed(true);
      notify(`Undo failed: ${undo.error}`);
    }
  });
  return 'cancelled-undoable';
}

// ─── Undo context ─────────────────────────────────────────────────────────────

interface SwipeContextValue {
  registerUndo: (message: string, undo: () => void) => void;
  /** Show a toast with no Undo button (errors, irreversible outcomes). */
  notify: (message: string) => void;
}

const SwipeContext = createContext<SwipeContextValue>({
  registerUndo: () => {},
  notify: () => {},
});

// ─── SwipeProvider ────────────────────────────────────────────────────────────

export function SwipeProvider({ children }: { children: ReactNode }) {
  const [undoState, setUndoState] = useState<{
    message: string;
    undo?: () => void;
  } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((message: string, undo?: () => void) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setUndoState({ message, undo });
    timerRef.current = setTimeout(() => setUndoState(null), 4000);
  }, []);
  const registerUndo = useCallback((message: string, undo: () => void) => show(message, undo), [show]);
  const notify = useCallback((message: string) => show(message), [show]);

  const handleUndo = useCallback(() => {
    if (!undoState?.undo) return;
    undoState.undo();
    setUndoState(null);
    if (timerRef.current) clearTimeout(timerRef.current);
  }, [undoState]);

  return (
    <SwipeContext.Provider value={{ registerUndo, notify }}>
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
          {undoState.undo && (
            <>
              <span className="text-white/40">·</span>
              <button
                className="underline underline-offset-2 hover:text-white/80 transition-colors"
                onClick={handleUndo}
              >
                Undo
              </button>
            </>
          )}
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
  /**
   * The task's current status. Decides whether "Cancel task" can be undone
   * (see `cancelUndoStatus`); without it a cancel asks for confirmation and
   * offers no Undo.
   */
  taskStatus?: string | null;
  /**
   * The action queue's own dedupe key (`ActionQueueItem.subjectKey`). When
   * present, a snooze action persists server-side via
   * `/api/action-queue/snooze` instead of only hiding the row locally — see
   * `snoozeDurationHours`.
   */
  subjectKey?: string;
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
  taskStatus,
  subjectKey,
  children,
  className = '',
  onMenuAction,
}: SwipeableRowProps) {
  const { registerUndo, notify } = useContext(SwipeContext);
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
          const hours = snoozeDurationHours(action as SwipeAction);
          if (subjectKey && hours) {
            fetch('/api/action-queue/snooze', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ subjectKey, hours }),
            }).catch(() => setDismissed(false));
            registerUndo(undoMessage(action as SwipeAction), () => {
              setDismissed(false);
              fetch('/api/action-queue/snooze', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ subjectKey }),
              });
            });
          } else {
            registerUndo(undoMessage(action as SwipeAction), () => setDismissed(false));
          }
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
            void runCancelTask({
              taskId,
              taskTitle,
              taskStatus,
              patch: patchTaskStatus,
              confirm: (message) => typeof window === 'undefined' || window.confirm(message),
              setDismissed,
              notify,
              registerUndo,
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
    [springBack, registerUndo, notify, taskId, taskStatus, taskTitle, subjectKey, onMenuAction],
  );

  // ── Pointer event handlers ───────────────────────────────────────────────

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (!trailingAction) return;
    // Controls inside the card (Merge, PR links, ⋯) own their own clicks —
    // never start a gesture on them, and never capture their pointer.
    if (isInteractiveTarget(e.target as HTMLElement, e.currentTarget as HTMLElement)) return;
    const g = gestureRef.current;
    g.active = true;
    g.startX = e.clientX;
    g.startY = e.clientY;
    g.direction = 'none';
    g.committed = false;
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
        // Capture only once the swipe is committed, so move/up keep arriving
        // while the card translates. Capturing earlier (on pointerdown) also
        // retargets the compatibility mouse events, which swallows clicks on
        // buttons and links inside the card.
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // Pointer already released — nothing to capture.
        }
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
