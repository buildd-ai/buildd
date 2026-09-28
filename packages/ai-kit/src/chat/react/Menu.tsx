'use client';

/**
 * The popover behind the composer's scope, tools and tier controls: a button
 * that opens a panel (a bottom sheet below 640px, via styles.css). Escape and
 * a click outside close it and return focus to the trigger.
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';

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
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const close = useCallback(() => {
    setOpen(false);
    button.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
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
      {open && (
        <div id={panelId} role="dialog" aria-label={title ?? label} className="kit-menu-panel" data-testid={testId ? `${testId}-panel` : undefined}>
          {title && <p className="kit-menu-title">{title}</p>}
          {typeof children === 'function' ? children(close) : children}
        </div>
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
