'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { subscribeToChannel, unsubscribeFromChannel, CHANNEL_PREFIX } from '@/lib/pusher-client';
import AiFeedback from '@/components/AiFeedback';
import type { MissionNote, MissionNoteType } from '@buildd/shared';

const TYPE_STYLES: Record<MissionNoteType, { label: string; color: string; bg: string; icon: string }> = {
  decision: { label: 'DECISION', color: 'text-status-success', bg: 'bg-status-success/10', icon: 'M9 12.75L11.25 15 15 9.75' },
  question: { label: 'QUESTION', color: 'text-[#D97706]', bg: 'bg-[#D97706]/10', icon: 'M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M12 18h.01' },
  warning: { label: 'WARNING', color: 'text-status-error', bg: 'bg-status-error/10', icon: 'M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z' },
  suggestion: { label: 'SUGGESTION', color: 'text-[#B39DDB]', bg: 'bg-[#B39DDB]/10', icon: 'M12 18v-5.25m0 0a6.01 6.01 0 001.5-.189m-1.5.189a6.01 6.01 0 01-1.5-.189m3.75 7.478a12.06 12.06 0 01-4.5 0m3.75 2.383a14.406 14.406 0 01-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 10-7.517 0c.85.493 1.509 1.333 1.509 2.316V18' },
  update: { label: 'UPDATE', color: 'text-status-info', bg: 'bg-status-info/10', icon: 'M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182' },
  reply: { label: 'REPLY', color: 'text-accent-text', bg: 'bg-accent-text/10', icon: 'M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3' },
  guidance: { label: 'GUIDANCE', color: 'text-accent-text', bg: 'bg-accent-text/10', icon: 'M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z' },
};

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

export default function MissionFeed({ missionId }: { missionId: string }) {
  const [notes, setNotes] = useState<MissionNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [guidanceText, setGuidanceText] = useState('');
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const fetchNotes = useCallback(async () => {
    try {
      const res = await fetch(`/api/missions/${missionId}/notes?limit=50`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setNotes(data.notes);
      }
    } catch {
      // Non-fatal
    } finally {
      setLoading(false);
    }
  }, [missionId]);

  useEffect(() => {
    fetchNotes();
  }, [fetchNotes]);

  // Real-time updates via Pusher
  useEffect(() => {
    const channelName = `${CHANNEL_PREFIX}mission-${missionId}`;
    const channel = subscribeToChannel(channelName);
    if (!channel) return;

    const handleNote = () => fetchNotes();
    channel.bind('mission:note_posted', handleNote);

    return () => {
      channel.unbind('mission:note_posted', handleNote);
      unsubscribeFromChannel(channelName);
    };
  }, [missionId, fetchNotes]);

  const postGuidance = async () => {
    if (!guidanceText.trim() || sending) return;
    setSending(true);
    try {
      const res = await fetch(`/api/missions/${missionId}/notes`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'guidance', title: guidanceText.trim(), authorType: 'user' }),
      });
      if (res.ok) {
        setGuidanceText('');
        await fetchNotes();
      }
    } finally {
      setSending(false);
    }
  };

  const postReply = async (noteId: string) => {
    if (!replyText.trim() || sending) return;
    setSending(true);
    try {
      const res = await fetch(`/api/missions/${missionId}/notes/${noteId}/reply`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'reply', title: replyText.trim() }),
      });
      if (res.ok) {
        setReplyText('');
        setReplyingTo(null);
        await fetchNotes();
      }
    } finally {
      setSending(false);
    }
  };

  const skipQuestion = async (noteId: string, defaultChoice: string | null) => {
    setSending(true);
    try {
      const res = await fetch(`/api/missions/${missionId}/notes/${noteId}/reply`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'reply', title: defaultChoice || 'Accepted agent default' }),
      });
      if (res.ok) await fetchNotes();
    } finally {
      setSending(false);
    }
  };

  // Focus reply input when opened
  useEffect(() => {
    if (replyingTo) inputRef.current?.focus();
  }, [replyingTo]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-text-muted text-[13px]">
        Loading feed...
      </div>
    );
  }

  return (
    <div>
      {/* Guidance input */}
      <div className="flex items-center gap-2 mb-4">
        <input
          type="text"
          value={guidanceText}
          onChange={(e) => setGuidanceText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && postGuidance()}
          placeholder="Send guidance to all agents..."
          className="flex-1 px-3 py-2 rounded-lg bg-surface-2 border border-border-default text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-text/40"
        />
        {guidanceText.trim() && (
          <button
            onClick={postGuidance}
            disabled={sending}
            className="px-3 py-2 rounded-lg bg-accent-text/10 text-accent-text text-[13px] font-medium hover:bg-accent-text/20 transition-colors disabled:opacity-50"
          >
            Send
          </button>
        )}
      </div>

      {/* Notes feed */}
      {notes.length === 0 ? (
        <div className="text-center py-12">
          <svg className="w-8 h-8 mx-auto mb-3 text-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
          </svg>
          <p className="text-[13px] text-text-secondary">No feed activity yet</p>
          <p className="text-[12px] text-text-muted mt-1">Agent decisions, questions, and updates will appear here</p>
        </div>
      ) : (
        <div className="space-y-0">
          {notes.map((note) => {
            const style = TYPE_STYLES[note.type] || TYPE_STYLES.update;
            const isOpenQuestion = note.type === 'question' && note.status === 'open';

            return (
              <div key={note.id} className={`flex gap-3 px-3 py-3 border-b border-border-default/50 ${isOpenQuestion ? 'bg-[#D97706]/[0.03]' : ''}`}>
                {/* Type icon */}
                <div className={`w-7 h-7 rounded-full ${style.bg} flex items-center justify-center shrink-0 mt-0.5`}>
                  <svg className={`w-3.5 h-3.5 ${style.color}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d={style.icon} />
                  </svg>
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] text-text-secondary">
                      {note.authorType === 'agent' ? 'Agent' : note.authorType === 'system' ? 'System' : 'You'}
                    </span>
                    <span className={`text-[9px] font-bold tracking-wider ${style.color}`}>
                      {style.label}
                    </span>
                    <span className="flex-1" />
                    <span className="text-[11px] text-text-muted tabular-nums">
                      {timeAgo(note.createdAt)}
                    </span>
                  </div>

                  <p className="text-[13px] text-text-primary mt-0.5">{note.title}</p>

                  {note.body && (
                    <p className="text-[12px] text-text-secondary mt-1 leading-relaxed line-clamp-3">{note.body}</p>
                  )}

                  {/* Feedback for agent-authored notes */}
                  {note.authorType === 'agent' && (
                    <div className="mt-1.5">
                      <AiFeedback
                        entityType="note"
                        entityId={note.id}
                        showDismiss
                        compact
                      />
                    </div>
                  )}

                  {/* Default choice hint for open questions */}
                  {isOpenQuestion && note.defaultChoice && (
                    <p className="text-[11px] text-text-muted mt-1">
                      Default: {note.defaultChoice}
                    </p>
                  )}

                  {/* Reply / Skip actions for open questions */}
                  {isOpenQuestion && replyingTo !== note.id && (
                    <div className="flex items-center gap-2 mt-2">
                      <button
                        onClick={() => { setReplyingTo(note.id); setReplyText(''); }}
                        className="text-[12px] font-medium text-accent-text bg-accent-text/10 px-2.5 py-1 rounded-md hover:bg-accent-text/20 transition-colors"
                      >
                        Reply
                      </button>
                      <button
                        onClick={() => skipQuestion(note.id, note.defaultChoice)}
                        disabled={sending}
                        className="text-[12px] text-text-muted bg-surface-2 px-2.5 py-1 rounded-md hover:bg-surface-3 transition-colors disabled:opacity-50"
                      >
                        Skip
                      </button>
                    </div>
                  )}

                  {/* Inline reply input */}
                  {replyingTo === note.id && (
                    <div className="flex items-center gap-2 mt-2">
                      <input
                        ref={inputRef}
                        type="text"
                        value={replyText}
                        onChange={(e) => setReplyText(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && postReply(note.id)}
                        placeholder="Your reply..."
                        className="flex-1 px-2.5 py-1.5 rounded-md bg-surface-2 border border-border-default text-[12px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-text/40"
                      />
                      <button
                        onClick={() => postReply(note.id)}
                        disabled={!replyText.trim() || sending}
                        className="text-[12px] font-medium text-accent-text px-2.5 py-1.5 rounded-md hover:bg-accent-text/10 transition-colors disabled:opacity-50"
                      >
                        Send
                      </button>
                      <button
                        onClick={() => { setReplyingTo(null); setReplyText(''); }}
                        className="text-[12px] text-text-muted px-1.5 py-1.5 rounded-md hover:bg-surface-2 transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
