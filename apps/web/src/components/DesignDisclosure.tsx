'use client';

/**
 * A mission page's designs, closed until asked for: one line, in one fixed
 * place, and the sandboxed frames mount only once it is opened, so nothing
 * loads or scrolls on its own (Navigation R-3).
 */
import { useState, type ReactNode } from 'react';

export default function DesignDisclosure({ count, children }: { count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      data-testid="design-disclosure"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      className="min-w-0"
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-baseline gap-x-2 text-body md:min-h-0">
        <span className="text-text-muted">{count === 1 ? 'Design' : 'Designs'}</span>
        <span aria-hidden="true" className="font-mono text-meta text-text-muted">{open ? '⌄' : '›'}</span>
      </summary>
      {open ? <div className="mt-2">{children}</div> : null}
    </details>
  );
}
