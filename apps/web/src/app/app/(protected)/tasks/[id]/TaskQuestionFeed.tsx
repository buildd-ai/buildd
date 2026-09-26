'use client';

import { useState, useEffect, useCallback } from 'react';
import { subscribeToChannel, unsubscribeFromChannel, CHANNEL_PREFIX } from '@/lib/pusher-client';
import type { MissionNote } from '@buildd/shared';
import QuestionHero from './QuestionHero';
import { unifyNoteQuestion } from './question-hero';

interface Props {
  taskId: string;
  /** A mission task's feed lists mission-scoped questions, announced on the mission channel. */
  missionId?: string | null;
  activeWorkerId: string | null;
  activeWorkerStatus: string | null;
  /**
   * The open question already shown by the live worker view (the same ask as
   * the worker's `waitingFor`). Skipped here so one question has one surface.
   */
  excludeNoteId?: string | null;
  /** Role name of the task's agent ("Builder"), for "The builder asks". */
  roleName?: string | null;
}

function timeAgo(date: string | Date): string {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return `${Math.max(0, seconds)}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const LIVE_STATUSES = new Set(['running', 'starting']);

/** Channels the feed refetches on: the task's, plus its mission's for a mission task. */
export function questionFeedChannels(taskId: string, missionId: string | null | undefined, prefix: string): string[] {
  const names = [`${prefix}task-${taskId}`];
  if (missionId) names.push(`${prefix}mission-${missionId}`);
  return names;
}

/** Which notes this feed renders as open heroes and as answered history. */
export function partitionQuestionNotes<N extends Pick<MissionNote, 'id' | 'type' | 'status'>>(notes: N[], excludeNoteId: string | null | undefined) {
  const questions = notes.filter(n => n.type === 'question' && n.id !== excludeNoteId);
  return {
    open: questions.filter(n => n.status === 'open'),
    answered: questions.filter(n => n.status !== 'open'),
  };
}

export default function TaskQuestionFeed({ taskId, missionId = null, activeWorkerId, activeWorkerStatus, excludeNoteId = null, roleName = null }: Props) {
  const [notes, setNotes] = useState<MissionNote[]>([]);
  const [sending, setSending] = useState<{ noteId: string; answer: string } | null>(null);
  const [sentFor, setSentFor] = useState<Set<string>>(new Set());

  const fetchNotes = useCallback(async () => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/notes`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setNotes(data.notes);
      }
    } catch {
      // Non-fatal
    }
  }, [taskId]);

  useEffect(() => {
    fetchNotes();
  }, [fetchNotes]);

  useEffect(() => {
    const handler = () => fetchNotes();
    const bound = questionFeedChannels(taskId, missionId, CHANNEL_PREFIX).flatMap(name => {
      const channel = subscribeToChannel(name);
      if (!channel) return [];
      channel.bind('mission:note_posted', handler);
      return [{ name, channel }];
    });
    return () => {
      for (const { name, channel } of bound) {
        channel.unbind('mission:note_posted', handler);
        unsubscribeFromChannel(name);
      }
    };
  }, [taskId, missionId, fetchNotes]);

  const isLiveWorker = activeWorkerId && activeWorkerStatus && LIVE_STATUSES.has(activeWorkerStatus);

  const submitReply = async (noteId: string, replyTitle: string) => {
    if (sending) return;
    setSending({ noteId, answer: replyTitle });
    try {
      const res = await fetch(`/api/tasks/${taskId}/notes/${noteId}/reply`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: replyTitle }),
      });
      if (!res.ok) return;

      // Deliver urgently to live worker via send_agent_message
      if (isLiveWorker) {
        await fetch(`/api/workers/${activeWorkerId}/instruct`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: replyTitle, priority: 'urgent' }),
        });
      }

      setSentFor(prev => new Set([...prev, noteId]));
      await fetchNotes();
    } finally {
      setSending(null);
    }
  };

  const { open, answered } = partitionQuestionNotes(notes, excludeNoteId);
  const replyMap = new Map(notes.filter(n => n.replyTo).map(n => [n.replyTo!, n]));

  if (open.length === 0 && answered.length === 0) return null;
  const asker = `The ${(roleName || 'agent').toLowerCase()} asks`;

  return (
    <div className="mb-6 space-y-5" data-testid="task-question-feed">
      {open.map((note, i) => (
        <QuestionHero
          key={note.id}
          question={unifyNoteQuestion(note)}
          askerLabel={note.actorLabel ? `${note.actorLabel} asks` : asker}
          askedAgo={timeAgo(note.createdAt)}
          onAnswer={(answer) => submitReply(note.id, answer)}
          sending={sending?.noteId === note.id ? sending.answer : sending ? '' : null}
          sent={sentFor.has(note.id) ? 'Answer sent.' : null}
          // Number keys belong to the page's primary question; when the live
          // worker view already shows one, this feed does not take them.
          enableKeys={i === 0 && !excludeNoteId}
        />
      ))}

      {answered.length > 0 && (
        <details className="group" data-testid="task-answered-questions">
          <summary className="cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden flex items-center gap-2 min-h-11 border-b border-border-default font-mono text-[11px] uppercase tracking-[2px] text-text-muted hover:text-text-secondary">
            <span className="group-open:rotate-90 transition-transform" aria-hidden="true">▸</span>
            Answered · {answered.length}
          </summary>
          <div className="mt-3 border-2 border-border-strong bg-card">
            {answered.map(note => {
              const reply = replyMap.get(note.id);
              return (
                <div key={note.id} className="px-4 py-3 border-b border-border-default last:border-b-0">
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-[11px] uppercase tracking-[1.5px] text-text-muted">Q</span>
                    <p className="flex-1 min-w-0 text-[13px] text-text-secondary [overflow-wrap:anywhere]">{note.title}</p>
                    <span className="font-mono text-[11px] text-text-muted tabular-nums shrink-0">{timeAgo(note.createdAt)}</span>
                  </div>
                  {reply && (
                    <div className="mt-1.5 flex items-baseline gap-2">
                      <span className="font-mono text-[11px] uppercase tracking-[1.5px] text-accent-text">A</span>
                      <p className="flex-1 min-w-0 text-[13px] text-text-primary [overflow-wrap:anywhere]">{reply.body || reply.title}</p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </details>
      )}
    </div>
  );
}
