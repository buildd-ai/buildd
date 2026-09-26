'use client';

import { useEffect, useState, type ReactNode } from 'react';
import type { UnifiedQuestion } from './question-hero';

interface Props {
  question: UnifiedQuestion;
  /** "The builder asks" — who is asking, from the task's role. */
  askerLabel: string;
  /** Short age, e.g. "7s ago". */
  askedAgo?: string | null;
  /** Extra eyebrow clause, e.g. "paused". */
  stateNote?: string | null;
  onAnswer: (answer: string) => void;
  /** The answer being sent, if any. */
  sending: string | null;
  /** Replaces the choices once the answer has gone. */
  sent?: ReactNode;
  error?: ReactNode;
  /** Number keys answer. Only the page's primary question should take them. */
  enableKeys?: boolean;
  testId?: string;
  /**
   * `hero` (default): the task page's primary decision. `feed`: the same
   * question as a card in the chat feed — smaller type, same choices, same
   * answer path.
   */
  density?: 'hero' | 'feed';
  /** Extra eyebrow content on the right (the task's scope, a link). */
  aside?: ReactNode;
}

const DENSITY = {
  hero: {
    section: 'px-5 py-5 md:px-10 md:py-9',
    headline: 'mt-4 md:mt-5 text-[26px] md:text-[40px] font-bold leading-[1.15] tracking-[-0.5px]',
    body: 'mt-3 md:mt-4 text-[14px] md:text-[16px]',
    grid: 'mt-6 md:mt-8 gap-4 md:gap-6',
    option: 'px-5 py-4 md:px-7 md:py-6',
    optionLabel: 'mt-2 md:mt-3 text-[20px] md:text-[25px]',
    optionDesc: 'mt-2 md:mt-3 text-[14px] md:text-[15px]',
    form: 'mt-5 md:mt-6',
    input: 'min-h-12 md:min-h-14 px-4 md:px-5',
    send: 'min-h-12 md:min-h-14 px-5 md:px-6',
  },
  feed: {
    section: 'px-4 py-4 md:px-5 md:py-4',
    headline: 'mt-3 text-[22px] md:text-[18px] font-bold leading-[1.2]',
    body: 'mt-2 text-[14px] md:text-[13.5px]',
    grid: 'mt-4 gap-3',
    option: 'px-4 py-3',
    optionLabel: 'mt-1 text-[17px] md:text-[15px]',
    optionDesc: 'mt-1 text-[13.5px] md:text-[12.5px]',
    form: 'mt-3',
    input: 'min-h-11 px-3',
    send: 'min-h-11 px-4',
  },
} as const;

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

/**
 * The one question surface on the task page. An open question is the decision
 * the page exists for, so it is the hero: the ask in large type, each option a
 * large choice with its consequence, the agent's recommendation solid orange,
 * number keys to answer, and a free-text field for anything else (the only
 * way to answer an open-ended question).
 */
export default function QuestionHero({
  question,
  askerLabel,
  askedAgo,
  stateNote,
  onAnswer,
  sending,
  sent,
  error,
  enableKeys = false,
  testId = 'task-question-hero',
  density = 'hero',
  aside,
}: Props) {
  const d = DENSITY[density];
  const [freeText, setFreeText] = useState('');
  const { options } = question;
  const busy = sending !== null;

  useEffect(() => {
    if (!enableKeys || sent || options.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      const n = Number.parseInt(e.key, 10);
      if (!Number.isInteger(n) || n < 1 || n > Math.min(9, options.length) || busy) return;
      e.preventDefault();
      onAnswer(options[n - 1].label);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enableKeys, sent, options, busy, onAnswer]);

  return (
    <section
      data-testid={testId}
      data-density={density}
      className={`bg-card border-2 border-accent shadow-[var(--accent-shadow)] ${d.section}`}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] uppercase tracking-[2px]">
        <span className="w-[9px] h-[9px] bg-accent shrink-0" aria-hidden="true" />
        <span data-testid="worker-needs-input-label" className="font-semibold text-accent-text">{askerLabel}</span>
        {askedAgo && <span className="hidden md:inline text-text-muted tracking-[1px]" suppressHydrationWarning>· {askedAgo}</span>}
        {stateNote && <span className="hidden md:inline text-text-muted tracking-[1px]">· {stateNote}</span>}
        {aside && <span className="ml-auto normal-case tracking-[1px] text-text-muted">{aside}</span>}
      </div>

      <h2
        data-testid="worker-needs-input-prompt"
        className={`${d.headline} text-text-primary [overflow-wrap:anywhere]`}
      >
        {question.headline}
      </h2>
      {question.body && (
        <p className={`${d.body} max-w-[64ch] leading-relaxed text-text-secondary [overflow-wrap:anywhere] whitespace-pre-line`}>
          {question.body}
        </p>
      )}

      {error && <div data-testid="worker-answer-error" className="mt-4 text-sm text-status-error">{error}</div>}

      {sent ? (
        <div data-testid="worker-answer-sent" className="mt-6 border-2 border-status-success px-4 py-3 text-sm text-status-success">
          {sent}
        </div>
      ) : (
        <>
          {options.length > 0 && (
            <div data-testid="worker-needs-input-options" className={`${d.grid} grid ${options.length === 2 ? 'md:grid-cols-2' : options.length > 2 ? 'md:grid-cols-2 xl:grid-cols-3' : ''}`}>
              {options.map((o, i) => (
                <button
                  key={`${o.label}-${i}`}
                  type="button"
                  data-testid="question-option"
                  data-recommended={o.recommended ? 'true' : undefined}
                  onClick={() => onAnswer(o.label)}
                  disabled={busy}
                  className={`relative flex flex-col items-stretch justify-start text-left ${d.option} border-2 transition-transform hover:-translate-y-px disabled:opacity-60 disabled:hover:translate-y-0 cursor-pointer ${
                    o.recommended
                      ? 'bg-accent text-[var(--on-accent)] border-[var(--on-accent)] shadow-[5px_5px_0_0_var(--on-accent)]'
                      : 'bg-surface-2 text-text-primary border-border-strong'
                  }`}
                >
                  {options.length <= 9 && density === 'hero' && (
                    <kbd
                      aria-hidden="true"
                      className={`hidden md:grid absolute top-4 right-4 w-8 h-8 place-items-center border-2 font-mono text-[13px] font-semibold ${
                        o.recommended ? 'border-[var(--on-accent)]' : 'border-border-strong text-text-secondary'
                      }`}
                    >
                      {i + 1}
                    </kbd>
                  )}
                  <span className={`block font-mono text-[11px] uppercase tracking-[2px] font-semibold ${o.recommended ? '' : 'text-text-muted'}`}>
                    {o.recommended ? <>Recommended<span className="hidden md:inline"> by the agent</span></> : 'Alternative'}
                  </span>
                  <span className={`block ${d.optionLabel} ${density === 'hero' ? 'pr-0 md:pr-10' : ''} font-semibold leading-tight [overflow-wrap:anywhere]`}>
                    {sending === o.label ? 'Sending…' : o.label}
                  </span>
                  {o.description && (
                    <span className={`block ${d.optionDesc} leading-relaxed [overflow-wrap:anywhere] ${o.recommended ? '' : 'text-text-secondary'}`}>
                      {o.description}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}

          <form
            data-testid="worker-needs-input-freetext"
            className={`${d.form} flex items-stretch`}
            onSubmit={(e) => {
              e.preventDefault();
              if (freeText.trim() && !busy) onAnswer(freeText.trim());
            }}
          >
            <label className="sr-only" htmlFor={`${testId}-freetext`}>Answer in your own words</label>
            <input
              id={`${testId}-freetext`}
              type="text"
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
              placeholder={options.length > 0 ? 'Or answer in your own words…' : 'Type your answer…'}
              disabled={busy}
              className={`flex-1 min-w-0 ${d.input} bg-surface-2 border-2 border-dashed border-border-strong text-base md:text-[15px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-solid focus:border-accent`}
            />
            <button
              type="submit"
              disabled={busy || !freeText.trim()}
              className={`shrink-0 ${d.send} border-2 border-l-0 border-border-strong bg-surface-2 text-[14px] font-medium text-text-primary hover:bg-surface-3 disabled:text-text-muted`}
            >
              {busy && sending === freeText.trim() ? 'Sending…' : 'Send'}
            </button>
          </form>

          {options.length > 0 && enableKeys && (
            <p className="hidden md:flex mt-4 items-center gap-1.5 font-mono text-[12px] text-text-muted">
              Press
              {options.slice(0, Math.min(options.length, 3)).map((_, i) => (
                <span key={i} className="inline-flex items-center gap-1.5">
                  {i > 0 && (i === Math.min(options.length, 3) - 1 ? 'or' : ',')}
                  <kbd className="px-1.5 border border-border-strong text-text-secondary">{i + 1}</kbd>
                </span>
              ))}
              to answer
            </p>
          )}
        </>
      )}
    </section>
  );
}
