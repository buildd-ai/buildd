'use client';

/**
 * The popover behind the composer's scope, tools and tier controls: a button
 * that opens a panel. Escape and a click outside close it and return focus to
 * the trigger.
 *
 * Wide screens: the panel opens above the trigger, inside the composer (which
 * no longer clips it), and scrolls past `min(70vh, 520px)`. It always fits the
 * viewport, `MENU_EDGE` px in from each edge (0.9.1): when the content doesn't
 * fit on its side and does (or fits better) on the other, it flips; its
 * max-height is the room left on the side it opens (`--kit-menu-room`); and it
 * shifts sideways (`--kit-menu-shift`) instead of running off an edge.
 * Below 640px: a bottom sheet, portaled to `<body>` so no transformed or
 * clipping ancestor can capture its `position: fixed`, with a scrim. It carries
 * the `--kit-*` values from where it was opened (so scoped theming still
 * applies) and sits `--kit-sheet-bottom-offset` above the bottom, for an app's
 * tab bar.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { KIT_CSS_VARS } from './vars';

/** Below this width the menus are bottom sheets (matches styles.css). */
export const KIT_SHEET_QUERY = '(max-width: 639px)';

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** The phone-sheet breakpoint matches now (false without `matchMedia`). */
export function sheetMatches(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(KIT_SHEET_QUERY).matches;
}

/** The `--kit-*` values in effect at `el`, as inline style for the portaled sheet. */
export function kitVarsAt(el: Element | null): CSSProperties {
  if (!el || typeof getComputedStyle !== 'function') return {};
  const cs = getComputedStyle(el);
  const out: Record<string, string> = {};
  for (const v of KIT_CSS_VARS) {
    const val = cs.getPropertyValue(v).trim();
    if (val) out[v] = val;
  }
  return out as CSSProperties;
}

export interface MenuProps {
  /** Accessible name of the trigger ("Tools, 2 allowed"). */
  label: string;
  /** What the trigger shows. */
  trigger: ReactNode;
  /** Panel heading. */
  title?: string;
  /** Which edge the panel aligns to on wide screens. */
  align?: 'start' | 'end';
  children: ReactNode | ((close: () => void) => ReactNode);
  className?: string;
  /** `data-testid` on the wrapper; the trigger gets `${testId}-trigger`, the panel `${testId}-panel`. */
  testId?: string;
  /**
   * Which way the popover opens on wide screens (0.6.1). `up` (default) opens
   * above the trigger, for a composer at the bottom of the screen; `down`
   * below it; `auto` decides when it opens: down when there is room below and
   * little above (`menuDropSide`), else up. The phone sheet is unaffected.
   */
  placement?: 'up' | 'down' | 'auto';
  /**
   * The phone sheet gets a close (×) button beside its title (0.6.1). Off by
   * default; the scrim, Escape and a choice still close it either way.
   */
  sheetClose?: boolean;
  /**
   * A detail shown on pointer hover without opening (0.8.0): wide screens
   * with a hovering pointer only, never while the menu is open, on the same
   * side the panel opens. `${testId}-hover`, `.kit-menu-hover`.
   */
  hover?: ReactNode;
}

/** Below this much room under the trigger (and more above it), `auto` opens up. */
const ROOM_BELOW = 320;

/** `placement: 'auto'`: down, unless there's little room below and more above. */
export function menuDropSide(rect: { top: number; bottom: number }, viewportHeight: number): 'up' | 'down' {
  const below = viewportHeight - rect.bottom;
  return below < ROOM_BELOW && rect.top > below ? 'up' : 'down';
}

/** The gap between trigger and panel (matches `calc(100% + 6px)` in styles.css). */
const MENU_GAP = 6;
/** How far the desktop popover stays from each viewport edge. */
export const MENU_EDGE = 12;

/**
 * Where the desktop popover goes (0.9.1): the `preferred` side if a panel
 * `panelHeight` tall fits there, else the other side if it fits there, else
 * whichever side has more room. `room` is the height available on that side,
 * `MENU_EDGE` in from the viewport edge, for the panel's max-height.
 */
export function fitMenuPanel(
  rect: { top: number; bottom: number },
  panelHeight: number,
  viewportHeight: number,
  preferred: 'up' | 'down',
): { side: 'up' | 'down'; room: number } {
  const room = {
    up: Math.max(0, rect.top - MENU_GAP - MENU_EDGE),
    down: Math.max(0, viewportHeight - rect.bottom - MENU_GAP - MENU_EDGE),
  };
  const other = preferred === 'up' ? 'down' : 'up';
  const side = panelHeight <= room[preferred] ? preferred
    : panelHeight <= room[other] || room[other] > room[preferred] ? other
    : preferred;
  return { side, room: Math.floor(room[side]) };
}

/** Sideways nudge (px) that keeps a panel at `rect` `MENU_EDGE` inside the viewport; 0 when it already is. */
export function menuShift(rect: { left: number; right: number }, viewportWidth: number): number {
  if (rect.left < MENU_EDGE) return Math.round(MENU_EDGE - rect.left);
  if (rect.right > viewportWidth - MENU_EDGE) return Math.round(Math.max(viewportWidth - MENU_EDGE - rect.right, MENU_EDGE - rect.left));
  return 0;
}

export function Menu({ label, trigger, title, align = 'start', children, className, testId, placement = 'up', sheetClose = false, hover }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState<{ vars: CSSProperties } | null>(null);
  const [side, setSide] = useState<'up' | 'down'>(placement === 'down' ? 'down' : 'up');
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const close = useCallback(() => {
    setOpen(false);
    button.current?.focus();
  }, []);

  // Sheet or popover, decided when it opens and kept in step with the viewport.
  useIsoLayoutEffect(() => {
    if (!open) { setSheet(null); return; }
    if (placement === 'auto') {
      const r = wrap.current?.getBoundingClientRect();
      setSide(r && typeof window !== 'undefined' ? menuDropSide(r, window.innerHeight) : 'up');
    } else {
      setSide(placement);
    }
    const update = () => setSheet(sheetMatches() ? { vars: kitVarsAt(wrap.current) } : null);
    update();
    const mq = typeof window.matchMedia === 'function' ? window.matchMedia(KIT_SHEET_QUERY) : null;
    mq?.addEventListener?.('change', update);
    return () => mq?.removeEventListener?.('change', update);
  }, [open, placement]);

  // The desktop popover fits the viewport: flip, cap its height, nudge it
  // sideways. Measured when it opens and again on resize or a scroll that
  // moves the trigger. The phone sheet has its own layout and is left alone.
  useIsoLayoutEffect(() => {
    if (!open || sheet) return;
    const fit = () => {
      const w = wrap.current;
      const p = panel.current;
      if (!w || !p || p.dataset.sheet || sheetMatches()) return;
      p.style.removeProperty('--kit-menu-room');
      p.style.removeProperty('--kit-menu-shift');
      const r = w.getBoundingClientRect();
      if (!r.width && !r.height) return; // not laid out (no layout engine)
      const preferred = placement === 'auto' ? menuDropSide(r, window.innerHeight) : placement;
      const border = p.offsetHeight - p.clientHeight;
      const f = fitMenuPanel(r, p.scrollHeight + Math.max(0, border), window.innerHeight, preferred);
      setSide(f.side);
      p.style.setProperty('--kit-menu-room', `${f.room}px`);
      const shift = menuShift(p.getBoundingClientRect(), document.documentElement.clientWidth || window.innerWidth);
      if (shift) p.style.setProperty('--kit-menu-shift', `${shift}px`);
    };
    fit();
    let frame = 0;
    const later = (e: Event) => {
      // Scrolling the panel's own list moves nothing.
      if (e.type === 'scroll' && e.target instanceof Node && panel.current?.contains(e.target)) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    };
    window.addEventListener('resize', later);
    window.addEventListener('scroll', later, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', later);
      window.removeEventListener('scroll', later, true);
    };
  }, [open, sheet, placement]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    const onDown = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node;
      if (wrap.current?.contains(t) || panel.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
    };
  }, [open, close]);

  const panelEl = (
    <div
      ref={panel}
      id={panelId}
      role="dialog"
      aria-label={title ?? label}
      className="kit-menu-panel"
      data-sheet={sheet ? 'true' : undefined}
      data-testid={testId ? `${testId}-panel` : undefined}
    >
      {sheet && sheetClose ? (
        <div className="kit-sheet-head">
          {title ? <p className="kit-menu-title">{title}</p> : <span />}
          <button type="button" className="kit-sheet-close" aria-label="Close" onClick={close} data-testid={testId ? `${testId}-close` : undefined}>
            <span aria-hidden="true">×</span>
          </button>
        </div>
      ) : title && <p className="kit-menu-title">{title}</p>}
      {typeof children === 'function' ? children(close) : children}
    </div>
  );

  return (
    <div
      ref={wrap}
      className={`kit-menu${className ? ` ${className}` : ''}`}
      data-align={align}
      data-placement={side}
      data-open={open || undefined}
      data-testid={testId}
      // The hover detail opens on the side the panel would.
      onMouseEnter={hover != null && placement === 'auto' && !open ? () => {
        const r = wrap.current?.getBoundingClientRect();
        if (r && typeof window !== 'undefined') setSide(menuDropSide(r, window.innerHeight));
      } : undefined}
    >
      <button
        ref={button}
        type="button"
        className="kit-menu-trigger"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen(o => !o)}
        data-testid={testId ? `${testId}-trigger` : undefined}
      >
        {trigger}
      </button>
      {hover != null && (
        <div role="tooltip" className="kit-menu-hover" data-testid={testId ? `${testId}-hover` : undefined}>{hover}</div>
      )}
      {open && !sheet && panelEl}
      {open && sheet && typeof document !== 'undefined' && createPortal(
        <div className="kit-chat kit-sheet-layer" style={sheet.vars} data-testid={testId ? `${testId}-sheet` : undefined}>
          <div className="kit-sheet-scrim" aria-hidden="true" />
          {panelEl}
        </div>,
        document.body,
      )}
    </div>
  );
}

/**
 * One choice inside a `Menu`; wrap them in `<div role="radiogroup">`.
 * `detail` (0.8.0) is a second line under the name.
 */
export function MenuOption({ checked, onSelect, children, meta, detail }: { checked: boolean; onSelect(): void; children: ReactNode; meta?: ReactNode; detail?: ReactNode }) {
  return (
    <button type="button" role="radio" aria-checked={checked} className="kit-option" data-detail={detail != null || undefined} onClick={onSelect}>
      {detail != null
        ? <span className="kit-option-text"><span className="kit-option-name">{children}</span><span className="kit-option-detail">{detail}</span></span>
        : <span>{children}</span>}
      {meta != null && <span className="kit-option-meta">{meta}</span>}
    </button>
  );
}
