'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useIsMobile } from '@/hooks/useIsMobile';
import { AnchoredPopover } from './AnchoredPopover';
import { ListboxOptions, optionDomId, type SelectOption } from './ListboxOptions';
import { edgeIndex, fuzzyFilter, isTypeaheadKey, moveHighlight, typeaheadIndex } from './listbox';

export type { SelectOption } from './ListboxOptions';

interface SelectProps<V extends string = string> {
  value: V | '';
  onChange: (value: V) => void;
  options: readonly SelectOption<V>[];
  placeholder?: string;
  disabled?: boolean;
  /** Search box above the list. Default: on when there are more than 10 options. */
  searchable?: boolean;
  /** Wrapper classes (width, flex). The trigger fills the wrapper. */
  className?: string;
  size?: 'sm' | 'md';
  id?: string;
  /** Posts the value with a surrounding <form>. */
  name?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  /** data-testid on the trigger. */
  testId?: string;
  /** Phone sheet heading. Defaults to the aria-label, then the placeholder. */
  sheetTitle?: string;
  /** Replaces the trigger's classes entirely (a chip, a bare inline control). */
  triggerClassName?: string;
  /** Custom trigger content for the selected option. */
  renderValue?: (option: SelectOption<V> | undefined) => ReactNode;
  /** Minimum popover width in px (a narrow trigger with long options). */
  menuMinWidth?: number;
  align?: 'start' | 'end';
}

const TYPEAHEAD_RESET_MS = 600;

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`w-3 h-3 shrink-0 text-text-muted transition-transform duration-100 ${open ? 'rotate-180' : ''}`}
      viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true"
    >
      <path strokeLinecap="square" strokeLinejoin="miter" d="M2.5 4.5L6 8l3.5-3.5" />
    </svg>
  );
}

export function triggerClasses(size: 'sm' | 'md', open: boolean, disabled: boolean): string {
  return [
    'w-full min-w-0 flex items-center justify-between gap-2 text-left font-mono border bg-surface-1 text-text-primary transition-colors',
    size === 'sm' ? 'min-h-11 md:min-h-8 px-2 text-base md:text-xs' : 'min-h-11 md:min-h-9 px-3 text-base md:text-[13px]',
    open ? 'border-primary' : 'border-border-default',
    disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer hover:border-border-strong',
    'focus-visible:outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary-ring',
  ].join(' ');
}

/**
 * The brand select: a button that opens a listbox (WAI-ARIA "select-only
 * combobox"). Square, 1px ink border, hard-offset popover, IBM Plex Mono.
 *
 * Keyboard: ↓/↑/Enter/Space open; ↓/↑ move, Home/End jump, PageUp/PageDown
 * step ten; typing jumps to a matching label (repeat a letter to cycle);
 * Enter/Space choose; Escape closes and keeps the old value. Focus stays on the
 * trigger (or the search box) and aria-activedescendant names the row.
 * Below `md` it opens as a bottom sheet with 48px rows.
 */
export function Select<V extends string = string>({
  value, onChange, options, placeholder = 'Select…', disabled = false, searchable, className = '',
  size = 'md', id, name, 'aria-label': ariaLabel, 'aria-labelledby': ariaLabelledBy,
  'aria-describedby': ariaDescribedBy, testId, sheetTitle, triggerClassName, renderValue,
  menuMinWidth, align,
}: SelectProps<V>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const isMobile = useIsMobile();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const typed = useRef({ buffer: '', at: 0 });
  const listId = `${useId()}-listbox`;

  const withSearch = searchable ?? options.length > 10;
  const visible = useMemo(
    () => (withSearch && query ? fuzzyFilter(options, query, (o) => `${o.label} ${o.description ?? ''} ${o.keywords ?? ''} ${o.group ?? ''}`) : options),
    [options, query, withSearch],
  );
  const selected = options.find((o) => o.value === value);

  const openList = useCallback((at?: 'first' | 'last') => {
    if (disabled) return;
    setQuery('');
    const sel = options.findIndex((o) => o.value === value && !o.disabled);
    setActive(at ? edgeIndex(options, at) : sel >= 0 ? sel : edgeIndex(options, 'first'));
    setOpen(true);
  }, [disabled, options, value]);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    setQuery('');
    typed.current.buffer = '';
    if (refocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  const pick = useCallback((index: number) => {
    const o = visible[index];
    if (!o || o.disabled) return;
    if (o.value !== value) onChange(o.value);
    close();
  }, [visible, value, onChange, close]);

  useEffect(() => {
    if (open && withSearch && !isMobile) searchRef.current?.focus({ preventScroll: true });
  }, [open, withSearch, isMobile]);

  function typeahead(key: string) {
    const now = Date.now();
    const t = typed.current;
    t.buffer = now - t.at > TYPEAHEAD_RESET_MS ? key : t.buffer + key;
    t.at = now;
    const from = open ? active : options.findIndex((o) => o.value === value);
    const hit = typeaheadIndex(open ? visible : options, from, t.buffer);
    if (hit < 0) return;
    if (!open) {
      setQuery('');
      setOpen(true);
    }
    setActive(hit);
  }

  function onKey(e: KeyboardEvent<HTMLElement>, fromSearch = false) {
    if (disabled) return;
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openList();
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        openList(e.key === 'Home' ? 'first' : 'last');
      } else if (isTypeaheadKey(e)) {
        e.preventDefault();
        typeahead(e.key);
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); setActive((i) => moveHighlight(visible, i, 1)); break;
      case 'ArrowUp': e.preventDefault(); setActive((i) => moveHighlight(visible, i, -1)); break;
      case 'PageDown': e.preventDefault(); setActive((i) => moveHighlight(visible, i, 10, false)); break;
      case 'PageUp': e.preventDefault(); setActive((i) => moveHighlight(visible, i, -10, false)); break;
      case 'Home': if (!fromSearch) { e.preventDefault(); setActive(edgeIndex(visible, 'first')); } break;
      case 'End': if (!fromSearch) { e.preventDefault(); setActive(edgeIndex(visible, 'last')); } break;
      case 'Enter': e.preventDefault(); pick(active); break;
      case ' ':
        if (!fromSearch) { e.preventDefault(); pick(active); }
        break;
      case 'Escape': e.preventDefault(); e.stopPropagation(); close(); break;
      case 'Tab': close(false); break;
      default:
        if (!fromSearch && isTypeaheadKey(e)) { e.preventDefault(); typeahead(e.key); }
    }
  }

  const title = sheetTitle ?? ariaLabel ?? placeholder;
  const activeId = open && active >= 0 && visible[active] ? optionDomId(listId, active) : undefined;

  return (
    <div className={`relative min-w-0 ${className}`}>
      {name && <input type="hidden" name={name} value={value} />}
      <button
        ref={triggerRef}
        type="button"
        id={id}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={!withSearch && !isMobile ? activeId : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-describedby={ariaDescribedBy}
        data-testid={testId}
        data-value={value}
        disabled={disabled}
        onClick={() => (open ? close() : openList())}
        onKeyDown={(e) => onKey(e)}
        className={triggerClassName ?? triggerClasses(size, open, disabled)}
      >
        {renderValue ? renderValue(selected) : (
          <span className={`min-w-0 flex-1 truncate ${selected ? '' : 'text-text-muted'}`}>{selected?.label ?? placeholder}</span>
        )}
        <Chevron open={open} />
      </button>

      <AnchoredPopover
        open={open}
        onClose={() => close(!isMobile)}
        anchorRef={triggerRef}
        sheet={isMobile}
        title={title}
        minWidth={menuMinWidth}
        align={align}
      >
        {withSearch && (
          <div className={`shrink-0 border-b border-border-default ${isMobile ? 'p-3' : 'p-1.5'}`}>
            <input
              ref={searchRef}
              type="text"
              role="searchbox"
              aria-label={`Search ${title}`}
              aria-controls={listId}
              aria-activedescendant={activeId}
              value={query}
              onChange={(e) => { setQuery(e.target.value); setActive(0); }}
              onKeyDown={(e) => onKey(e, true)}
              placeholder="Search…"
              spellCheck={false}
              autoComplete="off"
              className={`w-full bg-surface-1 border border-border-default px-2 font-mono text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary ${isMobile ? 'h-11 text-base' : 'h-8 text-xs'}`}
            />
          </div>
        )}
        <ListboxOptions
          id={listId}
          options={visible}
          activeIndex={active}
          isSelected={(v) => v === value}
          onPick={pick}
          onHover={setActive}
          roomy={isMobile}
          dense={size === 'sm'}
          label={ariaLabel ?? title}
          focusable={isMobile}
          onKeyDown={isMobile ? (e) => onKey(e) : undefined}
        />
      </AnchoredPopover>
    </div>
  );
}
