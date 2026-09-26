'use client';

/**
 * Shared chrome for object cards in the feed: the kind eyebrow, the state chip,
 * the loading and gone states. The bodies are the objects' own components.
 */
import type { ReactNode } from 'react';
import type { BuilddObjectRef } from '../chat-contract';

export type Tone = 'live' | 'attention' | 'ok' | 'bad' | 'idle';

const TONE_CLS: Record<Tone, string> = {
  live: 'border-accent text-accent-text',
  attention: 'border-status-warning text-status-warning',
  ok: 'border-status-success text-status-success',
  bad: 'border-status-error text-status-error',
  idle: 'border-border-default text-text-muted',
};

export function StateChip({ label, tone, pulse = false }: { label: string; tone: Tone; pulse?: boolean }) {
  return (
    <span data-testid="object-state-chip" className={`inline-flex h-[22px] shrink-0 items-center gap-1.5 border-[1.5px] px-2 font-mono text-[11px] font-bold uppercase tracking-[1.2px] ${TONE_CLS[tone]}`}>
      {pulse && <span aria-hidden="true" className="h-2 w-2 animate-status-pulse bg-current" />}
      {label}
    </span>
  );
}

/** A mission's chip label → its tone. */
export function missionTone(stateLabel: string, status: string): Tone {
  const s = `${stateLabel} ${status}`.toLowerCase();
  if (/need|waiting on you|question|decision/.test(s)) return 'attention';
  if (/fail|error|blocked|stalled|budget/.test(s)) return 'bad';
  if (/complete|done|shipped|verified/.test(s)) return 'ok';
  if (/held|paused|queued|archived|draft/.test(s)) return 'idle';
  return 'live';
}

export function Eyebrow({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`font-mono text-[11px] font-bold uppercase tracking-[2px] ${className}`}>{children}</span>;
}

/** The card while its first load is in flight: the ref's own fallback text, so nothing jumps. */
export function ObjectPlaceholder({ objRef, error }: { objRef: BuilddObjectRef; error?: string | null }) {
  return (
    <div
      data-testid="object-card"
      data-kind={objRef.kind}
      data-state={error ? 'gone' : 'loading'}
      className="border-2 border-border-default bg-card px-4 py-3 font-mono text-[12.5px] text-text-secondary"
    >
      <Eyebrow className="text-text-muted">{objRef.kind}</Eyebrow>
      <p className="mt-1 [overflow-wrap:anywhere]">{objRef.fallbackText}</p>
      {error && <p className="mt-1 text-[11.5px] text-text-muted">{error === 'Not found' ? 'No longer available.' : error}</p>}
    </div>
  );
}

/** "◂ In the pane" / "Expand ↑" / "Open" — the card's way to the full view. */
export function OpenButton({ inPane, onOpen, label }: { inPane: boolean; onOpen: () => void; label?: string }) {
  const cls = 'font-mono text-[11px] font-bold uppercase tracking-[1.5px] text-accent-text';
  return (
    <>
      {/* Phone: there is no pane, the full view opens as a sheet. */}
      <button type="button" data-testid="object-expand" onClick={onOpen} className={`md:hidden min-h-11 px-1 ${cls}`}>
        Expand ↑
      </button>
      {inPane ? (
        <span data-testid="object-in-pane" className={`hidden md:inline ${cls}`}>◂ In the pane</span>
      ) : (
        <button type="button" data-testid="object-open" onClick={onOpen} className={`hidden md:inline ${cls} hover:underline`}>
          {label ?? 'Open in pane ▸'}
        </button>
      )}
    </>
  );
}
