'use client';

/**
 * A mission footer row (Orchestrator, Description) that opens its body in the
 * shared side sheet — the same place, and the same stack, as the task sheet,
 * Records, Notes and Settings. Rows inside the body that carry `data-task-id`
 * open that task's sheet on top, with Back to this one.
 */
import { useState, type ReactNode } from 'react';
import SideSheet from '@/components/SideSheet';

export interface MissionSheetRowProps {
  label: ReactNode;
  title: string;
  testId: string;
  sheetTestId: string;
  children: ReactNode;
  /** Render as a small inline link (the header's "Description") instead of a footer row. */
  inline?: boolean;
}

export default function MissionSheetRow({ label, title, testId, sheetTestId, children, inline = false }: MissionSheetRowProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        data-testid={testId}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className={inline
          ? 'inline-flex min-h-8 shrink-0 items-center gap-1 font-mono text-[12px] text-text-secondary underline decoration-border-strong underline-offset-2 hover:text-text-primary'
          : 'flex min-h-11 w-full items-center gap-2 border-t border-border-default text-left font-mono text-[12px] text-text-secondary hover:text-text-primary'}
      >
        {!inline && <span aria-hidden="true" className="text-text-muted">─</span>}
        <span className={inline ? '' : 'min-w-0 flex-1 truncate'}>{label}</span>
        <span aria-hidden="true">›</span>
      </button>
      <SideSheet open={open} onClose={() => setOpen(false)} title={title} testId={sheetTestId}>
        {children}
      </SideSheet>
    </>
  );
}
