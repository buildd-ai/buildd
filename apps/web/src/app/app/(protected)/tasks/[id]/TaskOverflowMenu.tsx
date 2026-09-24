'use client';

/**
 * "⋮" on the task page: the admin actions (Edit, Reassign, View Source,
 * Delete) behind one control, so the title has the header to itself
 * (docs/design/mission-feed-mobile-continuity.md W6, addendum D9). Same
 * bottom-sheet mechanism as the mission page's ⋮. The actions are passed in
 * as children and keep their own confirm/modal logic unchanged.
 */
import { useState, type ReactNode } from 'react';
import BottomSheet from '@/components/BottomSheet';

/**
 * The sheet is the only route to these actions on mobile, so every button and
 * link inside it — the nested Reassign/Delete confirm rows included — gets the
 * 44px tap target (min-h-11). Exported for the test.
 */
export const TASK_SHEET_ACTIONS_CLASS =
  'flex flex-col items-stretch gap-2 [&>*]:w-full [&_button]:min-h-11 [&_a]:min-h-11';

export default function TaskOverflowMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="More actions: edit, reassign, delete"
        aria-haspopup="dialog"
        data-testid="task-overflow-menu"
        className="-mr-2.5 flex h-11 w-11 shrink-0 items-center justify-center text-text-secondary transition-colors hover:text-text-primary"
      >
        <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor" aria-hidden="true">
          <rect x="2" y="8" width="3" height="3" />
          <rect x="7.5" y="8" width="3" height="3" />
          <rect x="13" y="8" width="3" height="3" />
        </svg>
      </button>
      <BottomSheet open={open} onClose={() => setOpen(false)} title="Task actions" trapFocus>
        <div className={TASK_SHEET_ACTIONS_CLASS}>{children}</div>
      </BottomSheet>
    </>
  );
}
