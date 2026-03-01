'use client';

import { useState, useEffect, useCallback } from 'react';

interface SessionSummary {
  sessionId: string;
  cwd: string;
  startedAt: number;
  durationMs: number;
  numTurns: number;
  model?: string;
}

interface SessionMessage {
  role: 'user' | 'assistant';
  content: MessageContent[];
  timestamp?: number;
}

type MessageContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input?: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content?: string };

interface SessionHistoryPanelProps {
  localUiUrl: string;
  viewerToken: string | null;
  workerId: string;
}

export default function SessionHistoryPanel({ localUiUrl, viewerToken, workerId }: SessionHistoryPanelProps) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [messages, setMessages] = useState<SessionMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);

  const PAGE_SIZE = 50;

  const buildUrl = useCallback((path: string, params?: Record<string, string>) => {
    const url = new URL(path, localUiUrl);
    if (viewerToken) url.searchParams.set('token', viewerToken);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }
    return url.toString();
  }, [localUiUrl, viewerToken]);

  // Fetch session list
  useEffect(() => {
    let cancelled = false;

    async function fetchSessions() {
      try {
        const res = await fetch(
          buildUrl(`/api/workers/${workerId}/sessions`),
          { signal: AbortSignal.timeout(10000), mode: 'cors' }
        );
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        if (!cancelled) {
          setSessions(data.sessions || []);
          setError(null);
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err.message || 'Failed to load sessions');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchSessions();
    return () => { cancelled = true; };
  }, [buildUrl, workerId]);

  // Fetch messages for selected session
  const fetchMessages = useCallback(async (sessionId: string, pageOffset = 0) => {
    setMessagesLoading(true);
    try {
      const res = await fetch(
        buildUrl(`/api/workers/${workerId}/sessions`, {
          sessionId,
          limit: String(PAGE_SIZE),
          offset: String(pageOffset),
        }),
        { signal: AbortSignal.timeout(10000), mode: 'cors' }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      const newMessages: SessionMessage[] = data.messages || [];

      if (pageOffset === 0) {
        setMessages(newMessages);
      } else {
        setMessages(prev => [...prev, ...newMessages]);
      }
      setHasMore(newMessages.length >= PAGE_SIZE);
      setOffset(pageOffset + newMessages.length);
    } catch (err: any) {
      console.error('Failed to fetch session messages:', err);
    } finally {
      setMessagesLoading(false);
    }
  }, [buildUrl, workerId]);

  function handleSessionClick(sessionId: string) {
    setSelectedSession(sessionId);
    setOffset(0);
    setMessages([]);
    fetchMessages(sessionId, 0);
  }

  function handleLoadMore() {
    if (selectedSession && !messagesLoading) {
      fetchMessages(selectedSession, offset);
    }
  }

  if (loading) return null;
  if (error || sessions.length === 0) return null;

  return (
    <div className="mt-3 border border-border-default bg-surface-2 rounded-md">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs font-mono text-text-secondary hover:bg-surface-3 rounded-md"
      >
        <span className="flex items-center gap-2">
          <span className="text-text-muted">{expanded ? '\u25BE' : '\u25B8'}</span>
          Session History
          <span className="text-text-muted">({sessions.length} session{sessions.length !== 1 ? 's' : ''})</span>
        </span>
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-3">
          {/* Session list */}
          <div className="space-y-1">
            {sessions.map(session => (
              <button
                key={session.sessionId}
                onClick={() => handleSessionClick(session.sessionId)}
                className={`w-full text-left px-2 py-1.5 rounded text-[11px] font-mono transition-colors ${
                  selectedSession === session.sessionId
                    ? 'bg-primary/10 text-primary border border-primary/20'
                    : 'hover:bg-surface-3 text-text-secondary'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-text-primary font-medium">
                    {new Date(session.startedAt).toLocaleDateString(undefined, {
                      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                    })}
                  </span>
                  <span className="text-text-muted">
                    {session.numTurns} turn{session.numTurns !== 1 ? 's' : ''}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-0.5 text-text-muted">
                  {session.durationMs > 0 && (
                    <span>{formatDuration(session.durationMs)}</span>
                  )}
                  {session.model && (
                    <span>{session.model.replace('claude-', '').replace(/-\d{8}$/, '')}</span>
                  )}
                </div>
              </button>
            ))}
          </div>

          {/* Messages for selected session */}
          {selectedSession && (
            <div className="border-t border-border-default/50 pt-3">
              {messagesLoading && messages.length === 0 ? (
                <div className="flex items-center gap-2 text-xs text-text-muted py-2">
                  <span className="w-2 h-2 rounded-full border-2 border-text-muted border-t-transparent animate-spin" />
                  Loading messages...
                </div>
              ) : messages.length === 0 ? (
                <p className="text-xs text-text-muted py-2">No messages found</p>
              ) : (
                <div className="space-y-2 max-h-96 overflow-y-auto">
                  {messages.map((msg, i) => (
                    <MessageBlock key={i} message={msg} />
                  ))}
                  {hasMore && (
                    <button
                      onClick={handleLoadMore}
                      disabled={messagesLoading}
                      className="w-full text-xs text-primary hover:text-primary-hover py-1.5 disabled:opacity-50"
                    >
                      {messagesLoading ? 'Loading...' : 'Load more'}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MessageBlock({ message }: { message: SessionMessage }) {
  const isUser = message.role === 'user';

  // Extract text content and tool use blocks
  const textParts = message.content?.filter(
    (c): c is Extract<MessageContent, { type: 'text' }> => c.type === 'text'
  ) || [];
  const toolUseParts = message.content?.filter(
    (c): c is Extract<MessageContent, { type: 'tool_use' }> => c.type === 'tool_use'
  ) || [];

  return (
    <div className={`text-[11px] font-mono ${isUser ? 'pl-4' : ''}`}>
      {/* Role label */}
      <div className="flex items-center gap-1.5 mb-0.5">
        <span className={`font-medium uppercase tracking-[1px] text-[9px] ${
          isUser ? 'text-primary' : 'text-accent-secondary'
        }`}>
          {isUser ? 'User' : 'Assistant'}
        </span>
        {message.timestamp && (
          <span className="text-text-muted text-[9px]">
            {new Date(message.timestamp).toLocaleTimeString(undefined, {
              hour: '2-digit', minute: '2-digit', second: '2-digit',
            })}
          </span>
        )}
      </div>

      {/* Text content */}
      {textParts.map((part, i) => (
        <p key={i} className="text-text-secondary whitespace-pre-wrap break-words leading-relaxed">
          {part.text.length > 500 ? part.text.slice(0, 500) + '...' : part.text}
        </p>
      ))}

      {/* Tool use blocks */}
      {toolUseParts.length > 0 && (
        <div className="mt-1 space-y-1">
          {toolUseParts.map((tool, i) => (
            <div
              key={i}
              className="flex items-center gap-1.5 px-2 py-1 bg-surface-3 rounded border border-border-default/50 text-[10px]"
            >
              <span className="text-status-info font-medium">{tool.name}</span>
              {tool.input && (
                <span className="text-text-muted truncate max-w-[200px]">
                  {summarizeToolInput(tool.input)}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMins = minutes % 60;
  return `${hours}h${remainMins > 0 ? `${remainMins}m` : ''}`;
}

function summarizeToolInput(input: Record<string, unknown>): string {
  // Show most relevant field for common tools
  if (input.command && typeof input.command === 'string') return input.command.slice(0, 60);
  if (input.file_path && typeof input.file_path === 'string') return input.file_path;
  if (input.pattern && typeof input.pattern === 'string') return input.pattern;
  if (input.query && typeof input.query === 'string') return input.query.slice(0, 60);
  // Fallback: show first key=value
  const entries = Object.entries(input);
  if (entries.length === 0) return '';
  const [k, v] = entries[0];
  return `${k}: ${String(v).slice(0, 40)}`;
}
