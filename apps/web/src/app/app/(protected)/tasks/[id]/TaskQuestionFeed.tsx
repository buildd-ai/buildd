'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { subscribeToChannel, unsubscribeFromChannel, CHANNEL_PREFIX } from '@/lib/pusher-client';
import type { MissionNote } from '@buildd/shared';

interface Props {
  taskId: string;
  activeWorkerId: string | null;
  activeWorkerStatus: string | null;
}

function timeAgo(date: string | Date): string {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const LIVE_STATUSES = new Set(['running', 'starting']);

export default function TaskQuestionFeed({ taskId, activeWorkerId, activeWorkerStatus }: Props) {
  const [notes, setNotes] = useState<MissionNote[]>([]);
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);
  const [sentFor, setSentFor] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLTextAreaElement>(null);

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
    const channelName = `${CHANNEL_PREFIX}task-${taskId}`;
    const channel = subscribeToChannel(channelName);
    if (!channel) return;
    const handler = () => fetchNotes();
    channel.bind('mission:note_posted', handler);
    return () => {
      channel.unbind('mission:note_posted', handler);
      unsubscribeFromChannel(channelName);
    };
  }, [taskId, fetchNotes]);

  useEffect(() => {
    if (replyingTo) inputRef.current?.focus();
  }, [replyingTo]);

  const isLiveWorker = activeWorkerId && activeWorkerStatus && LIVE_STATUSES.has(activeWorkerStatus);

  const submitReply = async (noteId: string, replyTitle: string) => {
    if (sending) return;
    setSending(true);
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
      setReplyingTo(null);
      setReplyText('');
      await fetchNotes();
    } finally {
      setSending(false);
    }
  };

  const handleReply = (noteId: string) => submitReply(noteId, replyText);
  const handleDefault = (noteId: string, defaultChoice: string) => submitReply(noteId, defaultChoice);

  const openQuestions = notes.filter(n => n.type === 'question' && n.status === 'open');
  const answeredQuestions = notes.filter(n => n.type === 'question' && n.status !== 'open');
  const replyMap = new Map(
    notes.filter(n => n.replyTo).map(n => [n.replyTo!, n])
  );

  if (notes.length === 0) return null;

  return (
    <div className="mb-6">
      {/* Waiting on you banner */}
      {openQuestions.length > 0 && (
        <div className="flex items-center gap-2 px-4 py-3 mb-4 bg-[#D97706]/10 border border-[#D97706]/25 rounded-[10px]">
          <svg className="w-4 h-4 text-[#D97706] shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="text-[13px] font-medium text-[#D97706]">
            Waiting on you — {openQuestions.length === 1 ? 'the agent has a question' : `${openQuestions.length} agent questions need answers`}
          </span>
        </div>
      )}

      <div className="font-mono text-[10px] uppercase tracking-[2.5px] text-text-muted pb-2 border-b border-border-default mb-4">
        Agent Questions
      </div>

      <div className="space-y-3">
        {/* Open questions with reply UI */}
        {openQuestions.map(note => {
          const isReplying = replyingTo === note.id;
          const wasSent = sentFor.has(note.id);

          return (
            <div key={note.id} className="rounded-[10px] border border-[#D97706]/30 bg-[#D97706]/[0.04] overflow-hidden">
              <div className="px-4 py-3">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-[9px] font-bold tracking-wider text-[#D97706] uppercase">Question</span>
                  <span className="flex-1" />
                  <span className="text-[11px] text-text-muted tabular-nums">{timeAgo(note.createdAt)}</span>
                </div>
                <p className="text-[14px] font-medium text-text-primary leading-snug">{note.title}</p>
                {note.body && (
                  <p className="text-[12px] text-text-secondary mt-1 leading-relaxed">{note.body}</p>
                )}
              </div>

              {!wasSent && (
                <div className="px-4 pb-4 space-y-2.5">
                  {/* Default choice chip */}
                  {note.defaultChoice && !isReplying && (
                    <button
                      onClick={() => handleDefault(note.id, note.defaultChoice!)}
                      disabled={sending}
                      className="w-full text-left px-3.5 py-2.5 rounded-[8px] border border-[#D97706]/30 bg-[#D97706]/10 text-[13px] text-[#D97706] font-medium hover:bg-[#D97706]/20 transition-colors disabled:opacity-50 active:scale-[0.98]"
                    >
                      Proceed with default: {note.defaultChoice}
                    </button>
                  )}

                  {isReplying ? (
                    <div className="space-y-2">
                      <textarea
                        ref={inputRef}
                        value={replyText}
                        onChange={e => setReplyText(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter' && !e.shiftKey && replyText.trim()) {
                            e.preventDefault();
                            handleReply(note.id);
                          }
                        }}
                        placeholder="Type your answer..."
                        rows={2}
                        className="w-full px-3 py-2.5 rounded-[8px] bg-surface-2 border border-border-default text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-text/40 resize-none"
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleReply(note.id)}
                          disabled={!replyText.trim() || sending}
                          className="flex-1 py-2.5 rounded-[8px] bg-accent-text text-white text-[13px] font-semibold hover:opacity-90 transition-opacity disabled:opacity-40 active:scale-[0.98]"
                        >
                          {sending ? 'Sending…' : 'Send Answer'}
                        </button>
                        <button
                          onClick={() => { setReplyingTo(null); setReplyText(''); }}
                          className="px-4 py-2.5 rounded-[8px] bg-surface-3 text-text-secondary text-[13px] hover:bg-surface-2 transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => { setReplyingTo(note.id); setReplyText(''); }}
                      className="w-full py-2.5 rounded-[8px] bg-accent-text/10 text-accent-text text-[13px] font-medium hover:bg-accent-text/20 transition-colors active:scale-[0.98]"
                    >
                      Reply
                    </button>
                  )}
                </div>
              )}

              {wasSent && (
                <div className="px-4 pb-3 flex items-center gap-1.5 text-[12px] text-status-success">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  Answer sent
                </div>
              )}
            </div>
          );
        })}

        {/* Answered questions with reply pairs */}
        {answeredQuestions.map(note => {
          const reply = replyMap.get(note.id);
          return (
            <div key={note.id} className="rounded-[10px] border border-border-default overflow-hidden">
              <div className="px-4 py-3 bg-surface-2">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[9px] font-bold tracking-wider text-[#D97706]/60 uppercase">Question</span>
                  <svg className="w-3 h-3 text-status-success shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  <span className="text-[11px] text-text-muted tabular-nums">{timeAgo(note.createdAt)}</span>
                </div>
                <p className="text-[13px] text-text-secondary">{note.title}</p>
              </div>
              {reply && (
                <div className="px-4 py-3 border-t border-border-default/50">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-[9px] font-bold tracking-wider text-accent-text uppercase">Your Answer</span>
                    <span className="flex-1" />
                    <span className="text-[11px] text-text-muted tabular-nums">{timeAgo(reply.createdAt)}</span>
                  </div>
                  <p className="text-[13px] text-text-primary">{reply.title}</p>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
