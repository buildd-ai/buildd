'use client';

/**
 * Shared chrome for object cards in the feed: the kind eyebrow, the state chip,
 * the loading and gone states. The bodies are the objects' own components.
 */
import type { ReactNode } from 'react';
import StatePill from '@/components/ui/StatePill';
import type { StateKey } from '@/components/ui/states';
import type { BuilddObjectRef } from '../chat-contract';

export type Tone = 'live' | 'neutral' | 'attention' | 'ok' | 'bad' | 'idle';

/** The shared state each chat tone speaks as, so a chip reads like every other pill in the app. */
const TONE_STATE: Record<Tone, StateKey> = {
  live: 'running', neutral: 'running', attention: 'needs_you', ok: 'landed', bad: 'failed', idle: 'ready',
};
export const toneState = (tone: Tone): StateKey => TONE_STATE[tone];

/** A chat object's state: the app's StatePill (glyph + word), never a chat-only chip. */
export function StateChip({ label, tone, pulse = false }: { label: string; tone: Tone; pulse?: boolean }) {
  return <StatePill state={TONE_STATE[tone]} label={label} className={pulse ? 'animate-status-pulse' : ''} data-testid="object-state-chip" />;
}

/** A mission's chip label → its tone. */
export function missionTone(stateLabel: string, status: string): Tone {
  const s = `${stateLabel} ${status}`.toLowerCase();
  if (/need|question|decision|awaiting verification|stalled/.test(s)) return 'attention';
  if (/fail|error|blocked|stalled|budget/.test(s)) return 'bad';
  if (/complete|done|shipped|verified/.test(s)) return 'ok';
  if (/held|paused|queued|archived|draft/.test(s)) return 'idle';
  return 'neutral';
}

export function Eyebrow({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`font-mono text-[11px] font-bold uppercase tracking-[2px] ${className}`}>{children}</span>;
}

/**
 * What a loading card reserves: about the height the loaded card settles at
 * (a phone's, then md and up), never more, so the card fills its slot when
 * its object arrives instead of pushing the reply below it down. A kind
 * without a card of its own keeps its one-line fallback.
 */
export const OBJECT_RESERVE: Record<string, string> = {
  task: 'min-h-[112px] md:min-h-[92px]',
  mission: 'min-h-[76px] md:min-h-[240px]',
  question: 'min-h-[120px]',
  pr: 'min-h-[56px]',
};

/** The card while its first load is in flight: the ref's own fallback text in a slot at the card's height, so nothing jumps. */
export function ObjectPlaceholder({ objRef, error }: { objRef: BuilddObjectRef; error?: string | null }) {
  const reserve = error ? undefined : OBJECT_RESERVE[objRef.kind];
  return (
    <div
      data-testid="object-card"
      data-kind={objRef.kind}
      data-state={error ? 'gone' : 'loading'}
      data-reserve={reserve ? '' : undefined}
      className={`rounded-[var(--radius-card)] border border-border-default bg-card px-4 py-3 font-mono text-[12.5px] text-text-secondary ${reserve ?? ''}`}
    >
      <Eyebrow className="text-text-muted">{objRef.kind}</Eyebrow>
      <p className="mt-1 [overflow-wrap:anywhere]">{objRef.fallbackText}</p>
      {error && <p className="mt-1 text-[11.5px] text-text-muted">{error === 'Not found' ? 'No longer available.' : error}</p>}
    </div>
  );
}

/** "◂ In the pane" / "Expand ↑" / "Open" — the card's way to the full view. */
export function OpenButton({ inPane, onOpen, label }: { inPane: boolean; onOpen: () => void; label?: string }) {
  const cls = 'font-mono text-[11px] font-bold uppercase tracking-[1.5px] text-text-primary';
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
