'use client';

/**
 * A composer toolbar cell holding one of the kit's menus (ToolsMenu,
 * TierPicker, opened with `placement="auto"` so Home's composer near the top
 * drops down). The cell adds the one thing the kit's menu does not have: an
 * optional `hover` detail shown on pointer hover without opening (desktop
 * only, never while open; CSS in globals.css, "Chat on the kit").
 */
import type { ReactNode } from 'react';

export default function KitMenuCell({ children, hover, testId }: {
  children: ReactNode;
  /** Detail on hover (desktop), without opening. */
  hover?: ReactNode;
  testId?: string;
}) {
  return (
    <div data-testid={testId} className="buildd-menu-cell relative h-full min-w-0">
      {children}
      {hover && (
        <div role="tooltip" data-testid={testId ? `${testId}-hover` : undefined} className="buildd-menu-hover pointer-events-none z-40 w-max max-w-[300px] border-2 border-border-strong bg-surface-2 px-3 py-2 shadow-[var(--card-shadow)]">
          {hover}
        </div>
      )}
    </div>
  );
}
