'use client';

import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useCallback, useState, useRef, useEffect, useLayoutEffect } from 'react';
import Link from 'next/link';
import { displayWorkspaceName } from '@buildd/shared';
import { useClickOutside } from '@/hooks/useClickOutside';
import BottomSheet from './BottomSheet';

export interface WorkspaceSwitcherProps {
  workspaces: { id: string; name: string }[];
  /** When omitted the component reads ?workspace= from the URL. */
  selectedId?: string | null;
  /**
   * Controlled mode (the chat composer): called with the pick instead of
   * navigating. Without it, a pick sets ?workspace= on the current page.
   */
  onSelect?: (id: string | null) => void;
  /**
   * `header`: the app header (label + name on desktop, a grid glyph on a phone).
   * `chip`: the composer's scope chip (`@ All workspaces`, `@ billing-web`, or
   * `→ billing-web` when the turn was routed there).
   */
  variant?: 'header' | 'chip';
  /** Chip only: the workspace this turn was routed to, shown while nothing is pinned. */
  routed?: { id: string; name: string } | null;
  /** Shown above the list, so the menu says whose workspaces these are. */
  teamName?: string | null;
}

/**
 * Build the ?workspace= query string for a given selection.
 * Exported for testing — the component delegates navigation to this.
 */
export function buildWorkspaceParam(currentSearch: string, workspaceId: string | null): string {
  const params = new URLSearchParams(currentSearch);
  if (workspaceId) {
    params.set('workspace', workspaceId);
  } else {
    params.delete('workspace');
  }
  return params.toString();
}

/** The chip's words. Pure. */
export function scopeChipLabel(
  workspaces: readonly { id: string; name: string }[],
  selectedId: string | null,
  routed: { id: string; name: string } | null,
): { glyph: '@' | '→'; name: string; short: string } {
  const pinned = selectedId ? workspaces.find(w => w.id === selectedId) : null;
  const one = pinned ?? routed;
  if (one) {
    const name = displayWorkspaceName(one.name);
    return { glyph: pinned ? '@' : '→', name, short: name };
  }
  // A phone's scope cell is narrow: `@ all ▾` (mobile chat v3).
  return { glyph: '@', name: 'All workspaces', short: 'all' };
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

/**
 * The one workspace switcher: the app header (desktop and phone), Home and the
 * chat composer all use it. `null` means all workspaces in the active team.
 * Pages keep the selection in the URL (?workspace=<id>, shareable, back-button
 * safe), and the composer starts from the same value, so a pick in the header
 * carries into a new chat. Switching teams (page reload) clears it.
 *
 * Never uses a native <select> — rendered as a custom brutalist dropdown with
 * keyboard navigation, aria-listbox semantics, and a "+ New workspace" footer
 * (header only).
 */
export function WorkspaceSwitcher({
  workspaces, selectedId: selectedIdProp, onSelect, variant = 'header', routed = null, teamName = null,
}: WorkspaceSwitcherProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isMobile = useIsMobile();
  const chip = variant === 'chip';

  const selectedId = selectedIdProp !== undefined ? selectedIdProp : searchParams.get('workspace');

  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [dropUp, setDropUp] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // options includes the synthetic "All" option at index 0
  const options = [
    { id: null, label: 'All workspaces' },
    ...workspaces.map((ws) => ({ id: ws.id, label: displayWorkspaceName(ws.name) })),
  ];
  const selectedIndex = selectedId ? options.findIndex((o) => o.id === selectedId) : 0;
  const selectedLabel = options[selectedIndex]?.label ?? 'All workspaces';

  const close = useCallback(() => {
    setOpen(false);
    setHighlightedIndex(-1);
  }, []);

  // The mobile sheet is portaled out of containerRef and closes via its own
  // backdrop, so outside-click only governs the desktop dropdown — otherwise the
  // mousedown that starts every tap on an option would close the sheet first.
  const isMobileRef = useRef(isMobile);
  isMobileRef.current = isMobile;
  useClickOutside(
    containerRef,
    useCallback(() => {
      if (!isMobileRef.current) close();
    }, [close]),
  );

  const handleSelect = useCallback(
    (id: string | null) => {
      if (onSelect) {
        onSelect(id);
      } else {
        const qs = buildWorkspaceParam(searchParams.toString(), id);
        router.replace(`${pathname}${qs ? `?${qs}` : ''}`);
      }
      close();
    },
    [onSelect, router, pathname, searchParams, close],
  );

  // Decide drop direction on desktop
  useLayoutEffect(() => {
    if (open && !isMobile && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      setDropUp(spaceBelow < 260 && spaceAbove > spaceBelow);
    }
  }, [open, isMobile]);

  // Pre-highlight current selection when opened
  useEffect(() => {
    if (open) {
      setHighlightedIndex(selectedIndex >= 0 ? selectedIndex : 0);
      // Scroll selected into view
      setTimeout(() => {
        if (listRef.current) {
          const items = listRef.current.querySelectorAll('[role="option"]');
          items[selectedIndex >= 0 ? selectedIndex : 0]?.scrollIntoView({ block: 'nearest' });
        }
      }, 0);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll highlighted option into view on keyboard nav
  useEffect(() => {
    if (highlightedIndex >= 0 && listRef.current) {
      const items = listRef.current.querySelectorAll('[role="option"]');
      items[highlightedIndex]?.scrollIntoView({ block: 'nearest' });
    }
  }, [highlightedIndex]);

  function handleKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (!open) {
          setOpen(true);
        } else if (highlightedIndex >= 0 && highlightedIndex < options.length) {
          handleSelect(options[highlightedIndex].id);
        }
        break;
      case 'ArrowDown':
        e.preventDefault();
        if (!open) {
          setOpen(true);
        } else {
          setHighlightedIndex((i) => (i + 1) % options.length);
        }
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (open) {
          setHighlightedIndex((i) => (i - 1 + options.length) % options.length);
        }
        break;
      case 'Escape':
        e.preventDefault();
        close();
        triggerRef.current?.focus();
        break;
      case 'Tab':
        close();
        break;
    }
  }

  if (workspaces.length === 0) return null;

  const optionsList = (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Workspaces"
      className={isMobile ? 'py-1' : 'max-h-56 overflow-y-auto py-1'}
    >
      {options.map((option, i) => {
        const isSelected = option.id === selectedId || (option.id === null && !selectedId);
        const isRouted = chip && !selectedId && option.id !== null && option.id === routed?.id;
        return (
          <button
            key={option.id ?? '__all__'}
            type="button"
            role="option"
            aria-selected={isSelected}
            onClick={() => handleSelect(option.id)}
            onMouseEnter={!isMobile ? () => setHighlightedIndex(i) : undefined}
            className={`w-full text-left flex items-center justify-between gap-2 font-mono transition-colors ${
              isMobile ? 'px-5 py-3.5 text-sm' : 'px-3 py-1.5 text-xs'
            } ${
              highlightedIndex === i && !isMobile
                ? 'bg-surface-3 text-text-primary'
                : isSelected
                  ? 'text-text-primary'
                  : 'text-text-secondary'
            } ${isMobile ? 'active:bg-surface-3' : ''}`}
          >
            <span className="truncate">{option.label}</span>
            {isRouted && <span className="shrink-0 text-text-muted">this turn</span>}
            {isSelected && (
              <svg
                className="w-3.5 h-3.5 shrink-0 text-accent"
                fill="currentColor"
                viewBox="0 0 20 20"
                aria-hidden="true"
              >
                <path
                  fillRule="evenodd"
                  d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                  clipRule="evenodd"
                />
              </svg>
            )}
          </button>
        );
      })}
    </div>
  );

  const teamLabel = teamName ? (
    <div
      data-testid="workspace-switcher-team"
      className={`border-b border-border-default font-mono uppercase tracking-widest text-text-muted ${isMobile ? 'px-5 py-2 text-[11px]' : 'px-3 py-1.5 text-[11px] md:text-[10px]'}`}
    >
      {teamName}
    </div>
  ) : null;

  const wsNavLinks = selectedId && !chip
    ? [
        { label: 'Configure', href: `/app/workspaces/${selectedId}/config` },
        { label: 'Runners', href: `/app/workspaces/${selectedId}/runners` },
        { label: 'Schedules', href: `/app/workspaces/${selectedId}/schedules` },
        { label: 'Memory', href: `/app/workspaces/${selectedId}/memory` },
      ]
    : null;

  const newWorkspaceFooter = chip ? null : (
    <div className="border-t border-border-default">
      {wsNavLinks && (
        <div className="border-b border-border-default">
          <div className={`font-mono uppercase tracking-widest text-text-muted ${isMobile ? 'px-5 pt-3 pb-1 text-[11px]' : 'px-3 pt-2 pb-0.5 text-[11px] md:text-[8px]'}`}>
            {options.find((o) => o.id === selectedId)?.label ?? 'Workspace'}
          </div>
          {wsNavLinks.map(({ label, href }) => (
            <Link
              key={href}
              href={href}
              onClick={close}
              className={`w-full flex items-center gap-2 font-mono text-text-secondary hover:text-text-primary hover:bg-surface-3 transition-colors ${
                isMobile ? 'px-5 py-2.5 text-sm' : 'px-3 py-1.5 text-xs'
              }`}
            >
              <svg className="w-2.5 h-2.5 shrink-0 text-text-muted" fill="none" viewBox="0 0 10 10" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
                <path strokeLinecap="square" strokeLinejoin="miter" d="M2 5h6M5 2l3 3-3 3" />
              </svg>
              {label}
            </Link>
          ))}
        </div>
      )}
      <Link
        href="/app/workspaces"
        onClick={close}
        className={`w-full flex items-center gap-1.5 font-mono text-text-secondary hover:text-text-primary transition-colors hover:bg-surface-3 ${
          isMobile ? 'px-5 py-3.5 text-sm' : 'px-3 py-2 text-xs'
        }`}
      >
        <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 12 12" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
          <rect x="1" y="1" width="4" height="4" />
          <rect x="7" y="1" width="4" height="4" />
          <rect x="1" y="7" width="4" height="4" />
          <rect x="7" y="7" width="4" height="4" />
        </svg>
        All workspaces
      </Link>
      <Link
        href="/app/workspaces/new"
        onClick={close}
        className={`w-full flex items-center gap-1.5 font-mono text-accent hover:text-accent transition-colors hover:bg-surface-3 ${
          isMobile ? 'px-5 py-3.5 text-sm' : 'px-3 py-2 text-xs'
        }`}
      >
        <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 12 12" stroke="currentColor" strokeWidth={2} aria-hidden="true">
          <path strokeLinecap="square" strokeLinejoin="miter" d="M6 1v10M1 6h10" />
        </svg>
        New workspace
      </Link>
    </div>
  );

  const chipLabel = scopeChipLabel(workspaces, selectedId, routed);
  const trigger = chip ? (
    <button
      ref={triggerRef}
      type="button"
      role="combobox"
      aria-expanded={open}
      aria-haspopup="listbox"
      aria-label="Workspace for this conversation"
      data-testid="composer-scope-chip"
      data-scope={selectedId ? 'pinned' : routed ? 'routed' : 'all'}
      onClick={() => setOpen((prev) => !prev)}
      onKeyDown={handleKeyDown}
      className="flex h-full min-h-11 w-full min-w-0 items-center gap-1.5 px-3 font-mono text-[12.5px] font-medium text-[var(--chat-muted)] hover:bg-[var(--chat-raised)] hover:text-[var(--chat-text)] aria-expanded:bg-[var(--chat-raised)] aria-expanded:text-[var(--chat-text)]"
    >
      <span aria-hidden="true" className={chipLabel.glyph === '→' ? 'text-accent-text' : 'text-text-muted'}>{chipLabel.glyph}</span>
      {chipLabel.short === chipLabel.name ? (
        <span className="min-w-0 truncate">{chipLabel.name}</span>
      ) : (
        <>
          <span data-testid="scope-chip-short" className="min-w-0 truncate md:hidden">{chipLabel.short}</span>
          <span data-testid="scope-chip-name" className="min-w-0 truncate max-md:hidden">{chipLabel.name}</span>
        </>
      )}
      <span aria-hidden="true" className="shrink-0 text-[var(--chat-dim)]">▾</span>
    </button>
  ) : (
    <button
      ref={triggerRef}
      type="button"
      role="combobox"
      aria-expanded={open}
      aria-haspopup="listbox"
      aria-label="Filter by workspace"
      onClick={() => setOpen((prev) => !prev)}
      onKeyDown={handleKeyDown}
      className={`max-md:min-h-11 max-md:min-w-11 max-md:justify-center max-md:items-center px-2.5 py-1 flex flex-col items-start gap-0 font-mono border-2 border-border-strong bg-surface-2 text-text-secondary hover:text-text-primary hover:shadow-sm transition-shadow cursor-pointer focus-visible:outline-accent ${
        open ? 'shadow-sm text-text-primary' : ''
      }`}
    >
      <span className="text-[11px] md:text-[8px] uppercase tracking-widest text-text-muted leading-tight hidden md:block">WORKSPACE</span>
      <div className="flex items-center gap-1.5">
        {/* Grid glyph: mobile-only, always shown on mobile. Filled when workspace is selected to indicate active filter. */}
        <svg
          className={`w-3.5 h-3.5 shrink-0 md:hidden transition-colors ${
            selectedId ? 'text-accent' : ''
          }`}
          fill={selectedId ? 'currentColor' : 'none'}
          viewBox="0 0 12 12"
          stroke="currentColor"
          strokeWidth={selectedId ? 0 : 1.8}
          aria-hidden="true"
        >
          <rect x="1" y="1" width="4" height="4" />
          <rect x="7" y="1" width="4" height="4" />
          <rect x="1" y="7" width="4" height="4" />
          <rect x="7" y="7" width="4" height="4" />
        </svg>
        <span className="truncate max-w-[160px] text-xs hidden md:inline">{selectedLabel}</span>
        <svg
          className={`w-3 h-3 shrink-0 transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2.5}
          aria-hidden="true"
        >
          <path strokeLinecap="square" strokeLinejoin="miter" d="M19 9l-7 7-7-7" />
        </svg>
      </div>
    </button>
  );

  return (
    <div ref={containerRef} className={`relative ${chip ? 'h-full min-w-0' : ''}`}>
      {trigger}

      {/* Mobile: the shared BottomSheet — portaled to <body> (inside the fixed
          header it sat under the bottom nav), modal with focus moved in and
          trapped, Escape to close, and the shell's scroll root locked. */}
      {isMobile && (
        <BottomSheet open={open} onClose={close} title="Workspace" trapFocus flush testId="workspace-filter-sheet">
          {teamLabel}
          {optionsList}
          {newWorkspaceFooter}
        </BottomSheet>
      )}

      {/* Desktop: anchored panel */}
      {open && !isMobile && (
        <div
          className={`absolute z-50 min-w-[200px] bg-surface-2 border-2 border-border-strong shadow-md animate-dropdown-in origin-top ${
            dropUp ? 'bottom-full mb-1' : 'top-full mt-1'
          } ${chip ? 'left-0' : 'right-0'}`}
          role="presentation"
        >
          {teamLabel}
          {optionsList}
          {newWorkspaceFooter}
        </div>
      )}
    </div>
  );
}
