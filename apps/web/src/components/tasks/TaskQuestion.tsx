'use client';

/**
 * TaskQuestion: a waiting agent's question, answered in place. The one answer
 * card for a task's open question: the task page (`full`), and the mission
 * task sheet, the Board and the timeline (`compact`) all mount it, so the same
 * ask reads the same everywhere and answers the same way.
 *
 * It folds the worker's `waitingFor` and the question note recording the same
 * ask (the post_note path) into one question (`unifyWorkerQuestion`): the note
 * gives the headline and the recommended choice, and an answer marks the note
 * answered too. Submission is `useAnswerSubmit`: one answer in flight, the
 * tapped option pending, the outcome held the moment the server accepts it.
 * A host whose answer must outlive the card (the refetch after an answer
 * drops the question) owns the submission and passes it as `answer`.
 */
import type { ReactNode } from 'react';
import QuestionHero from '@/app/app/(protected)/tasks/[id]/QuestionHero';
import { unifyWorkerQuestion, type BriefedWaitingFor, type QuestionNoteLike } from '@/app/app/(protected)/tasks/[id]/question-hero';
import { answerOutcomeLines, type AnswerOutcome } from '@/app/app/(protected)/tasks/[id]/respond/submit-answer';
import { useAnswerSubmit, type AnswerSubmitFailure, type AnswerSubmitState } from '@/app/app/(protected)/tasks/[id]/respond/use-answer-submit';
import DecisionCard from '@/components/DecisionCard';
import { decisionFromQuestion } from '@/lib/needs-you-card';
import { useQuestionWaits } from '@/components/use-question-waits';
import type { QuestionWaits } from '@buildd/core/question-waits';

export interface TaskQuestionProps {
  taskId: string;
  /** The waiting worker: answers go to its `/respond`. */
  workerId: string | null;
  waitingFor: BriefedWaitingFor;
  /** The open question note recording the same ask, if any (`linkQuestionNote`). */
  questionNote?: QuestionNoteLike | null;
  /** The worker's own report beside the question: the context when the brief has none. */
  workerError?: string | null;
  /** The asking role ("Builder" or its slug): "The builder asks". */
  role?: string | null;
  /** `full`: the task page's hero. `compact`: the same card at card size. */
  variant?: 'full' | 'compact';
  /** Short age, e.g. "7s ago". */
  askedAgo?: string | null;
  /** When it was asked, epoch ms: the full variant's decision card ticks its own age from it. */
  askedAt?: number | null;
  /** Extra eyebrow clause, e.g. "paused". */
  stateNote?: string | null;
  /** Extra eyebrow content on the right (the task's scope). */
  aside?: ReactNode;
  /** Number keys answer: only the page's primary question takes them. */
  enableKeys?: boolean;
  /** Scroll into view once on first render (the task page). */
  landOnArrival?: boolean;
  testId?: string;
  /** A submission the host owns. Omitted, the card owns one. */
  answer?: AnswerSubmitState;
  /** After an answer the card owns is recorded (a refetch, a refresh). */
  onAnswered?: (outcome: AnswerOutcome) => void | Promise<void>;
  /** What waits on the answer, when a server read already has it; else the card reads the projection. */
  waits?: QuestionWaits | null;
}

/** "builder" → "the Builder": who the answer went to. */
function recipient(role: string | null | undefined): string {
  const r = role?.trim();
  return r ? `the ${r.charAt(0).toUpperCase()}${r.slice(1)}` : 'the agent';
}

export default function TaskQuestion({
  taskId,
  workerId,
  waitingFor,
  questionNote = null,
  workerError = null,
  role = null,
  variant = 'compact',
  askedAgo,
  askedAt,
  stateNote,
  aside,
  enableKeys = false,
  landOnArrival = false,
  testId,
  answer: hosted,
  onAnswered,
  waits: knownWaits,
}: TaskQuestionProps) {
  const question = unifyWorkerQuestion(waitingFor, questionNote, { workerError });
  const waits = useQuestionWaits(taskId, waitingFor.prompt, knownWaits);
  const own = useAnswerSubmit({
    workerId,
    taskId,
    noteId: question.noteId,
    resetKey: `${workerId ?? ''}:${waitingFor.prompt}`,
    onAnswered,
  });
  const { submit, sending, outcome, error } = hosted ?? own;

  // The task page's question is the one decision card (Navigation R-16); the hosted
  // submission keeps its collapsed answer on screen through the refetch that drops the question.
  if (variant === 'full') {
    const view = decisionFromQuestion({
      key: `question:${taskId}`,
      question,
      task: null,
      askedAt: askedAt ?? null,
      waits,
      answer: { kind: 'worker', workerId: workerId ?? '', taskId, noteId: question.noteId },
    });
    return <DecisionCard view={view} now={Date.now()} submission={{ submit, sending, outcome, error }} testId={testId} />;
  }

  return (
    <QuestionHero
      testId={testId}
      density="feed"
      question={question}
      askerLabel={`The ${(role || 'agent').toLowerCase()} asks`}
      askedAgo={askedAgo}
      stateNote={stateNote}
      aside={aside}
      enableKeys={enableKeys}
      landOnArrival={landOnArrival}
      waits={waits}
      onAnswer={(text) => { void submit(text, { noteId: question.noteId }); }}
      sending={sending}
      error={error && <AnswerFailure error={error} />}
      sent={outcome ? <AnswerSent outcome={outcome} to={recipient(role)} /> : null}
    />
  );
}

function AnswerFailure({ error }: { error: AnswerSubmitFailure }) {
  // The agent stopped waiting after the card rendered: retrying cannot help.
  if (error.stale) {
    return (
      <>
        {error.stale.message}
        {error.stale.href && (
          <>{' '}<a href={error.stale.href} className="underline hover:no-underline">{error.stale.linkLabel} →</a></>
        )}
      </>
    );
  }
  return <>{error.message}{error.credentialRevoked ? ' Reconnect the credential, then try again.' : ' Tap an answer to try again.'}</>;
}

/** What was recorded, what the server did with it, and the follow-up task when it started one. */
function AnswerSent({ outcome, to }: { outcome: AnswerOutcome; to: string }) {
  const lines = answerOutcomeLines(outcome);
  // The path is the server's decision: its sentence, never one invented here.
  const said = outcome.kind === 'sent' && outcome.message ? outcome.message : `Answer sent, waiting for ${to}.`;
  const followUp = outcome.kind === 'sent'
    ? (outcome.path === 'cold_continuation' ? outcome.taskId : null)
    : outcome.followUpTaskId ?? null;
  return (
    <span data-testid="answer-recorded" data-outcome={outcome.kind}>
      <b className="font-semibold">{`✓ ${lines.headline}`}</b>
      {lines.detail && <span className="mt-1 block text-text-secondary">{lines.detail}</span>}
      <span className="mt-1 block">
        {said}
        {followUp && (
          <>{' '}<a href={`/app/tasks/${followUp}`} className="underline hover:no-underline">Open the follow-up task →</a></>
        )}
      </span>
    </span>
  );
}
