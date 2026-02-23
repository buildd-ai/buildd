'use client';

import { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
import { useClickOutside } from '@/hooks/useClickOutside';

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  searchable?: boolean;
  className?: string;
  size?: 'sm' | 'md';
  id?: string;
  name?: string;
}

const MOBILE_BREAKPOINT = 640;

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);
  return isMobile;
}

export function Select({
  value,
  onChange,
  options,
  placeholder = 'Select...',
  disabled = false,
  searchable = false,
  className = '',
  size = 'md',
  id,
  name,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [dropUp, setDropUp] = useState(false);
  const isMobile = useIsMobile();
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setSearch('');
    setHighlightedIndex(-1);
  }, []);

  useClickOutside(ref, close);

  const selectedOption = options.find(o => o.value === value);

  const filtered = searchable && search
    ? options.filter(o => o.label.toLowerCase().includes(search.toLowerCase()))
    : options;

  // Desktop: measure available space and decide drop direction
  useLayoutEffect(() => {
    if (open && !isMobile && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      setDropUp(spaceBelow < 240 && spaceAbove > spaceBelow);
    }
  }, [open, isMobile]);

  // Pre-highlight selected item and scroll into view on open
  useEffect(() => {
    if (open) {
      const selectedIdx = filtered.findIndex(o => o.value === value);
      setHighlightedIndex(selectedIdx >= 0 ? selectedIdx : 0);

      if (searchable) {
        setTimeout(() => searchRef.current?.focus(), 0);
      }

      // Scroll selected item into view
      if (selectedIdx >= 0) {
        setTimeout(() => {
          if (listRef.current) {
            const items = listRef.current.querySelectorAll('[role="option"]');
            items[selectedIdx]?.scrollIntoView({ block: 'nearest' });
          }
        }, 0);
      }
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lock body scroll on mobile when open
  useEffect(() => {
    if (open && isMobile) {
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = ''; };
    }
  }, [open, isMobile]);

  // Scroll highlighted item into view on keyboard nav
  useEffect(() => {
    if (highlightedIndex >= 0 && listRef.current) {
      const items = listRef.current.querySelectorAll('[role="option"]');
      items[highlightedIndex]?.scrollIntoView({ block: 'nearest' });
    }
  }, [highlightedIndex]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (disabled) return;

    switch (e.key) {
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (!open) {
          setOpen(true);
        } else if (highlightedIndex >= 0 && highlightedIndex < filtered.length) {
          onChange(filtered[highlightedIndex].value);
          close();
        }
        break;
      case 'ArrowDown':
        e.preventDefault();
        if (!open) {
          setOpen(true);
        } else {
          setHighlightedIndex(i => (i + 1) % filtered.length);
        }
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (open) {
          setHighlightedIndex(i => (i - 1 + filtered.length) % filtered.length);
        }
        break;
      case 'Escape':
        e.preventDefault();
        close();
        break;
      case 'Tab':
        close();
        break;
    }
  }

  function handleSearchKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlightedIndex(i => (i + 1) % filtered.length);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlightedIndex(i => (i - 1 + filtered.length) % filtered.length);
        break;
      case 'Enter':
        e.preventDefault();
        if (highlightedIndex >= 0 && highlightedIndex < filtered.length) {
          onChange(filtered[highlightedIndex].value);
          close();
        }
        break;
      case 'Escape':
        e.preventDefault();
        close();
        break;
    }
  }

  const sizeClasses = size === 'sm'
    ? 'text-xs px-2 py-1'
    : 'px-3 py-2';

  function selectOption(optionValue: string) {
    onChange(optionValue);
    close();
  }

  const searchInput = searchable && (
    <div className={isMobile ? 'p-3 border-b border-border-default' : 'p-2 border-b border-border-default'}>
      <input
        ref={searchRef}
        type="text"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setHighlightedIndex(0);
        }}
        onKeyDown={!isMobile ? handleSearchKeyDown : undefined}
        placeholder="Search..."
        className={`w-full bg-transparent text-text-primary placeholder-text-muted focus:outline-none ${
          isMobile ? 'px-1 py-1 text-base' : 'px-2 py-1 text-sm'
        }`}
      />
    </div>
  );

  const optionsList = (
    <div
      ref={listRef}
      role="listbox"
      className={isMobile ? 'overflow-y-auto py-1 flex-1' : 'max-h-60 overflow-y-auto py-1'}
    >
      {filtered.length === 0 ? (
        <div className="px-3 py-2 text-sm text-text-muted">No matches</div>
      ) : (
        filtered.map((option, i) => (
          <button
            key={option.value}
            type="button"
            role="option"
            aria-selected={option.value === value}
            onClick={() => selectOption(option.value)}
            onMouseEnter={!isMobile ? () => setHighlightedIndex(i) : undefined}
            className={`w-full text-left flex items-center justify-between transition-colors ${
              isMobile
                ? 'px-4 py-3 text-base'
                : `px-3 ${size === 'sm' ? 'py-1 text-xs' : 'py-2 text-sm'}`
            } ${
              highlightedIndex === i && !isMobile ? 'bg-surface-3' : ''
            } ${
              option.value === value
                ? 'text-text-primary font-medium'
                : 'text-text-secondary'
            } ${
              isMobile ? 'active:bg-surface-3' : ''
            }`}
          >
            <span className="truncate">{option.label}</span>
            {option.value === value && (
              <svg className="w-4 h-4 shrink-0 ml-2 text-primary" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
            )}
          </button>
        ))
      )}
    </div>
  );

  return (
    <div ref={ref} className={`relative ${className}`}>
      {name && <input type="hidden" name={name} value={value} />}
      <button
        ref={triggerRef}
        type="button"
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={disabled}
        onClick={() => !disabled && setOpen(!open)}
        onKeyDown={handleKeyDown}
        className={`w-full flex items-center justify-between gap-2 border rounded-md bg-surface-1 text-left transition-colors ${sizeClasses} ${
          disabled
            ? 'opacity-50 cursor-not-allowed border-border-default'
            : 'hover:bg-surface-2 cursor-pointer'
        } ${
          open
            ? 'border-primary ring-2 ring-primary-ring'
            : 'border-border-default'
        } focus:ring-2 focus:ring-primary-ring focus:border-primary focus:outline-none`}
      >
        <span className={selectedOption ? 'text-text-primary truncate' : 'text-text-muted truncate'}>
          {selectedOption?.label || placeholder}
        </span>
        <svg
          className={`w-3.5 h-3.5 shrink-0 text-text-secondary transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Mobile: bottom sheet */}
      {open && isMobile && (
        <div
          className="fixed inset-0 z-50 bg-black/50"
          onClick={close}
        >
          <div
            className="absolute bottom-0 left-0 right-0 bg-surface-2 rounded-t-2xl max-h-[70vh] flex flex-col animate-slide-up"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Drag handle */}
            <div className="flex justify-center pt-3 pb-1">
              <div className="w-10 h-1 rounded-full bg-surface-4" />
            </div>
            {searchInput}
            {optionsList}
            {/* Safe area padding for bottom-notch phones */}
            <div className="pb-[env(safe-area-inset-bottom)]" />
          </div>
        </div>
      )}

      {/* Desktop: dropdown */}
      {open && !isMobile && (
        <div
          className={`absolute z-50 min-w-full bg-surface-2 border border-border-default rounded-md shadow-lg animate-dropdown-in origin-top ${
            dropUp ? 'bottom-full mb-1' : 'top-full mt-1'
          }`}
        >
          {searchInput}
          {optionsList}
        </div>
      )}
    </div>
  );
}
