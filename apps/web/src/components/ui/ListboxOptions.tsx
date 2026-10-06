'use client';

import { useEffect, type KeyboardEvent, type ReactNode } from 'react';

export interface SelectOption<V extends string = string> {
  value: V;
  label: string;
  /** Second line, muted. */
  description?: string;
  /** Right-aligned detail (a price, a count). */
  meta?: ReactNode;
  /** Leading mark (a vendor glyph, a status dot). */
  icon?: ReactNode;
  /** Consecutive options with the same group render under one heading. */
  group?: string;
  disabled?: boolean;
  /** Extra text search matches against. Never shown. */
  keywords?: string;
}

interface Props {
  id: string;
  options: readonly SelectOption[];
  activeIndex: number;
  isSelected: (value: string) => boolean;
  onPick: (index: number) => void;
  onHover: (index: number) => void;
  /** Phone sheet rows: 44px+ targets and 16px text. */
  roomy: boolean;
  dense?: boolean;
  /** Wrap long labels onto more lines instead of truncating them. */
  wrap?: boolean;
  multi?: boolean;
  label?: string;
  emptyText?: string;
  /** When the list itself holds focus (in the phone sheet). */
  focusable?: boolean;
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
}

export const optionDomId = (listId: string, i: number) => `${listId}-opt-${i}`;

function Check() {
  return (
    <svg className="w-3.5 h-3.5 shrink-0 text-accent-text" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
      <path strokeLinecap="square" strokeLinejoin="miter" d="M3 8.5l3.2 3L13 4.5" />
    </svg>
  );
}

function Box({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`grid place-items-center w-4 h-4 shrink-0 border-[1.5px] ${on ? 'bg-primary border-primary text-[var(--on-accent)]' : 'border-border-strong'}`}
    >
      {on && (
        <svg className="w-3 h-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={3} aria-hidden="true">
          <path strokeLinecap="square" d="M3 8.5l3.2 3L13 4.5" />
        </svg>
      )}
    </span>
  );
}

/**
 * The listbox both Select and Combobox render: grouped rows, a square accent
 * bar on the highlighted row, a check (or checkbox in multi mode) on the
 * chosen one. Options are not focusable; the owner keeps DOM focus and points
 * at the highlighted row with aria-activedescendant.
 */
export function ListboxOptions({
  id, options, activeIndex, isSelected, onPick, onHover, roomy, dense = false, wrap = false, multi = false, label,
  emptyText = 'No matches', focusable = false, onKeyDown,
}: Props) {
  useEffect(() => {
    if (activeIndex < 0 || typeof document === 'undefined') return;
    const el = document.getElementById(optionDomId(id, activeIndex));
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [id, activeIndex]);

  const rows: ReactNode[] = [];
  let i = 0;
  while (i < options.length) {
    const group = options[i].group;
    const start = i;
    while (i < options.length && options[i].group === group) i++;
    const items = options.slice(start, i).map((o, k) => renderRow(o, start + k));
    if (group) {
      const hid = `${id}-grp-${start}`;
      rows.push(
        <div key={hid} role="group" aria-labelledby={hid} className="border-t border-border-default first:border-t-0">
          <div id={hid} role="presentation" className={`sticky top-0 z-[1] bg-surface-2 px-3 pt-2 pb-1 text-[11px] md:text-[10px] font-semibold uppercase tracking-[1.5px] text-text-muted ${roomy ? 'px-4' : ''}`}>
            {group}
          </div>
          {items}
        </div>,
      );
    } else {
      rows.push(...items);
    }
  }

  function renderRow(o: SelectOption, index: number) {
    const selected = isSelected(o.value);
    const active = index === activeIndex;
    return (
      <div
        key={`${o.value}-${index}`}
        id={optionDomId(id, index)}
        role="option"
        aria-selected={selected}
        aria-disabled={o.disabled || undefined}
        data-value={o.value}
        data-active={active || undefined}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => { if (!o.disabled) onPick(index); }}
        onMouseMove={() => { if (!active && !o.disabled) onHover(index); }}
        className={`relative flex items-center gap-2.5 cursor-pointer select-none border-l-[3px] ${
          roomy ? 'min-h-12 px-4 py-2.5 text-base' : dense ? 'min-h-8 px-3 py-1 text-xs' : 'min-h-9 px-3 py-1.5 text-[13px]'
        } ${active ? 'bg-surface-3 border-l-primary text-text-primary' : 'border-l-transparent'} ${
          selected ? 'text-text-primary font-medium' : 'text-text-secondary'
        } ${o.disabled ? 'opacity-45 cursor-not-allowed' : ''}`}
      >
        {multi && <Box on={selected} />}
        {o.icon && <span className="shrink-0 flex items-center">{o.icon}</span>}
        <span className="min-w-0 flex-1">
          <span className={`block ${wrap ? 'break-all' : 'truncate'}`}>{o.label}</span>
          {o.description && (
            <span className={`block truncate text-text-muted ${roomy ? 'text-[13px]' : 'text-[11px]'}`}>{o.description}</span>
          )}
        </span>
        {o.meta && <span className="shrink-0 text-[11px] tabular-nums text-text-muted">{o.meta}</span>}
        {!multi && <span className="w-3.5 shrink-0">{selected && <Check />}</span>}
      </div>
    );
  }

  return (
    <div
      id={id}
      role="listbox"
      aria-label={label}
      aria-multiselectable={multi || undefined}
      aria-activedescendant={focusable && activeIndex >= 0 ? optionDomId(id, activeIndex) : undefined}
      tabIndex={focusable ? 0 : -1}
      onKeyDown={onKeyDown}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1 focus:outline-none"
    >
      {options.length === 0 ? (
        <div className={`px-3 py-3 text-text-muted ${roomy ? 'text-sm' : 'text-xs'}`} role="presentation">{emptyText}</div>
      ) : rows}
    </div>
  );
}
