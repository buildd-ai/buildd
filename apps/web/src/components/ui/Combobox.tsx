'use client';

import { useCallback, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useIsMobile } from '@/hooks/useIsMobile';
import { AnchoredPopover } from './AnchoredPopover';
import { ListboxOptions, optionDomId, type SelectOption } from './ListboxOptions';
import { edgeIndex, fuzzyFilter, moveHighlight } from './listbox';
import { triggerClasses } from './Select';

interface ComboboxProps {
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  /**
   * Accept typed text that matches no option (an id the catalog does not list
   * yet). Off: the value can only be one of `options`.
   */
  allowCustom?: boolean;
  className?: string;
  size?: 'sm' | 'md';
  id?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  testId?: string;
  sheetTitle?: string;
  emptyText?: string;
  menuMinWidth?: number;
  /** Show the option's value (an id) in the field instead of its label. */
  showValue?: boolean;
}

const textOf = (o: SelectOption) => `${o.label} ${o.value} ${o.description ?? ''} ${o.keywords ?? ''} ${o.group ?? ''}`;

/**
 * Editable combobox with a filtered listbox (WAI-ARIA "combobox, list
 * autocomplete"). Typing fuzzy-filters across label, value, description and
 * group; ↓/↑ move, Enter picks, Escape restores the saved value. Below `md`
 * the field becomes a button that opens a bottom sheet with its own search box.
 */
export function Combobox({
  value, onChange, options, placeholder, disabled = false, allowCustom = false, className = '', size = 'md',
  id, 'aria-label': ariaLabel, 'aria-labelledby': ariaLabelledBy, testId, sheetTitle, emptyText, menuMinWidth,
  showValue = false,
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  const isMobile = useIsMobile();
  const anchorRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const sheetInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listId = `${useId()}-listbox`;

  const selected = options.find((o) => o.value === value);
  const display = selected ? (showValue ? selected.value : selected.label) : value;
  const visible = useMemo(() => (query ? fuzzyFilter(options, query, textOf) : options), [options, query]);

  const openList = useCallback(() => {
    if (disabled) return;
    const sel = options.findIndex((o) => o.value === value);
    setActive(sel >= 0 ? sel : edgeIndex(options, 'first'));
    setOpen(true);
    if (isMobile) setTimeout(() => sheetInputRef.current?.focus({ preventScroll: true }), 0);
  }, [disabled, options, value, isMobile]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery(null);
  }, []);

  const commit = useCallback((next: string) => {
    if (next !== value) onChange(next);
    close();
  }, [value, onChange, close]);

  function pickIndex(i: number) {
    const o = visible[i];
    if (o && !o.disabled) {
      commit(o.value);
      if (!isMobile) inputRef.current?.focus({ preventScroll: true });
    }
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (disabled) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!open) openList(); else setActive((i) => moveHighlight(visible, i, 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (!open) openList(); else setActive((i) => moveHighlight(visible, i, -1));
        break;
      case 'PageDown': if (open) { e.preventDefault(); setActive((i) => moveHighlight(visible, i, 10, false)); } break;
      case 'PageUp': if (open) { e.preventDefault(); setActive((i) => moveHighlight(visible, i, -10, false)); } break;
      case 'Enter':
        if (!open) return;
        e.preventDefault();
        if (active >= 0 && visible[active]) pickIndex(active);
        else if (allowCustom && query?.trim()) commit(query.trim());
        break;
      case 'Escape':
        if (open || query !== null) { e.preventDefault(); e.stopPropagation(); close(); }
        break;
      case 'Tab':
        if (open && allowCustom && query !== null && query.trim() && active < 0) commit(query.trim());
        else close();
        break;
    }
  }

  function onBlur() {
    // Focus moving into the popover (a click on a row) is not a blur-away.
    setTimeout(() => {
      const a = document.activeElement;
      if (panelRef.current?.contains(a) || anchorRef.current?.contains(a)) return;
      if (allowCustom && query !== null && query.trim() && query.trim() !== display) commit(query.trim());
      else close();
    }, 0);
  }

  const activeId = open && active >= 0 && visible[active] ? optionDomId(listId, active) : undefined;
  const title = sheetTitle ?? ariaLabel ?? placeholder ?? 'Choose';
  const inputCls = 'min-w-0 flex-1 bg-transparent font-mono text-text-primary placeholder:text-text-muted focus:outline-none';

  const list = (
    <ListboxOptions
      id={listId}
      options={visible}
      activeIndex={active}
      isSelected={(v) => v === value}
      onPick={pickIndex}
      onHover={setActive}
      roomy={isMobile}
      dense={size === 'sm'}
      label={title}
      emptyText={allowCustom && query?.trim() ? `No match. Enter uses "${query.trim()}".` : emptyText}
    />
  );

  return (
    <div className={`relative min-w-0 ${className}`}>
      <div ref={anchorRef} className={`${triggerClasses(size, open, disabled)} !cursor-text`}>
        {isMobile ? (
          <button
            type="button"
            id={id}
            role="combobox"
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-label={ariaLabel}
            aria-labelledby={ariaLabelledBy}
            data-testid={testId}
            disabled={disabled}
            onClick={openList}
            className={`${inputCls} text-left truncate ${display ? '' : 'text-text-muted'}`}
          >
            {display || placeholder}
          </button>
        ) : (
          <input
            ref={inputRef}
            id={id}
            type="text"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            aria-activedescendant={activeId}
            aria-label={ariaLabel}
            aria-labelledby={ariaLabelledBy}
            data-testid={testId}
            disabled={disabled}
            value={query ?? display}
            placeholder={placeholder}
            spellCheck={false}
            autoComplete="off"
            onClick={() => { if (!open) openList(); }}
            onChange={(e) => { setQuery(e.target.value); setActive(e.target.value ? 0 : -1); if (!open) setOpen(true); }}
            onKeyDown={onKey}
            onBlur={onBlur}
            className={inputCls}
          />
        )}
        <svg className={`w-3 h-3 shrink-0 text-text-muted transition-transform duration-100 ${open ? 'rotate-180' : ''}`} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
          <path strokeLinecap="square" strokeLinejoin="miter" d="M2.5 4.5L6 8l3.5-3.5" />
        </svg>
      </div>

      <AnchoredPopover open={open} onClose={close} anchorRef={anchorRef} sheet={isMobile} title={title} minWidth={menuMinWidth} panelRef={panelRef}>
        {isMobile && (
          <div className="shrink-0 border-b border-border-default p-3">
            <input
              ref={sheetInputRef}
              type="text"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={activeId}
              aria-label={`Search ${title}`}
              value={query ?? ''}
              placeholder="Search…"
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => { setQuery(e.target.value); setActive(e.target.value ? 0 : -1); }}
              onKeyDown={onKey}
              className="w-full h-11 bg-surface-1 border border-border-default px-2 font-mono text-base text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary"
            />
          </div>
        )}
        {list}
      </AnchoredPopover>
    </div>
  );
}
