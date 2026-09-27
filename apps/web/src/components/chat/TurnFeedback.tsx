'use client';

/**
 * Thumbs on an assistant turn (docs/design/tier-model-pools.md §9 "Chat").
 * A thumbs-down records at once, then offers one optional reason: a popover
 * on desktop, a bottom sheet on a phone. Only labels are sent, never text.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import BottomSheet from '@/components/BottomSheet';
import { CHAT_FEEDBACK_REASONS, CHAT_FEEDBACK_REASON_LABELS, type ChatFeedbackReason } from '@buildd/core/tier-pool';

export type TurnSignal = 'up' | 'down';
export interface TurnVote { signal: TurnSignal; reason: ChatFeedbackReason | null }

interface Store {
  votes: Record<string, TurnVote>;
  /** A turn still streaming has no saved row yet, so it cannot be rated. */
  pendingId: string | null;
  vote(messageId: string, signal: TurnSignal, reason?: ChatFeedbackReason | null): Promise<void>;
}

const Ctx = createContext<Store | null>(null);

/** Send one vote. The route toggles an identical vote off. */
export async function postTurnVote(messageId: string, signal: TurnSignal, reason?: ChatFeedbackReason | null): Promise<boolean> {
  const res = await fetch('/api/feedback', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entityType: 'conversation_message', entityId: messageId, signal, ...(reason ? { reason } : {}) }),
  }).catch(() => null);
  return !!res?.ok;
}

/**
 * Holds this viewer's votes for the conversation. `messageIds` are the saved
 * assistant turns; their current votes load once per set.
 */
export function TurnFeedbackProvider({ messageIds, pendingId, children, initial }: {
  messageIds: readonly string[];
  pendingId: string | null;
  children: ReactNode;
  /** Fixtures and tests: skip the fetch. */
  initial?: Record<string, TurnVote>;
}) {
  const [votes, setVotes] = useState<Record<string, TurnVote>>(initial ?? {});
  const key = messageIds.join(',');
  useEffect(() => {
    if (initial || !key) return;
    let cancelled = false;
    fetch(`/api/feedback?entityType=conversation_message&entityIds=${encodeURIComponent(key)}`, { credentials: 'include', cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then((d: { feedback?: Record<string, string>; reasons?: Record<string, string> } | null) => {
        if (cancelled || !d?.feedback) return;
        const next: Record<string, TurnVote> = {};
        for (const [id, s] of Object.entries(d.feedback)) {
          if (s === 'up' || s === 'down') next[id] = { signal: s, reason: (d.reasons?.[id] as ChatFeedbackReason) ?? null };
        }
        setVotes(v => ({ ...next, ...v }));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [key, initial]);

  const vote = useCallback(async (messageId: string, signal: TurnSignal, reason?: ChatFeedbackReason | null) => {
    let prev: TurnVote | undefined;
    setVotes(v => {
      prev = v[messageId];
      const next = { ...v };
      // Same vote with no new reason toggles off, as the route does.
      if (prev && prev.signal === signal && !reason) delete next[messageId];
      else next[messageId] = { signal, reason: reason ?? null };
      return next;
    });
    const ok = await postTurnVote(messageId, signal, reason);
    if (!ok) setVotes(v => { const n = { ...v }; if (prev) n[messageId] = prev; else delete n[messageId]; return n; });
  }, []);

  const store = useMemo(() => ({ votes, pendingId, vote }), [votes, pendingId, vote]);
  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

function useIsDesktop(): boolean {
  return useSyncExternalStore(
    (cb) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => {};
      const mq = window.matchMedia('(min-width: 768px)');
      mq.addEventListener?.('change', cb);
      return () => mq.removeEventListener?.('change', cb);
    },
    () => (typeof window !== 'undefined' && !!window.matchMedia ? window.matchMedia('(min-width: 768px)').matches : true),
    () => true,
  );
}

function Thumb({ down, filled }: { down?: boolean; filled: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className={`h-4 w-4 ${down ? 'rotate-180' : ''}`} fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M7 11v9H4a1 1 0 01-1-1v-7a1 1 0 011-1h3zm0 0l4-8a2 2 0 012 2v4h5.5a2 2 0 012 2.3l-1.2 7A2 2 0 0117.3 20H7" strokeLinejoin="round" />
    </svg>
  );
}

function ReasonList({ selected, onSelect }: { selected: ChatFeedbackReason | null; onSelect: (r: ChatFeedbackReason) => void }) {
  return (
    <div className="flex flex-col gap-2" role="radiogroup" aria-label="What went wrong?">
      {CHAT_FEEDBACK_REASONS.map(r => (
        <button
          key={r}
          type="button"
          role="radio"
          aria-checked={selected === r}
          data-testid="turn-feedback-reason"
          data-reason={r}
          onClick={() => onSelect(r)}
          className={`border-2 px-3 py-2.5 text-left font-mono text-[13px] ${selected === r
            ? 'border-text-primary bg-text-primary text-surface-1'
            : 'border-border-strong bg-surface-2 text-text-primary hover:bg-surface-3'}`}
        >
          {CHAT_FEEDBACK_REASON_LABELS[r]}
        </button>
      ))}
    </div>
  );
}

/** The thumbs row under one assistant turn. Renders nothing without a provider. */
export default function TurnFeedback({ messageId }: { messageId: string }) {
  const store = useContext(Ctx);
  const desktop = useIsDesktop();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<ChatFeedbackReason | null>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !desktop) return;
    const onDoc = (e: MouseEvent) => { if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open, desktop]);

  if (!store || store.pendingId === messageId) return null;
  const current = store.votes[messageId] ?? null;

  const up = () => { setOpen(false); void store.vote(messageId, 'up'); };
  const down = () => {
    if (current?.signal === 'down') { setOpen(false); void store.vote(messageId, 'down'); return; }
    setPicked(null);
    setOpen(true);
    void store.vote(messageId, 'down');
  };
  const send = () => {
    if (picked) void store.vote(messageId, 'down', picked);
    setOpen(false);
  };

  const btn = (active: boolean) => `grid h-8 w-8 place-items-center border ${active
    ? 'border-border-strong text-text-primary bg-surface-2'
    : 'border-transparent text-text-muted hover:text-text-primary hover:border-border-default'}`;

  const actions = (
    <div className="mt-4 grid grid-cols-2 gap-3">
      <button type="button" onClick={() => setOpen(false)} className="h-11 font-mono text-[13px] text-text-secondary hover:text-text-primary" data-testid="turn-feedback-skip">Skip</button>
      <button type="button" onClick={send} disabled={!picked} className="btn btn-primary h-11" data-testid="turn-feedback-send">Send</button>
    </div>
  );

  return (
    <div className="relative flex items-center gap-1" data-testid="turn-feedback" data-vote={current?.signal ?? ''} data-reason={current?.reason ?? ''}>
      <button type="button" aria-label="Good reply" aria-pressed={current?.signal === 'up'} onClick={up} className={btn(current?.signal === 'up')} data-testid="turn-feedback-up">
        <Thumb filled={false} />
      </button>
      <button type="button" aria-label="Bad reply" aria-pressed={current?.signal === 'down'} onClick={down} className={btn(current?.signal === 'down')} data-testid="turn-feedback-down">
        <Thumb down filled={false} />
      </button>
      {current?.reason && (
        <span className="ml-1 font-mono text-[11.5px] text-text-muted">{CHAT_FEEDBACK_REASON_LABELS[current.reason]}</span>
      )}

      {open && desktop && (
        <div ref={popRef} role="dialog" aria-label="What went wrong?" data-testid="turn-feedback-sheet"
          className="absolute left-0 bottom-10 z-30 w-72 border-2 border-border-strong bg-surface-1 p-4 shadow-[4px_4px_0_0_var(--color-border-strong,#222)]">
          <h3 className="mb-3 font-mono text-[14px] font-bold text-text-primary">What went wrong?</h3>
          <ReasonList selected={picked} onSelect={setPicked} />
          {actions}
        </div>
      )}
      {!desktop && (
        <BottomSheet open={open} onClose={() => setOpen(false)} title="What went wrong?" testId="turn-feedback-sheet" trapFocus>
          <ReasonList selected={picked} onSelect={setPicked} />
          {actions}
        </BottomSheet>
      )}
    </div>
  );
}
