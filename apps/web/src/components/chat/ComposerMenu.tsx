'use client';

/**
 * The one disclosure the composer's controls share (tools, tier, workspace): a
 * trigger chip that opens an anchored panel on desktop and the shared
 * BottomSheet on a phone. Opens upward when there's no room below (the chat
 * composer sits at the bottom of the screen; Home's sits near the top).
 *
 * `hover` is optional detail shown on pointer hover without opening the menu
 * (desktop only); a tap opens the menu, which carries the same detail.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import BottomSheet from '@/components/BottomSheet';
import { useClickOutside } from '@/hooks/useClickOutside';
import { useEscapeClose } from '@/hooks/useEscapeClose';

const PHONE = 640;

function useIsPhone() {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const check = () => setPhone(window.innerWidth < PHONE);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);
  return phone;
}

/**
 * The composer's control cells: square, filling their slot in the toolbar,
 * split from their neighbours by the toolbar's 1px rules
 * (docs/design/chat-canvas.md). At least 44px to touch.
 */
export const CHIP = 'flex h-full min-h-11 w-full items-center justify-center gap-1.5 px-2 font-mono text-[12.5px] font-medium text-[var(--chat-muted)] hover:bg-[var(--chat-raised)] hover:text-[var(--chat-text)] aria-expanded:bg-[var(--chat-raised)] aria-expanded:text-[var(--chat-text)]';

export interface ComposerMenuProps {
  /** Accessible name of the trigger. */
  label: string;
  /** The sheet's title on a phone. */
  title: string;
  trigger: ReactNode;
  triggerClassName?: string;
  testId: string;
  align?: 'left' | 'right';
  /** Detail on hover (desktop), without opening. */
  hover?: ReactNode;
  children: (close: () => void) => ReactNode;
  onOpen?: () => void;
}

export default function ComposerMenu({ label, title, trigger, triggerClassName = CHIP, testId, align = 'left', hover, children, onOpen }: ComposerMenuProps) {
  const [open, setOpen] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [dropUp, setDropUp] = useState(true);
  const phone = useIsPhone();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const phoneRef = useRef(phone);
  phoneRef.current = phone;
  // The phone sheet is portaled; its own backdrop closes it.
  useClickOutside(root, useCallback(() => { if (!phoneRef.current) setOpen(false); }, []));
  useEscapeClose(open && !phone, close, button, root);

  useLayoutEffect(() => {
    if (!open || phone || !button.current) return;
    const r = button.current.getBoundingClientRect();
    setDropUp(window.innerHeight - r.bottom < 320 && r.top > window.innerHeight - r.bottom);
  }, [open, phone]);

  const toggle = () => {
    setOpen(o => {
      if (!o) onOpen?.();
      return !o;
    });
    setHovering(false);
  };

  const place = `${dropUp ? 'bottom-full mb-1.5' : 'top-full mt-1.5'} ${align === 'right' ? 'right-0' : 'left-0'}`;

  return (
    <div
      ref={root}
      className="relative h-full min-w-0"
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid={testId}
        onClick={toggle}
        className={triggerClassName}
      >
        {trigger}
      </button>
      {hover && hovering && !open && !phone && (
        <div role="tooltip" data-testid={`${testId}-hover`} className={`pointer-events-none absolute z-40 w-max max-w-[300px] border-2 border-border-strong bg-surface-2 px-3 py-2 shadow-[var(--card-shadow)] ${place}`}>
          {hover}
        </div>
      )}
      {open && !phone && (
        <div role="dialog" aria-label={title} data-testid={`${testId}-menu`} className={`absolute z-50 w-[300px] max-w-[calc(100vw-2rem)] border-2 border-border-strong bg-surface-2 shadow-[var(--card-shadow)] ${place}`}>
          {children(close)}
        </div>
      )}
      {phone && (
        <BottomSheet open={open} onClose={close} title={title} trapFocus flush testId={`${testId}-sheet`}>
          {open ? children(close) : null}
        </BottomSheet>
      )}
    </div>
  );
}
