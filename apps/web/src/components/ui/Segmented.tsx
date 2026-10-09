'use client';

import { useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface SegmentedItem<V extends string> {
  value: V;
  label: ReactNode;
}

/**
 * A two-to-four way switch (State / Effort, Changes / Everything): a quiet
 * --q-tint trough, the chosen segment lifted onto --card with a hairline.
 * A radio group, so ← → move the choice and Tab leaves it.
 */
export default function Segmented<V extends string>({
  items,
  value,
  onChange,
  label,
  className = '',
}: {
  items: readonly SegmentedItem<V>[];
  value: V;
  onChange: (value: V) => void;
  label: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const delta = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const i = items.findIndex(it => it.value === value);
    const next = (i + delta + items.length) % items.length;
    onChange(items[next].value);
    ref.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  }

  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      data-testid="segmented"
      className={`inline-flex gap-0.5 rounded-[var(--radius-card)] bg-[var(--q-tint)] p-[3px] ${className}`}
    >
      {items.map(it => {
        const on = it.value === value;
        return (
          <button
            key={it.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(it.value)}
            className={`min-h-11 md:min-h-8 rounded-[var(--radius-pill)] px-3 text-body ${
              on
                ? 'bg-card font-semibold text-text-primary outline outline-1 outline-[var(--border)]'
                : 'font-medium text-text-muted hover:text-text-primary'
            }`}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

export { Segmented };
