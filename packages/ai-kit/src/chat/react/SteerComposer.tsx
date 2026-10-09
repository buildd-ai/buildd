'use client';

/**
 * Steer a running agent: tell it something while it works, rather than ask a
 * model about it. No model turn happens here. Each send goes to the app's
 * `onSend` (its instruction queue), and the list is what was sent so far,
 * each with its delivery state ("Sent" until the agent picks it up, then
 * "Delivered").
 *
 * The app owns the transport, the polling or realtime that moves a message to
 * delivered, and who may steer: pass `blockedReason` when no one can (no agent
 * running, not allowed) and the box says why instead of taking input. The
 * header and presence strip are optional: `title` ("Builder @ runner / task")
 * and `presence` items (runner, last heartbeat, current action).
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

/**
 * sent: queued, waiting for the agent's next turn. delivered: in the agent's
 * session, not read yet. acknowledged: the agent's turn read it. undelivered:
 * the run ended before it was read.
 */
export type SteerDelivery = 'sent' | 'delivered' | 'acknowledged' | 'undelivered';

export interface SteerMessage {
  id?: string;
  /** Null when the app hides the text (a sensitive workspace). */
  text: string | null;
  status: SteerDelivery;
}

export interface SteerPresenceItem {
  key: string;
  label: ReactNode;
  /** `strong` for the name, `muted` for freshness, `live` for the current action. */
  tone?: 'strong' | 'muted' | 'live';
}

export interface SteerComposerProps {
  /** Send one instruction. Throw (or reject) to show the error and keep the draft. */
  onSend(text: string): Promise<void> | void;
  messages: readonly SteerMessage[];
  /** Why nobody can steer right now; the box is disabled and says so. Null: steering is open. */
  blockedReason?: string | null;
  title?: ReactNode;
  /** The header eyebrow. */
  eyebrow?: string;
  presence?: readonly SteerPresenceItem[];
  /** Shown in the presence strip when `presence` is empty. */
  idlePresence?: ReactNode;
  onClose?(): void;
  placeholder?: string;
  /** Accessible name of the box. */
  label?: string;
  /** Shown with no messages yet. */
  emptyText?: ReactNode;
  /** The label for a message whose text is hidden. */
  hiddenText?: string;
  className?: string;
}

const DELIVERY_LABEL: Record<SteerDelivery, string> = { sent: 'Sent', delivered: 'Delivered', acknowledged: 'Read', undelivered: 'Not delivered' };

/** "Sent" / "Delivered" / "Read" / "Not delivered". */
export function steerStatusLabel(s: SteerDelivery): string {
  return DELIVERY_LABEL[s];
}

/** "Builder @ atlas / rates service": the role (or "Agent"), the runner when known, then the work. */
export function steerTitle(roleName: string | null | undefined, runnerName: string | null | undefined, workLabel: string): string {
  const who = [roleName || 'Agent', runnerName ? `@ ${runnerName}` : null].filter(Boolean).join(' ');
  return `${who} / ${workLabel}`;
}

/** Whether Send may fire now. Pure, so the button and Enter agree. */
export function canSteer(input: { draft: string; sending: boolean; blockedReason?: string | null }): boolean {
  return !input.blockedReason && !input.sending && !!input.draft.trim();
}

export function SteerComposer({
  onSend, messages, blockedReason = null, title, eyebrow = 'Steer', presence = [], idlePresence,
  onClose, placeholder = 'Steer this agent…', label = 'Steer this agent',
  emptyText = 'Nothing sent yet. Instructions go straight to the agent, with no approval step.',
  hiddenText = '(hidden)', className,
}: SteerComposerProps) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const feed = useRef<HTMLDivElement>(null);
  const inputId = useId();
  const ready = canSteer({ draft, sending, blockedReason });

  useEffect(() => {
    const el = feed.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const send = async () => {
    const text = draft.trim();
    if (!canSteer({ draft, sending, blockedReason })) return;
    setSending(true);
    setError(null);
    try {
      await onSend(text);
      setDraft('');
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Failed to send');
    } finally {
      setSending(false);
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className={`kit-chat kit-steer${className ? ` ${className}` : ''}`} data-blocked={blockedReason ? 'true' : undefined} data-testid="kit-steer">
      {(title != null || onClose) && (
        <header className="kit-steer-header">
          <span className="kit-eyebrow">{eyebrow}</span>
          {title != null && <h2 className="kit-steer-title" data-testid="kit-steer-title">{title}</h2>}
          {onClose && (
            <button type="button" className="kit-btn" data-variant="quiet" aria-label="Close steering" onClick={onClose} data-testid="kit-steer-close">
              <span aria-hidden="true">✕</span>
            </button>
          )}
        </header>
      )}
      {(presence.length > 0 || idlePresence != null) && (
        <div className="kit-steer-presence" data-testid="kit-steer-presence">
          {presence.length > 0
            ? presence.map(p => <span key={p.key} className="kit-steer-presence-item" data-tone={p.tone ?? 'muted'} data-key={p.key}>{p.label}</span>)
            : <span className="kit-steer-presence-item" data-tone="muted">{idlePresence}</span>}
        </div>
      )}
      <div ref={feed} className="kit-steer-feed" data-testid="kit-steer-feed">
        {messages.length === 0 && <p className="kit-note">{emptyText}</p>}
        {messages.length > 0 && (
          <ul className="kit-steer-list">
            {messages.map((m, i) => (
              <li key={m.id ?? i} className="kit-steer-msg" data-status={m.status} data-testid="kit-steer-message">
                <p className="kit-text">{m.text ?? hiddenText}</p>
                <span className="kit-steer-status" data-status={m.status}>{steerStatusLabel(m.status)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <form className="kit-composer" data-busy={sending || undefined} onSubmit={e => { e.preventDefault(); void send(); }}>
        <label htmlFor={inputId} className="kit-sr-only">{label}</label>
        <textarea
          id={inputId}
          className="kit-composer-input"
          rows={2}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={blockedReason ?? placeholder}
          disabled={!!blockedReason || sending}
          data-testid="kit-steer-input"
        />
        <div className="kit-toolbar">
          <div className="kit-toolbar-slot" data-slot="scope" />
          <button
            type="submit"
            className="kit-send kit-steer-send"
            aria-disabled={!ready || undefined}
            data-testid="kit-steer-send"
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </form>
      {error && <p role="alert" className="kit-error" data-testid="kit-steer-error">{error}</p>}
    </div>
  );
}
