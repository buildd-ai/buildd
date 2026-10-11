import type { ReactNode } from 'react';

export interface Fact {
  label: ReactNode;
  value: ReactNode;
  /** Plain-text help under the label, the same line the editable form shows. */
  note?: ReactNode;
  testId?: string;
}

/**
 * A setting's values for someone who cannot change them: label and value as
 * text, no controls. The page says who manages them, once, at the top.
 */
export function ReadOnlyFacts({ facts, className = '' }: { facts: Fact[]; className?: string }) {
  return (
    <dl className={`space-y-2 ${className}`}>
      {facts.map((f, i) => (
        <div key={i} className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
          <dt className="min-w-0">
            <span className="block text-sm text-text-secondary">{f.label}</span>
            {f.note && <span className="block text-xs text-text-muted mt-0.5">{f.note}</span>}
          </dt>
          <dd data-testid={f.testId} className="text-sm text-text-primary break-words sm:text-right sm:max-w-[60%]">{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}
