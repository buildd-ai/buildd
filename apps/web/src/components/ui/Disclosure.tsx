'use client';

import { useId, useState, type MouseEvent, type ReactNode } from 'react';

export interface DisclosureProps {
  summary: ReactNode;
  count?: number;
  defaultOpen?: boolean;
  /** Controlled open state; pair with `onOpenChange`. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
  className?: string;
}

/**
 * Show/hide a secondary block (details, logs, a long list) without leaving the
 * page. The toggle is a full-width button with `aria-expanded`/`aria-controls`,
 * 44px tall below md. Children mount only while open.
 */
export default function Disclosure({
  summary,
  count,
  defaultOpen = false,
  open,
  onOpenChange,
  children,
  className = '',
}: DisclosureProps) {
  const [innerOpen, setInnerOpen] = useState(defaultOpen);
  const isOpen = open ?? innerOpen;
  const panelId = useId();

  function toggle(e: MouseEvent<HTMLButtonElement>) {
    // A task row (`data-task-id`) opens its sheet on click; the toggle inside
    // it must not (docs/specs/timeline-mobile-rail.md).
    if (e.currentTarget.closest('[data-task-id]')) e.stopPropagation();
    const next = !isOpen;
    if (open === undefined) setInnerOpen(next);
    onOpenChange?.(next);
  }

  return (
    <div className={className}>
      <button
        type="button"
        aria-expanded={isOpen}
        aria-controls={panelId}
        onClick={toggle}
        className="w-full min-h-11 md:min-h-9 flex items-center gap-2 text-left text-body text-text-secondary hover:text-text-primary transition-colors"
      >
        <span
          aria-hidden="true"
          className={`inline-block text-meta leading-none transition-transform duration-150 ${isOpen ? 'rotate-90' : ''}`}
        >
          ▶
        </span>
        <span className="min-w-0 flex-1">{summary}</span>
        {count != null && <span className="text-meta text-text-muted">{count}</span>}
      </button>
      <div id={panelId} hidden={!isOpen}>
        {isOpen && children}
      </div>
    </div>
  );
}

export { Disclosure };
