import type { ReactNode } from 'react';

export interface Criterion {
  ok: boolean;
  text: ReactNode;
  /** The measured value: `found`, `2/7`, `5 open`. */
  value?: ReactNode;
}

/**
 * A mission's goal criteria: `Goal · 2 of 4 criteria`, then one hairline row
 * each, ✓ met / ○ not yet, with the measured value in mono on the right.
 */
export default function Criteria({
  items,
  action,
  evaluated,
  className = '',
}: {
  items: readonly Criterion[];
  /** Right of the heading, e.g. a Re-check button. */
  action?: ReactNode;
  /** Footer, e.g. `Evaluated 40m ago`. */
  evaluated?: ReactNode;
  className?: string;
}) {
  const met = items.filter(c => c.ok).length;
  return (
    <div data-testid="criteria" className={className}>
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <span className="text-body font-semibold text-text-muted">Goal · {met} of {items.length} criteria</span>
        {action}
      </div>
      <ul>
        {items.map((c, i) => (
          <li
            key={i}
            data-ok={c.ok}
            className="grid grid-cols-[20px_minmax(0,1fr)_auto] items-baseline gap-2.5 border-t border-[var(--line-soft)] py-[9px] text-title"
          >
            <span aria-hidden="true" className={c.ok ? 'text-status-success' : 'text-text-muted'}>{c.ok ? '✓' : '○'}</span>
            <span className="[overflow-wrap:anywhere]">
              <span className="sr-only">{c.ok ? 'Met: ' : 'Not yet: '}</span>
              {c.text}
            </span>
            {c.value != null && <span className="font-mono text-meta text-text-muted">{c.value}</span>}
          </li>
        ))}
      </ul>
      {evaluated && <div className="mt-2 font-mono text-meta text-text-muted">{evaluated}</div>}
    </div>
  );
}

export { Criteria };
