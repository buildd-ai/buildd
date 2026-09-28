'use client';

/**
 * The directive card (docs/design/memory-done-right.md, "Chat"): the person
 * just stated a standing rule, and one tap keeps it. The rule is said in
 * Newsreader; the chrome is Plex Mono; the card is square with a 1px rule and
 * the 3px offset shadow of every chat object, over a faint patch of sea (calm
 * teal: this is a quiet offer, not something that needs them).
 *
 * Self-contained: it reads its own part (which carries the conversation id)
 * and talks to /api/chat/directives itself, so the thread renderer only has
 * to place it (<DirectiveCards /> under an assistant message).
 */
import { useState } from 'react';
import Link from 'next/link';
import type { ChatDirectiveCandidateData, ChatDirectiveScope } from '@buildd/shared';
import { STANDING_RULES_HREF, directiveCandidates, initialScope, saveRequest, savedLine, scopeOptions } from './directive-card';

type CardState = 'open' | 'saving' | 'saved' | 'dismissing' | 'dismissed';

/** A faint, still patch of the calm sea behind the card. Round pools, never lines. */
function FaintSea() {
  return (
    <span
      aria-hidden="true"
      data-testid="directive-sea"
      className="pointer-events-none absolute inset-0 opacity-70"
      style={{
        background: [
          'radial-gradient(circle at 12% 18%, var(--sea-calm-1) 0, transparent 42%)',
          'radial-gradient(circle at 88% 78%, var(--sea-calm-3) 0, transparent 46%)',
          'radial-gradient(circle at 62% 8%, var(--sea-calm-2) 0, transparent 34%)',
        ].join(', '),
      }}
    />
  );
}

export function DirectiveCard({ data, messageId }: { data: ChatDirectiveCandidateData; messageId: string }) {
  const [state, setState] = useState<CardState>(data.status === 'saved' ? 'saved' : data.status === 'dismissed' ? 'dismissed' : 'open');
  const [scope, setScope] = useState<ChatDirectiveScope>(data.savedScope ?? initialScope(data));
  const [error, setError] = useState<string | null>(null);
  const options = scopeOptions(data);
  const busy = state === 'saving' || state === 'dismissing';

  const save = async () => {
    setState('saving');
    setError(null);
    try {
      const res = await fetch('/api/chat/directives', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(saveRequest(data, scope, messageId)),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(typeof body.message === 'string' ? body.message : "Couldn't save that rule. Try again.");
      }
      setState('saved');
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save that rule. Try again.");
      setState('open');
    }
  };

  const dismiss = async () => {
    setState('dismissing');
    // "Not now" folds the card at once; the server only remembers it for other devices.
    void fetch('/api/chat/directives/dismiss', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: data.conversationId, messageId }),
    }).catch(() => {});
    setState('dismissed');
  };

  if (state === 'dismissed') {
    return (
      <div data-testid="directive-card" data-state="dismissed" className="border border-[var(--chat-rule)] bg-[var(--chat-surface)] px-3.5 py-2 font-mono text-[12px] text-[var(--chat-muted)]">
        Not saved as a rule.
      </div>
    );
  }

  if (state === 'saved') {
    return (
      <section data-testid="directive-card" data-state="saved" className="relative overflow-hidden border border-[var(--chat-rule-strong)] bg-[var(--chat-surface)] shadow-[3px_3px_0_0_var(--chat-rule)]">
        <FaintSea />
        <div className="relative flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3 md:px-5">
          <span className="flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-[.16em] text-[var(--mood-calm)]">
            <span aria-hidden="true" className="h-2 w-2 bg-[var(--mood-calm)]" />Rule saved
          </span>
          <span data-testid="directive-saved-line" className="font-mono text-[12px] text-[var(--chat-muted)]">{savedLine(data, scope)}</span>
          <Link href={STANDING_RULES_HREF} className="ml-auto min-h-8 font-mono text-[12px] text-[var(--chat-text)] underline decoration-[var(--chat-rule-strong)] underline-offset-4 hover:decoration-[var(--chat-text)]">
            Edit in Settings
          </Link>
        </div>
        <p className="relative px-4 pb-3.5 font-voice text-[16.5px] leading-[1.4] text-[var(--chat-text)] [overflow-wrap:anywhere] md:px-5">{data.text}</p>
      </section>
    );
  }

  return (
    <section
      data-testid="directive-card"
      data-state={state}
      aria-label="Save this as a standing rule"
      className="relative overflow-hidden border border-[var(--chat-rule-strong)] bg-[var(--chat-surface)] shadow-[3px_3px_0_0_var(--chat-rule)]"
    >
      <FaintSea />
      <header className="relative flex items-center gap-3 border-b border-[var(--chat-rule)] px-4 py-2.5 md:px-5">
        <span className="flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-[.16em] text-[var(--mood-calm)]">
          <span aria-hidden="true" className="h-2 w-2 bg-[var(--mood-calm)]" />Standing rule
        </span>
        <span className="ml-auto font-mono text-[11px] text-[var(--chat-muted)]">for your chats</span>
      </header>
      <div className="relative px-4 py-3 md:px-5 md:py-4">
        <p data-testid="directive-text" className="font-voice text-[19px] leading-[1.35] text-[var(--chat-text)] [overflow-wrap:anywhere] md:text-[20px]">
          {data.text}
        </p>
        {options.length > 1 ? (
          <div role="radiogroup" aria-label="Where this rule applies" data-testid="directive-scope" className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] border border-[var(--chat-rule-strong)] md:max-w-[460px] md:grid-cols-2">
            {options.map((o, i) => {
              const on = scope === o.value;
              return (
                <button
                  key={o.value}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  data-testid={`directive-scope-${o.value}`}
                  disabled={busy}
                  title={o.label}
                  onClick={() => setScope(o.value)}
                  className={`min-h-11 min-w-0 truncate px-4 font-mono text-[12.5px] ${i > 0 ? 'border-l border-[var(--chat-rule-strong)] ' : ''}${on
                    ? 'bg-[var(--chat-text)] font-semibold text-[var(--chat-surface)]'
                    : 'bg-transparent text-[var(--chat-text)] hover:bg-[var(--chat-raised)]'}`}
                >
                  {o.label}
                </button>
              );
            })}
          </div>
        ) : (
          <p data-testid="directive-scope-fixed" className="mt-2.5 font-mono text-[12px] text-[var(--chat-muted)]">Applies in every chat.</p>
        )}
        {/* The words in --chat-text (status-error is below AA on the light chat surface); the square carries the colour. */}
        {error && (
          <p role="alert" className="mt-2 flex items-center gap-2 font-mono text-[12px] text-[var(--chat-text)]">
            <span aria-hidden="true" className="h-2 w-2 shrink-0 bg-status-error" />{error}
          </p>
        )}
      </div>
      <footer className="relative flex items-center gap-2 px-4 pb-4 pt-1 md:gap-2.5 md:px-5">
        <button
          type="button"
          data-testid="directive-save"
          disabled={busy}
          onClick={() => { void save(); }}
          className="min-h-11 shrink-0 whitespace-nowrap border-2 border-[var(--on-accent)] bg-accent px-4 font-convo text-[14px] font-semibold text-[var(--on-accent)] hover:bg-primary-hover disabled:opacity-60 md:px-5"
        >
          {state === 'saving' ? 'Saving…' : 'Remember this'}
        </button>
        <button
          type="button"
          data-testid="directive-dismiss"
          disabled={busy}
          onClick={() => { void dismiss(); }}
          className="min-h-11 shrink-0 px-2 font-convo text-[14px] font-medium text-text-secondary hover:text-text-primary disabled:opacity-60 md:px-3"
        >
          Not now
        </button>
      </footer>
    </section>
  );
}

/** Every directive card on one message. The thread renderer's one insertion point. */
export default function DirectiveCards({ parts, messageId }: { parts: ReadonlyArray<{ type: string }>; messageId: string }) {
  const cards = directiveCandidates(parts);
  if (cards.length === 0) return null;
  return <>{cards.map((d, i) => <DirectiveCard key={`${messageId}-${i}`} data={d} messageId={messageId} />)}</>;
}
