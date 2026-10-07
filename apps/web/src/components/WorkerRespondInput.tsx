'use client';

import { useState } from 'react';
import { useAnswerSubmit, type AnswerSubmitState } from '@/app/app/(protected)/tasks/[id]/respond/use-answer-submit';
import AnswerRecorded from './AnswerRecorded';
import { normalizeOptions } from '@/app/app/(protected)/tasks/[id]/question-hero';
import type { WaitingForOption } from '@buildd/shared';

interface WorkerRespondInputProps {
  workerId: string;
  /** The worker's task: marks the global banner answered. */
  taskId?: string | null;
  question: string;
  /** Canonical rich options, or legacy plain strings. */
  options?: (string | WaitingForOption)[] | null;
  /** Question brief: the task and the exact decision. */
  context?: string;
  /**
   * The submission, when the host owns it so the answer outlives this input
   * (TaskActionZone: a refetch drops the question, and with it this input).
   * Omitted, the input owns it and collapses into the answer itself.
   */
  answer?: AnswerSubmitState;
}

export default function WorkerRespondInput({
  workerId,
  taskId = null,
  question,
  options,
  context,
  answer: hosted,
}: WorkerRespondInputProps) {
  const [message, setMessage] = useState('');
  const [lastTried, setLastTried] = useState<string | null>(null);
  const own = useAnswerSubmit({ workerId, taskId, resetKey: `${workerId}:${question}` });
  const { submit, sending, outcome, error } = hosted ?? own;
  const busy = sending !== null;
  const choices = normalizeOptions(options as WaitingForOption[] | null | undefined);

  if (outcome) return <AnswerRecorded outcome={outcome} className="mt-2" />;

  async function handleSubmit(value?: string) {
    const text = (value ?? message).trim();
    if (!text || busy) return;
    setLastTried(text);
    await submit(text);
    if (value === undefined) setMessage('');
  }

  return (
    <div className="mt-2 ml-5 space-y-2" aria-busy={busy || undefined}>
      {/* Question */}
      <div className="flex items-start gap-2">
        <span className="glow-dot glow-dot-warning mt-1 shrink-0" />
        <p className="text-[13px] text-status-warning leading-relaxed">
          {question}
        </p>
      </div>
      {context && (
        <p data-testid="question-brief-context" className="ml-[18px] text-[12px] leading-relaxed text-text-secondary">
          {context}
        </p>
      )}

      {/* Quick option buttons */}
      {choices.length > 0 && (
        <div className="flex flex-wrap gap-1.5 ml-[18px]">
          {choices.map((choice) => {
            const opt = choice.label;
            const pending = sending === opt.trim();
            return (
              <button
                key={opt}
                title={choice.description}
                type="button"
                data-testid="respond-option"
                data-pending={pending ? 'true' : undefined}
                disabled={busy}
                onClick={() => handleSubmit(opt)}
                className={`px-2.5 py-1 rounded-sm border text-[12px] transition-colors disabled:cursor-not-allowed ${
                  pending
                    ? 'bg-accent/20 border-accent text-accent-text'
                    : 'bg-surface-3 border-border-default text-text-secondary hover:text-accent-text hover:border-accent/40 disabled:opacity-40'
                }`}
              >
                {pending ? `Sending… ${opt}` : opt}
                {!pending && choice.recommended && <span className="sr-only"> (recommended)</span>}
              </button>
            );
          })}
        </div>
      )}

      {/* Text input + Send */}
      <div className="flex gap-2 ml-[18px]">
        <input
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSubmit();
            }
          }}
          placeholder="Type your response…"
          disabled={busy}
          className="flex-1 px-3 py-2 rounded-sm bg-surface-1 border border-border-default text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none transition-colors disabled:opacity-50"
        />
        <button
          type="button"
          disabled={busy || !message.trim()}
          onClick={() => handleSubmit()}
          className="px-4 py-2 rounded-sm bg-accent/20 text-accent-text text-[13px] font-medium hover:bg-accent/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy && sending === message.trim() ? 'Sending…' : 'Send'}
        </button>
      </div>

      {/* A real failure: the question is still open, so the same answer can go again. */}
      {error && (
        <p data-testid="respond-error" className="text-[12px] text-status-error ml-[18px]">
          {error.message}
          {error.credentialRevoked && ' Reconnect the credential, then retry.'}
          {!busy && (lastTried ? (
            <>
              {' '}
              <button type="button" onClick={() => handleSubmit(lastTried)} className="underline hover:no-underline">
                Retry
              </button>
            </>
          ) : ' Tap an answer to try again.')}
        </p>
      )}
    </div>
  );
}
