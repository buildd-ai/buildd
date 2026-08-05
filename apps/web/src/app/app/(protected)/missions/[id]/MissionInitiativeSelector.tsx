'use client';

import { useState, useTransition, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

export interface InitiativeOption {
  id: string;
  title: string;
  status: string;
  progress: number;
}

interface Props {
  missionId: string;
  currentInitiativeId: string | null;
  currentInitiativeName: string | null;
  initiatives: InitiativeOption[];
  readonly?: boolean;
}

export default function MissionInitiativeSelector({
  missionId,
  currentInitiativeId,
  currentInitiativeName,
  initiatives,
  readonly = false,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [isPending, startTransition] = useTransition();
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Close on click-outside
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Focus input when popover opens
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handler(e: KeyboardEvent) {
      if (e.key === 'Escape') { setOpen(false); setQuery(''); }
    }
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  const filtered = initiatives.filter(i =>
    i.title.toLowerCase().includes(query.toLowerCase())
  );

  async function assign(initiativeId: string | null) {
    setOpen(false);
    setQuery('');
    try {
      await fetch(`/api/missions/${missionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initiativeId }),
      });
      startTransition(() => router.refresh());
    } catch {
      // non-fatal
    }
  }

  if (readonly) {
    if (!currentInitiativeId || !currentInitiativeName) return null;
    return (
      <div className="flex items-center gap-1.5 text-[12px] text-text-muted">
        <span className="text-text-muted">Initiative:</span>
        <Link
          href={`/app/initiatives/${currentInitiativeId}`}
          className="text-accent-text hover:underline"
        >
          {currentInitiativeName}
        </Link>
      </div>
    );
  }

  return (
    <div className="relative flex items-center gap-1.5 text-[12px] text-text-muted" ref={popoverRef}>
      <span className="shrink-0">Initiative:</span>
      {currentInitiativeId && currentInitiativeName ? (
        <span className="flex items-center gap-1">
          <Link
            href={`/app/initiatives/${currentInitiativeId}`}
            className="text-accent-text hover:underline"
            onClick={e => e.stopPropagation()}
          >
            {currentInitiativeName}
          </Link>
          <button
            onClick={() => setOpen(o => !o)}
            disabled={isPending}
            className="text-text-muted hover:text-text-secondary transition-colors p-0.5"
            title="Change initiative"
          >
            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
          </button>
          <button
            onClick={() => assign(null)}
            disabled={isPending}
            className="text-text-muted hover:text-status-error transition-colors p-0.5"
            title="Remove from initiative"
          >
            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </span>
      ) : (
        <button
          onClick={() => setOpen(o => !o)}
          disabled={isPending}
          className="text-text-muted hover:text-text-secondary transition-colors flex items-center gap-1"
        >
          <span className="italic">— No initiative</span>
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      )}

      {open && (
        <div className="absolute left-0 top-6 z-50 w-72 bg-surface-2 border border-border-default rounded shadow-lg">
          <div className="p-2 border-b border-border-default">
            <input
              ref={inputRef}
              type="text"
              placeholder="Filter initiatives…"
              value={query}
              onChange={e => setQuery(e.target.value)}
              className="w-full bg-surface-3 text-text-primary text-[12px] px-2 py-1.5 rounded border border-border-default focus:outline-none focus:border-accent-text placeholder:text-text-muted"
            />
          </div>
          <div className="max-h-48 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="text-[12px] text-text-muted px-3 py-3 text-center">
                {initiatives.length === 0 ? 'No initiatives in this team' : 'No matches'}
              </p>
            ) : (
              filtered.map(initiative => (
                <button
                  key={initiative.id}
                  onClick={() => assign(initiative.id)}
                  className={`w-full text-left px-3 py-2 text-[12px] hover:bg-surface-3 transition-colors flex items-center justify-between gap-2 ${initiative.id === currentInitiativeId ? 'bg-surface-3' : ''}`}
                >
                  <span className="text-text-primary truncate">{initiative.title}</span>
                  <span className="shrink-0 text-[10px] text-text-muted font-mono tabular-nums">{initiative.progress}%</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
