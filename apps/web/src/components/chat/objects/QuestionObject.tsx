'use client';

/**
 * A waiting agent's question as an object in the feed. It is the respond
 * page's QuestionHero (feed density) posting to the same respond route:
 * tapping an option IS the approval, there is no second confirm.
 */
import Link from 'next/link';
import { useState } from 'react';
import QuestionHero from '@/app/app/(protected)/tasks/[id]/QuestionHero';
import { formatAge } from '@/lib/mission-board';
import { taskPageHref } from '@/lib/mission-task-href';
import type { BuilddObjectRef } from '../chat-contract';
import { useChatActions } from '../ChatActions';
import { useObjectStore } from './ObjectStoreProvider';
import type { QuestionObjectView } from './object-views';

/** "The builder asks" → "The Builder": who the answer went to. */
export function askerName(askerLabel: string): string {
  const m = /^the\s+(.+?)\s+asks$/i.exec(askerLabel.trim());
  const who = m ? m[1] : 'agent';
  return `the ${who.charAt(0).toUpperCase()}${who.slice(1)}`;
}

export function QuestionCard({ objRef, view, variant = 'card' }: { objRef: BuilddObjectRef; view: QuestionObjectView; variant?: 'card' | 'pane' }) {
  const actions = useChatActions();
  const store = useObjectStore();
  const [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answered, setAnswered] = useState<string | null>(null);
  const ago = view.askedAt ? formatAge(Math.max(0, view.renderedAt - view.askedAt)) : null;
  const aside = [view.scope, ago].filter(Boolean).join(' · ');

  async function answer(message: string) {
    if (!view.workerId || !message.trim()) return;
    setSending(message);
    setError(null);
    try {
      await actions.answerQuestion({ workerId: view.workerId, taskId: view.taskId, noteId: view.question.noteId, message });
      setAnswered(message);
      // Optimistic: the card reads answered right away; the refetch confirms it.
      store.set(objRef, { ...view, open: false, answer: message });
      store.refresh(objRef);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to send answer');
    } finally {
      setSending(null);
    }
  }

  const finalAnswer = answered ?? view.answer ?? null;
  if (!view.open && !answered) {
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
    <div data-testid="object-card" data-kind="question" data-state={answered ? 'sent' : 'open'} data-variant={variant}>
      <QuestionHero
        testId="chat-question-card"
        density="feed"
        question={view.question}
        askerLabel={view.askerLabel}
        aside={aside || null}
        onAnswer={answer}
        sending={sending}
        error={error}
        sent={answered ? (
          <span>
            <b className="font-semibold">{`✓ ${answered}`}</b>
            {` · sent to ${askerName(view.askerLabel)}. It picks up where it stopped.`}
          </span>
        ) : undefined}
      />
    </div>
  );
}
