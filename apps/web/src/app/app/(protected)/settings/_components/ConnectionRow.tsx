import type { ReactNode } from 'react';

export type ChipTone = 'ok' | 'warn' | 'err' | 'idle';

/** The square status chip every connection row carries. */
export function StatusChip({ tone, children }: { tone: ChipTone; children: ReactNode }) {
  return <span className={`status-pill status-pill-${tone}`}>{children}</span>;
}

/**
 * One connection on Settings → Runners: name, status chip and one line of
 * meta, with the full controls folded underneath. The whole left block is the
 * toggle (a phone-sized target); `action` is the row's one next step, beside
 * it. The caller owns `open` and stays mounted while closed, so a sign-in in
 * progress (a device code being polled) survives a collapse.
 *
 * `readOnly`: the person may see the connection but not change it. The row
 * keeps its name, chip and meta, and drops the toggle, the action and the
 * folded controls, so nothing it shows is a button the API would refuse.
 */
export default function ConnectionRow({
  title, chip, meta, action, open, onToggle, children, testId, id, readOnly = false,
}: {
  title: string;
  chip?: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
  testId?: string;
  id?: string;
  readOnly?: boolean;
}) {
  const heading = (
    <span className="min-w-0 flex-1">
      <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <span className="font-mono text-[13px] font-semibold text-text-primary">{title}</span>
        {chip}
      </span>
      {meta && <span className="mt-1 block truncate font-mono text-[11px] text-text-muted">{meta}</span>}
    </span>
  );
  if (readOnly) {
    return (
      <div id={id} data-testid={testId} data-open="false" data-readonly="true" className={id ? 'scroll-mt-20' : undefined}>
        <div className="flex min-h-14 items-center gap-3 py-2.5 pl-4 pr-3">{heading}</div>
      </div>
    );
  }
  return (
    <div id={id} data-testid={testId} data-open={open ? 'true' : 'false'} className={id ? 'scroll-mt-20' : undefined}>
      <div className="flex items-center gap-2 pr-3">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex min-h-14 min-w-0 flex-1 items-center gap-3 py-2.5 pl-4 text-left hover:bg-surface-3 transition-colors"
        >
          {heading}
          <span aria-hidden="true" className={`shrink-0 font-mono text-[12px] text-text-muted transition-transform ${open ? 'rotate-180' : ''}`}>▾</span>
        </button>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {open && <div className="space-y-3 border-t border-border-default px-4 py-4">{children}</div>}
    </div>
  );
}
