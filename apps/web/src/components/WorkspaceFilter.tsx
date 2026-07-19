'use client';

import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useCallback, useState, useRef, useEffect, useLayoutEffect } from 'react';
import Link from 'next/link';
import { displayWorkspaceName } from '@buildd/shared';
import { useClickOutside } from '@/hooks/useClickOutside';

export interface WorkspaceFilterProps {
  workspaces: { id: string; name: string }[];
  selectedId: string | null;
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
 * Shared workspace narrowing filter used on team-primary data surfaces.
 * State lives in the URL (?workspace=<id>) — shareable and back-button safe.
 * Null selection (default) means all workspaces in the active team.
 * Switching teams (page reload) naturally clears the param.
 *
 * Never uses a native <select> — rendered as a custom brutalist dropdown with
 * keyboard navigation, aria-listbox semantics, and a "+ New workspace" footer.
 */
export function WorkspaceFilter({ workspaces, selectedId }: WorkspaceFilterProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isMobile = useIsMobile();

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

  useClickOutside(containerRef, close);

  const handleSelect = useCallback(
    (id: string | null) => {
      const qs = buildWorkspaceParam(searchParams.toString(), id);
      router.replace(`${pathname}${qs ? `?${qs}` : ''}`);
      close();
    },
    [router, pathname, searchParams, close],
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

  // Lock body scroll on mobile bottom sheet
  useEffect(() => {
    if (open && isMobile) {
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = ''; };
    }
  }, [open, isMobile]);

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
      className={isMobile ? 'overflow-y-auto flex-1 py-1' : 'max-h-56 overflow-y-auto py-1'}
    >
      {options.map((option, i) => {
        const isSelected = option.id === selectedId || (option.id === null && !selectedId);
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

  const wsNavLinks = selectedId
    ? [
        { label: 'Configure', href: `/app/workspaces/${selectedId}/config` },
        { label: 'Runners', href: `/app/workspaces/${selectedId}/runners` },
        { label: 'Schedules', href: `/app/workspaces/${selectedId}/schedules` },
        { label: 'Memory', href: `/app/workspaces/${selectedId}/memory` },
      ]
    : null;

  const newWorkspaceFooter = (
    <div className={`border-t border-border-default ${isMobile ? 'pb-[env(safe-area-inset-bottom)]' : ''}`}>
      {wsNavLinks && (
        <div className="border-b border-border-default">
          <div className={`font-mono uppercase tracking-widest text-text-muted ${isMobile ? 'px-5 pt-3 pb-1 text-[9px]' : 'px-3 pt-2 pb-0.5 text-[8px]'}`}>
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

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label="Filter by workspace"
        onClick={() => setOpen((prev) => !prev)}
        onKeyDown={handleKeyDown}
        className={`px-2.5 py-1 flex flex-col items-start gap-0 font-mono border-2 border-border-strong bg-surface-2 text-text-secondary hover:text-text-primary hover:shadow-sm transition-shadow cursor-pointer focus-visible:outline-accent ${
          open ? 'shadow-sm text-text-primary' : ''
        }`}
      >
        <span className="text-[8px] uppercase tracking-widest text-text-muted leading-tight">WORKSPACE</span>
        <div className="flex items-center gap-1.5">
          <span className="truncate max-w-[120px] text-xs">{selectedLabel}</span>
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

      {/* Mobile: bottom sheet */}
      {open && isMobile && (
        <div
          className="fixed inset-0 z-50 bg-black/60"
          onClick={close}
          aria-hidden="true"
        >
          <div
            className="absolute bottom-0 left-0 right-0 bg-surface-2 border-t-2 border-border-strong max-h-[70vh] flex flex-col animate-slide-up"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Select workspace"
          >
            <div className="flex items-center justify-between px-5 py-3 border-b border-border-default">
              <span className="text-sm font-mono font-medium text-text-primary">Workspace</span>
              <button
                type="button"
                onClick={close}
                className="text-text-muted hover:text-text-secondary p-1"
                aria-label="Close"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="square" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            {optionsList}
            {newWorkspaceFooter}
          </div>
        </div>
      )}

      {/* Desktop: anchored panel */}
      {open && !isMobile && (
        <div
          className={`absolute z-50 min-w-[180px] bg-surface-2 border-2 border-border-strong shadow-md animate-dropdown-in origin-top ${
            dropUp ? 'bottom-full mb-1' : 'top-full mt-1'
          } right-0`}
          role="presentation"
        >
          {optionsList}
          {newWorkspaceFooter}
        </div>
      )}
    </div>
  );
}
