'use client';

/**
 * The popover behind the composer's scope, tools and tier controls: a button
 * that opens a panel. Escape and a click outside close it and return focus to
 * the trigger.
 *
 * Wide screens: the panel opens above the trigger, inside the composer (which
 * no longer clips it), and scrolls past `min(70vh, 520px)`.
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
}

export function Menu({ label, trigger, title, align = 'start', children, className, testId }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState<{ vars: CSSProperties } | null>(null);
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
    const update = () => setSheet(sheetMatches() ? { vars: kitVarsAt(wrap.current) } : null);
    update();
    const mq = typeof window.matchMedia === 'function' ? window.matchMedia(KIT_SHEET_QUERY) : null;
    mq?.addEventListener?.('change', update);
    return () => mq?.removeEventListener?.('change', update);
  }, [open]);

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
      {title && <p className="kit-menu-title">{title}</p>}
      {typeof children === 'function' ? children(close) : children}
    </div>
  );

  return (
    <div ref={wrap} className={`kit-menu${className ? ` ${className}` : ''}`} data-align={align} data-open={open || undefined} data-testid={testId}>
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

/** One choice inside a `Menu`; wrap them in `<div role="radiogroup">`. */
export function MenuOption({ checked, onSelect, children, meta }: { checked: boolean; onSelect(): void; children: ReactNode; meta?: ReactNode }) {
  return (
    <button type="button" role="radio" aria-checked={checked} className="kit-option" onClick={onSelect}>
      <span>{children}</span>
      {meta != null && <span className="kit-option-meta">{meta}</span>}
    </button>
  );
}
