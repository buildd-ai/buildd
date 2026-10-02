'use client';

/**
 * A waiting agent's question as an object in the feed. It is the respond
 * page's QuestionHero (feed density) posting to the same respond route:
 * tapping an option IS the approval, there is no second confirm.
 */
import Link from 'next/link';
import { useCallback } from 'react';
import QuestionHero from '@/app/app/(protected)/tasks/[id]/QuestionHero';
import { formatAge } from '@/lib/mission-board';
import { taskPageHref } from '@/lib/mission-task-href';
import type { BuilddObjectRef } from '../chat-contract';
import { useChatActions } from '../ChatActions';
import { useObjectStore } from './ObjectStoreProvider';
import type { QuestionObjectView } from './object-views';
import { useHideNeedsInputWhileOpen } from '@/lib/needs-input-hidden';
import { useAnswerSubmit } from '@/app/app/(protected)/tasks/[id]/respond/use-answer-submit';
import type { AnswerOutcome, SubmitAnswerInput } from '@/app/app/(protected)/tasks/[id]/respond/submit-answer';
import { AnswerOutcomeText } from '@/components/AnswerRecorded';

/** "The builder asks" → "The Builder": who the answer went to. */
export function askerName(askerLabel: string): string {
  const m = /^the\s+(.+?)\s+asks$/i.exec(askerLabel.trim());
  const who = m ? m[1] : 'agent';
  return `the ${who.charAt(0).toUpperCase()}${who.slice(1)}`;
}

export function QuestionCard({ objRef, view, variant = 'card' }: { objRef: BuilddObjectRef; view: QuestionObjectView; variant?: 'card' | 'pane' }) {
  const actions = useChatActions();
  const store = useObjectStore();
  const send = useCallback(async (input: SubmitAnswerInput): Promise<AnswerOutcome> => {
    const result = await actions.answerQuestion({ workerId: input.workerId, taskId: view.taskId, noteId: input.noteId ?? null, message: input.message });
    // A fixture's answerQuestion resolves with nothing: it sent.
    return result ?? { kind: 'sent', answer: input.message, taskId: null, path: null, message: null };
  }, [actions, view.taskId]);
  const onAnswered = useCallback((o: AnswerOutcome) => {
    // Optimistic: the card reads answered right away; the refetch confirms it.
    const recorded = o.kind === 'already_answered' ? o.recordedAnswer : o.answer;
    store.set(objRef, { ...view, open: false, answer: recorded ?? view.answer, awaitingAgent: true });
    store.refresh(objRef);
  }, [store, objRef, view]);
  // Held until the question is another worker's: the answer itself does not change that.
  const { submit, sending, outcome, error } = useAnswerSubmit({
    workerId: view.workerId,
    taskId: view.taskId,
    noteId: view.question.noteId,
    resetKey: view.workerId ?? '',
    onAnswered,
    send,
  });
  // Open in the sheet or the docked pane, this card IS the answer surface: the
  // layout's "…needs your input" banner stands down for this question.
  useHideNeedsInputWhileOpen(variant === 'pane' && view.open && !outcome ? view.taskId : null);
  const ago = view.askedAt ? formatAge(Math.max(0, view.renderedAt - view.askedAt)) : null;
  const aside = [view.scope, ago].filter(Boolean).join(' · ');

  const finalAnswer = view.answer ?? null;
  if (!view.open && !outcome) {
    return (
      <article data-testid="object-card" data-kind="question" data-state="answered" className="border-2 border-border-default bg-card px-4 py-3">
        <div className="flex items-center gap-2 font-mono text-[11px] font-bold uppercase tracking-[2px] text-text-muted">
          <span className="text-status-success">✓</span>
          {`${view.askerLabel} · answered`}
          {view.scope && <span className="ml-auto normal-case tracking-[1px] font-normal">{view.scope}</span>}
        </div>
        <p className="mt-1.5 font-mono text-[14px] font-semibold text-text-primary [overflow-wrap:anywhere]">{view.question.headline}</p>
        {finalAnswer && <p className="mt-1 font-mono text-[12.5px] text-text-secondary [overflow-wrap:anywhere]">{`Answer: ${finalAnswer}`}</p>}
        <Link href={taskPageHref({ taskId: view.taskId, missionId: view.missionId })} className="mt-2 inline-block font-mono text-[11.5px] text-accent-text hover:underline">
          Open task →
        </Link>
      </article>
    );
  }

  return (
    <div data-testid="object-card" data-kind="question" data-state={outcome ? 'sent' : 'open'} data-outcome={outcome?.kind} data-variant={variant}>
      <QuestionHero
        testId="chat-question-card"
        density="feed"
        question={view.question}
        askerLabel={view.askerLabel}
        aside={aside || null}
        onAnswer={submit}
        sending={sending}
        error={error && <>{error.message}{error.credentialRevoked ? ' Reconnect the credential, then try again.' : ' Tap an answer to try again.'}</>}
        sent={outcome ? <AnswerOutcomeText outcome={outcome} waitingFor={askerName(view.askerLabel)} tail="It picks up where it stopped." /> : undefined}
      />
    </div>
  );
}
