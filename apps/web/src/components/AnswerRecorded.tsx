import { answerOutcomeLines, type AnswerOutcome } from '@/app/app/(protected)/tasks/[id]/respond/submit-answer';

/**
 * A question collapsed into its answer: what was recorded and that the agent
 * is next. Shown the moment the server accepts the answer, and for a
 * duplicate tap too: a question that already had an answer is answered, not
 * an error.
 */
export default function AnswerRecorded({
  outcome,
  awaitingAgent = true,
  className = '',
}: {
  /** Null: the server says it was answered, but this view did not send it. */
  outcome: AnswerOutcome | null;
  /** The agent has not picked the answer up yet. */
  awaitingAgent?: boolean;
  className?: string;
}) {
  const lines = outcome ? answerOutcomeLines(outcome) : { headline: 'Question answered', detail: null };
  return (
    <div
      data-testid="answer-recorded"
      data-outcome={outcome?.kind ?? 'server'}
      data-differs={outcome?.kind === 'already_answered' && outcome.differs ? 'true' : undefined}
      role="status"
      className={`border-2 border-status-success px-3 py-2.5 ${className}`}
    >
      <p className="flex items-baseline gap-2 text-[13px] font-semibold text-text-primary [overflow-wrap:anywhere]">
        <span aria-hidden="true" className="text-status-success">✓</span>
        <span className="min-w-0">{lines.headline}</span>
      </p>
      {lines.detail && <p className="mt-1 pl-5 text-[12.5px] text-text-secondary [overflow-wrap:anywhere]">{lines.detail}</p>}
      {awaitingAgent && (
        <p className="mt-1 pl-5 font-mono text-[11.5px] text-text-muted">Answer sent, waiting for the agent</p>
      )}
    </div>
  );
}

/** The same, inside QuestionHero's `sent` slot (which draws the border). */
export function AnswerOutcomeText({ outcome, waitingFor = 'the agent', tail }: { outcome: AnswerOutcome; waitingFor?: string; tail?: string }) {
  const lines = answerOutcomeLines(outcome);
  return (
    <span data-testid="answer-recorded" data-outcome={outcome.kind}>
      <b className="font-semibold">{`✓ ${lines.headline}`}</b>
      {lines.detail && <span className="mt-1 block text-text-secondary">{lines.detail}</span>}
      <span className="mt-1 block">{`Answer sent, waiting for ${waitingFor}.${tail ? ` ${tail}` : ''}`}</span>
    </span>
  );
}
