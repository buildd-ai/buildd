'use client';

/**
 * A composer toolbar cell holding one of the kit's menus (ToolsMenu,
 * TierPicker): square, filling its toolbar slot (globals.css, "Chat on the
 * kit"). The hover detail is the kit Menu's own `hover` (0.8.0).
 */
import type { ReactNode } from 'react';

export default function KitMenuCell({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div data-testid={testId} className="buildd-menu-cell relative h-full min-w-0">
      {children}
    </div>
  );
}
