'use client';

/**
 * The task page's h1 (docs/specs/task-page.md §Mobile header). On a phone a
 * long title holds to three lines with "Show full title" under it, which
 * expands in place and collapses again; from `md` up it runs free. The toggle
 * appears only when the title really overflows, and is a 44px target.
 */
import { useClamp } from './ClampText';

export default function TaskTitle({ title, className = '' }: { title: string; className?: string }) {
  const { ref, open, setOpen, overflows } = useClamp(title);
  return (
    <>
      <h1
        id="task-title"
        ref={ref as React.RefObject<HTMLHeadingElement>}
        data-testid="task-title"
        data-clamped={open ? 'false' : 'true'}
        className={`text-heading font-semibold break-words [overflow-wrap:anywhere] max-w-[760px] ${open ? '' : 'line-clamp-3 md:line-clamp-none'} ${className}`}
      >
        {title}
      </h1>
      {overflows && (
        <button
          type="button"
          data-testid="task-title-toggle"
          aria-expanded={open}
          aria-controls="task-title"
          onClick={() => setOpen(!open)}
          className="md:hidden -my-1 inline-flex min-h-11 items-center text-meta font-medium text-accent-text hover:underline"
        >
          {open ? 'Show less' : 'Show full title'}
        </button>
      )}
    </>
  );
}
