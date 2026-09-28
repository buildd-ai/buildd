'use client';

/**
 * Thumbs on an assistant turn. A thumbs-up records at once. A thumbs-down
 * records at once, then offers one optional reason (a popover on wide
 * screens, a bottom sheet on phones); Send records the reason, Skip leaves the
 * plain thumbs-down. The same thumb again takes the vote back. Only reason
 * keys are sent, never free text.
 *
 * The kit does no fetching: `onFeedback` records a vote (resolve `false` or
 * throw to roll it back), `loadVotes` or `initial` supplies the votes already
 * cast. A turn still streaming (`pendingId`) has no saved row yet, so it shows
 * no thumbs.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { applyTurnVote, type TurnSignal, type TurnVote } from '@builddai/ai-kit/chat/contract';
import { MenuOption, kitVarsAt, sheetMatches } from './Menu';

export interface FeedbackReason<R extends string = string> {
  key: R;
  label: string;
}

/** Five reasons a turn was bad. "Too slow" is not a mistake, so an app may grade it apart. */
export const DEFAULT_FEEDBACK_REASONS: readonly FeedbackReason[] = [
  { key: 'wrong_answer', label: 'Wrong answer' },
  { key: 'wrong_action', label: 'Wrong action' },
  { key: 'made_up', label: 'Made something up' },
  { key: 'ignored_me', label: 'Ignored what I said' },
  { key: 'too_slow', label: 'Too slow' },
];

/** One vote to record. The same vote again (`cleared: true`) means take it back. */
export interface TurnFeedbackEvent<R extends string = string> {
  messageId: string;
  signal: TurnSignal;
  reason: R | null;
  /** The vote this replaces, so the app can mirror a server-side toggle. */
  previous: TurnVote<R> | null;
  /** After this the turn has no vote. */
  cleared: boolean;
}

export interface TurnFeedbackProviderProps<R extends string = string> {
  /** Record one vote. Resolve `false` (or throw) and the vote rolls back. */
  onFeedback(event: TurnFeedbackEvent<R>): Promise<boolean | void> | boolean | void;
  /** Votes already cast (fixtures, or loaded by the app). */
  initial?: Readonly<Record<string, TurnVote<R>>>;
  /** Load the votes already cast for these saved turns, once per set. Skipped with `initial`. */
  loadVotes?(messageIds: readonly string[]): Promise<Record<string, TurnVote<R>>>;
  messageIds?: readonly string[];
  /** The turn still streaming: no thumbs until it is saved. */
  pendingId?: string | null;
  reasons?: readonly FeedbackReason<R>[];
  /** The reason prompt's heading. */
  title?: string;
  children: ReactNode;
}

interface Store {
  votes: Record<string, TurnVote>;
  pendingId: string | null;
  reasons: readonly FeedbackReason[];
  title: string;
  vote(messageId: string, signal: TurnSignal, reason?: string | null): Promise<void>;
}

const Ctx = createContext<Store | null>(null);

export function TurnFeedbackProvider<R extends string = string>({
  onFeedback, initial, loadVotes, messageIds = [], pendingId = null,
  reasons = DEFAULT_FEEDBACK_REASONS as readonly FeedbackReason<R>[], title = 'What went wrong?', children,
}: TurnFeedbackProviderProps<R>) {
  const [votes, setVotes] = useState<Record<string, TurnVote>>(() => ({ ...(initial ?? {}) }));
  const votesRef = useRef(votes);
  votesRef.current = votes;
  const handler = useRef(onFeedback);
  handler.current = onFeedback;
  const loader = useRef(loadVotes);
  loader.current = loadVotes;

  const key = messageIds.join(',');
  useEffect(() => {
    if (initial || !key || !loader.current) return;
    let cancelled = false;
    loader.current(key.split(',')).then(
      (loaded) => { if (!cancelled && loaded) setVotes(v => ({ ...loaded, ...v })); },
      () => { /* keep what we have */ },
    );
    return () => { cancelled = true; };
  }, [key, initial]);

  const vote = useCallback(async (messageId: string, signal: TurnSignal, reason: string | null = null) => {
    const before = votesRef.current;
    const previous = before[messageId] ?? null;
    const next = applyTurnVote(before, messageId, signal, reason);
    votesRef.current = next;
    setVotes(next);
    let ok: boolean;
    try {
      ok = (await handler.current({ messageId, signal, reason: reason as R | null, previous: previous as TurnVote<R> | null, cleared: !next[messageId] })) !== false;
    } catch {
      ok = false;
    }
    if (!ok) {
      setVotes(v => {
        const n = { ...v };
        if (previous) n[messageId] = previous; else delete n[messageId];
        votesRef.current = n;
        return n;
      });
    }
  }, []);

  const store = useMemo<Store>(() => ({ votes, pendingId, reasons, title, vote }), [votes, pendingId, reasons, title, vote]);
  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

/** This conversation's votes and the `vote` action; null outside a provider. */
export function useTurnFeedback(): Pick<Store, 'votes' | 'vote' | 'pendingId'> | null {
  return useContext(Ctx);
}

function Thumb({ down }: { down?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" className="kit-thumb" data-down={down || undefined} fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M7 11v9H4a1 1 0 01-1-1v-7a1 1 0 011-1h3zm0 0l4-8a2 2 0 012 2v4h5.5a2 2 0 012 2.3l-1.2 7A2 2 0 0117.3 20H7" strokeLinejoin="round" />
    </svg>
  );
}

/** The thumbs row under one assistant turn. Renders nothing without a provider or while the turn streams. */
export function TurnFeedback({ messageId, className }: { messageId: string; className?: string }) {
  const store = useContext(Ctx);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [sheet, setSheet] = useState<{ vars: CSSProperties } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const downBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = () => { setOpen(false); downBtn.current?.focus(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    const onDown = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || wrap.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
    };
  }, [open]);

  if (!store || store.pendingId === messageId) return null;
  const current = store.votes[messageId] ?? null;
  const labelOf = (k: string) => store.reasons.find(r => r.key === k)?.label ?? k;

  const up = () => { setOpen(false); void store.vote(messageId, 'up'); };
  const down = () => {
    if (current?.signal === 'down') { setOpen(false); void store.vote(messageId, 'down'); return; }
    setPicked(null);
    setSheet(sheetMatches() ? { vars: kitVarsAt(wrap.current) } : null);
    setOpen(true);
    void store.vote(messageId, 'down');
  };
  const send = () => {
    // Not dimmed with nothing picked (a faded button fails contrast); it just waits.
    if (!picked) return;
    void store.vote(messageId, 'down', picked);
    setOpen(false);
  };

  const panelEl = (
    <div
      ref={panel}
      role="dialog"
      aria-label={store.title}
      className="kit-menu-panel kit-feedback-panel"
      data-sheet={sheet ? 'true' : undefined}
      data-testid="kit-feedback-sheet"
    >
      <p className="kit-menu-title">{store.title}</p>
      <div role="radiogroup" aria-label={store.title}>
        {store.reasons.map(r => (
          <MenuOption key={r.key} checked={picked === r.key} onSelect={() => setPicked(r.key)}>
            <span data-reason={r.key} data-testid="kit-feedback-reason">{r.label}</span>
          </MenuOption>
        ))}
      </div>
      <div className="kit-actions kit-feedback-actions">
        <button type="button" className="kit-btn" data-variant="quiet" onClick={() => setOpen(false)} data-testid="kit-feedback-skip">Skip</button>
        <button type="button" className="kit-btn" data-variant="primary" onClick={send} aria-disabled={!picked || undefined} data-testid="kit-feedback-send">Send</button>
      </div>
    </div>
  );

  return (
    <div
      ref={wrap}
      className={`kit-feedback${className ? ` ${className}` : ''}`}
      data-vote={current?.signal ?? ''}
      data-reason={current?.reason ?? ''}
      data-testid="kit-feedback"
    >
      <button type="button" className="kit-thumb-btn" aria-label="Good reply" aria-pressed={current?.signal === 'up'} onClick={up} data-testid="kit-feedback-up">
        <Thumb />
      </button>
      <button ref={downBtn} type="button" className="kit-thumb-btn" aria-label="Bad reply" aria-pressed={current?.signal === 'down'} onClick={down} data-testid="kit-feedback-down">
        <Thumb down />
      </button>
      {current?.reason && <span className="kit-feedback-reason">{labelOf(current.reason)}</span>}
      {open && !sheet && panelEl}
      {open && sheet && typeof document !== 'undefined' && createPortal(
        <div className="kit-chat kit-sheet-layer" style={sheet.vars} data-testid="kit-feedback-layer">
          <div className="kit-sheet-scrim" aria-hidden="true" />
          {panelEl}
        </div>,
        document.body,
      )}
    </div>
  );
}
