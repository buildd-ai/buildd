'use client';

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import BottomSheet from '@/components/BottomSheet';

interface Props {
  open: boolean;
  onClose: () => void;
  /** The trigger. Clicks on it are not "outside"; the popover sits under it. */
  anchorRef: RefObject<HTMLElement | null>;
  /** Phone: render as a bottom sheet instead of an anchored panel. */
  sheet: boolean;
  /** Bottom-sheet heading (also its accessible name). */
  title: string;
  children: ReactNode;
  /** Anchored panel: minimum width in px. It is never narrower than the trigger. */
  minWidth?: number;
  /** Anchored panel: right-align to the trigger instead of left. */
  align?: 'start' | 'end';
  testId?: string;
  /** Filled with the panel element so callers can scope outside-click checks. */
  panelRef?: RefObject<HTMLDivElement | null>;
}

interface Position {
  top?: number;
  bottom?: number;
  left: number;
  width: number;
  maxHeight: number;
}

const GAP = 4;
const EDGE = 8;
const PREFERRED_HEIGHT = 320;

/**
 * The one surface a Select, Combobox or ModelPicker opens into.
 *
 * Desktop: portaled to <body> with fixed positioning, so an `overflow:hidden`
 * card or a modal's scroll box cannot clip it, and it paints above a Dialog
 * (z-50). It flips above the trigger when there is more room there.
 * Phone: the shared BottomSheet (portaled, focus trapped, Escape closes).
 */
export function AnchoredPopover({
  open, onClose, anchorRef, sheet, title, children, minWidth = 0, align = 'start', testId, panelRef,
}: Props) {
  const ownRef = useRef<HTMLDivElement>(null);
  const ref = panelRef ?? ownRef;
  const [pos, setPos] = useState<Position | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    if (!open || sheet) return;
    function place() {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const r = anchor.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const width = Math.min(Math.max(r.width, minWidth), vw - EDGE * 2);
      let left = align === 'end' ? r.right - width : r.left;
      left = Math.max(EDGE, Math.min(left, vw - width - EDGE));
      const below = vh - r.bottom - GAP - EDGE;
      const above = r.top - GAP - EDGE;
      if (below >= Math.min(PREFERRED_HEIGHT, 200) || below >= above) {
        setPos({ top: r.bottom + GAP, left, width, maxHeight: Math.max(below, 120) });
      } else {
        setPos({ bottom: vh - r.top + GAP, left, width, maxHeight: Math.max(above, 120) });
      }
    }
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, sheet, anchorRef, minWidth, align]);

  // Outside press closes the anchored panel. The sheet closes from its own backdrop.
  useEffect(() => {
    if (!open || sheet) return;
    function onDown(e: MouseEvent | TouchEvent) {
      const t = e.target as Node | null;
      if (!t) return;
      if (anchorRef.current?.contains(t) || ref.current?.contains(t)) return;
      onCloseRef.current();
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
    };
  }, [open, sheet, anchorRef, ref]);

  if (!open) return null;

  if (sheet) {
    return (
      <BottomSheet open onClose={onClose} title={title} trapFocus flush testId={testId}>
        <div ref={ref}>{children}</div>
      </BottomSheet>
    );
  }

  if (typeof document === 'undefined') return null;

  const panel = (
    <div
      ref={ref}
      data-testid={testId}
      data-popover=""
      className="fixed z-[60] flex flex-col bg-surface-2 border-2 border-border-strong shadow-md font-mono animate-dropdown-in origin-top"
      style={pos ? { top: pos.top, bottom: pos.bottom, left: pos.left, width: pos.width, maxHeight: Math.min(pos.maxHeight, 480) } : { visibility: 'hidden', top: 0, left: 0 }}
    >
      {children}
    </div>
  );
  return createPortal(panel, document.body);
}
