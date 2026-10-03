'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import QuestionHero from '../QuestionHero';
import type { UnifiedQuestion } from '../question-hero';
import { respondRedirectHref } from './respond-links';
import type { AnswerOutcome } from './submit-answer';
import { AnswerOutcomeText } from '@/components/AnswerRecorded';
import { useAnswerSubmit } from './use-answer-submit';

interface Props {
  workerId: string;
  taskId: string;
  /** The task's mission: an answered mission task returns to its row there. */
  missionId?: string | null;
  question: UnifiedQuestion;
  askerLabel: string;
}

/**
 * The push-notification landing's answer surface — the same QuestionHero the
 * task page renders, so a question reads and answers identically on the phone.
 */
export default function RespondForm({ workerId, taskId, missionId, question, askerLabel }: Props) {
  const router = useRouter();
  const onAnswered = useCallback((o: AnswerOutcome) => {
    // A duplicate stays put: the person reads what was recorded first.
    if (o.kind !== 'sent') return;
    // On a resume this is the SAME task (the resumed worker continues under
    // it); on a cold continuation it is the new one. Either way it is where
    // the work now is. A task-less worker returns null — stay put rather than
    // navigating to a page that cannot exist. A mission task lands back on
    // its row in the mission (`#t-<task>`).
    const next = respondRedirectHref({ missionId, taskId: o.taskId });
    if (next) router.push(next);
    else router.refresh();
  }, [missionId, router]);
  const { submit, sending, outcome, error } = useAnswerSubmit({
    workerId,
    taskId,
    noteId: question.noteId,
    resetKey: workerId,
    onAnswered,
  });

  return (
    <QuestionHero
      testId="respond-question-hero"
      question={question}
      askerLabel={askerLabel}
      onAnswer={submit}
      sending={sending}
      error={error && <>{error.message}{error.credentialRevoked ? ' Reconnect the credential, then try again.' : ' Tap an answer to try again.'}</>}
      sent={outcome ? <AnswerOutcomeText outcome={outcome} /> : undefined}
      enableKeys
    />
  );
}
