'use client';

/**
 * The visual audit's ask (docs/design/visual-qa-human-review.md, part 3):
 * a card that sits next to the mission's other asks while the audit needs
 * you. Null in every other phase.
 *
 * - `question`: the auditor's worker waits on a question. The prompt shows
 *   with answer buttons and a free-text reply; the answer goes out through
 *   `onAnswer`, so the component never knows the route.
 * - `unsure`: screens the agent could not judge. "Review N" opens the deck.
 * - `round_cap`: issues remain after the automatic rounds. Your call.
 */
import { useState } from 'react';
import type { VisualReviewModel } from '@buildd/shared';
import { describeVisualPhase, screensToReview } from '@/lib/visual-review-model';
import { BTN_BASE, BTN_PRIMARY, BTN_SECONDARY, BTN_SIZE } from './review-ui';

export type AnswerTarget = { workerId: string; taskId: string };
export type OnAnswer = (answer: string, target: AnswerTarget) => void | Promise<void>;

/** Answer buttons plus a free-text reply, for a parked worker's question. */
export function AnswerRow({ target, options = [], onAnswer }: { target: AnswerTarget; options?: readonly string[]; onAnswer: OnAnswer }) {
  const [sending, setSending] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replying, setReplying] = useState(options.length === 0);
  const [text, setText] = useState('');

  async function send(answer: string) {
    const a = answer.trim();
    if (!a || sending) return;
    setSending(a);
    setError(null);
    try {
      await onAnswer(a, target);
      setSent(true);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'The answer did not send. Try again.');
    } finally {
      setSending(null);
    }
  }

  if (sent) {
    return <p data-testid="visual-review-answer-sent" className="font-mono text-[13px] text-status-success">Answer sent. The audit picks up from here.</p>;
  }
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {options.map((o, i) => (
          <button
            key={o}
            type="button"
            data-testid="visual-review-answer-option"
            disabled={sending !== null}
            onClick={() => void send(o)}
            className={`${BTN_BASE} ${BTN_SIZE} ${i === 0 ? BTN_PRIMARY : BTN_SECONDARY}`}
          >
            {sending === o ? 'Sending…' : o}
          </button>
        ))}
        {!replying && (
          <button type="button" data-testid="visual-review-reply" onClick={() => setReplying(true)} className={`${BTN_BASE} ${BTN_SIZE} ${BTN_SECONDARY}`}>
            Reply
          </button>
        )}
      </div>
      {replying && (
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void send(text); }}>
          <input
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder="Your answer"
            aria-label="Your answer"
            className="min-h-10 min-w-0 flex-1 border-2 border-border-default bg-surface-1 px-2.5 font-mono text-base text-text-primary placeholder:text-text-muted focus:border-primary focus:outline-none md:text-[13px]"
          />
          <button type="submit" disabled={!text.trim() || sending !== null} className={`${BTN_BASE} ${BTN_SIZE} ${BTN_SECONDARY}`}>
            {sending && sending === text.trim() ? 'Sending…' : 'Send'}
          </button>
        </form>
      )}
      {error && <p role="alert" className="font-mono text-[12px] text-status-error">{error}</p>}
    </div>
  );
}

export interface VisualReviewAskProps {
  model: VisualReviewModel;
  /** Opens the deck; `startKey` is the first cell of the queue. */
  onReview?: (startKey: string | null) => void;
  onAnswer?: OnAnswer;
  /** The parked worker's answer options, when the caller has them. */
  answerOptions?: readonly string[];
  className?: string;
}

export default function VisualReviewAsk({ model, onReview, onAnswer, answerOptions, className = '' }: VisualReviewAskProps) {
  if (model.phase !== 'needs_you') return null;
  const reason = model.needsYou?.reason ?? (model.summary.awaitingHuman > 0 ? 'unsure' : 'round_cap');
  const copy = describeVisualPhase(model);
  const n = screensToReview(model);
  const target = model.needsYou?.workerId && model.needsYou?.taskId
    ? { workerId: model.needsYou.workerId, taskId: model.needsYou.taskId }
    : null;
  const heading = reason === 'question' ? 'The visual audit asks' : reason === 'unsure' ? 'Screens to check' : 'Visual issues: decision needed';

  return (
    <section
      data-testid="visual-review-ask"
      data-reason={reason}
      aria-label="Visual review needs you"
      className={`border-2 border-l-[6px] border-border-strong border-l-accent bg-card p-4 shadow-[var(--card-shadow)] ${className}`}
    >
      <p className="section-label mb-1.5">{heading}</p>
      {reason === 'question' ? (
        <>
          <p className="mb-3 text-[15px] leading-[1.45] text-text-primary">{model.needsYou?.prompt ?? copy.detail}</p>
          {target && onAnswer ? <AnswerRow target={target} options={answerOptions} onAnswer={onAnswer} /> : null}
        </>
      ) : (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[14px] leading-[1.45] text-text-primary">{copy.detail}</p>
          {onReview && (
            <button
              type="button"
              data-testid="visual-review-ask-review"
              onClick={() => onReview(model.queue[0] ?? null)}
              className={`${BTN_BASE} ${BTN_SIZE} ${BTN_PRIMARY} shrink-0`}
            >
              {reason === 'unsure' && n > 0 ? `Review ${n}` : 'Review the screens'}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
