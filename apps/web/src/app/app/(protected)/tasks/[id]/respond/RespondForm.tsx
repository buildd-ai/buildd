'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import QuestionHero from '../QuestionHero';
import type { UnifiedQuestion } from '../question-hero';
import { respondRedirectHref } from './respond-links';
import { submitAnswer } from './submit-answer';

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
  const [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(message: string) {
    if (!message.trim()) return;
    setSending(message);
    setError(null);
    try {
      const data = await submitAnswer({ workerId, taskId, noteId: question.noteId, message });
      // On a resume this is the SAME task (the resumed worker continues under
      // it); on a cold continuation it is the new one. Either way it is where
      // the work now is. A task-less worker returns null — stay put rather than
      // navigating to a page that cannot exist. A mission task lands back on
      // its row in the mission (`#t-<task>`).
      const next = respondRedirectHref({ missionId, taskId: data.taskId });
      if (next) router.push(next);
      else router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send answer');
      setSending(null);
    }
  }

  return (
    <QuestionHero
      testId="respond-question-hero"
      question={question}
      askerLabel={askerLabel}
      onAnswer={submit}
      sending={sending}
      error={error}
      enableKeys
    />
  );
}
