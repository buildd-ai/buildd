'use client';

/**
 * A composer toolbar cell holding one of the kit's menus (ToolsMenu,
 * TierPicker). The menu itself is the kit's `Menu`: a popover on desktop, a
 * bottom sheet below 640px. This cell adds the two things buildd's composer
 * had that the kit's menu does not (yet):
 *
 *  - which way the popover opens, decided when it opens: down when there is
 *    room below and little above (Home's composer sits near the top), else up
 *    (the chat composer sits at the bottom). The kit always opens up.
 *  - an optional `hover` detail shown on pointer hover without opening
 *    (desktop only, never while open; CSS in globals.css, "Chat on the kit").
 */
import { useRef, useState, type ReactNode } from 'react';

/** Below this much room under the cell (and more above it), the popover opens up. */
const ROOM_BELOW = 320;

export function dropSide(rect: { top: number; bottom: number }, viewportHeight: number): 'up' | 'down' {
  const below = viewportHeight - rect.bottom;
  return below < ROOM_BELOW && rect.top > below ? 'up' : 'down';
}

export default function KitMenuCell({ children, hover, testId }: {
  children: ReactNode;
  /** Detail on hover (desktop), without opening. */
  hover?: ReactNode;
  testId?: string;
}) {
  const cell = useRef<HTMLDivElement>(null);
  const [side, setSide] = useState<'up' | 'down'>('up');
  // Capture runs before the kit's trigger toggles the menu, so both land in one render.
  const measure = () => {
    const r = cell.current?.getBoundingClientRect();
    if (r) setSide(dropSide(r, window.innerHeight));
  };
  return (
    <div ref={cell} data-testid={testId} data-drop={side} onClickCapture={measure} className="buildd-menu-cell relative h-full min-w-0">
      {children}
      {hover && (
        <div role="tooltip" data-testid={testId ? `${testId}-hover` : undefined} className="buildd-menu-hover pointer-events-none z-40 w-max max-w-[300px] border-2 border-border-strong bg-surface-2 px-3 py-2 shadow-[var(--card-shadow)]">
          {hover}
        </div>
      )}
    </div>
  );
}
