'use client';

/**
 * The conversation: your messages on the right, the agent's answers on the
 * left as prose, tool rows, approval cards and live objects, in the order the
 * parts arrived. Conversation is soft (Plex Sans, tinted bubbles, no frames);
 * the fleet objects inside it stay hard and square (docs/design/chat-canvas.md).
 */
import { memo } from 'react';
import MarkdownContent from '@/components/MarkdownContent';
import { ZonedTime } from '@/components/DisplayTimezone';
import { isTextPart, messageMeta, type ChatMessage } from './chat-contract';
import { feedSegments, type FeedSegment } from './feed-model';
import ApprovalCard from './ApprovalCard';
import { ToolCallGroup } from './ToolCallRows';
import { ObjectsSegment } from './objects/registry';
import TurnFeedback from './TurnFeedback';

export interface ChatAgent {
  name: string;
  /** The role's own colour (workspaceSkills.color). */
  color: string | null;
}

export function AgentAvatar({ agent, size = 'md' }: { agent: ChatAgent; size?: 'xs' | 'sm' | 'md' }) {
  const dim = size === 'xs' ? 'h-5 w-5 text-[11px]' : size === 'sm' ? 'h-7 w-7 text-[13px]' : 'h-9 w-9 text-[15px]';
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center font-mono font-bold text-white ${dim} ${agent.color ? '' : 'bg-text-primary'}`}
      style={agent.color ? { background: agent.color } : undefined}
    >
      {agent.name.charAt(0).toUpperCase()}
    </span>
  );
}

function Segment({ seg }: { seg: FeedSegment }) {
  switch (seg.kind) {
    case 'text':
      return (
        <div data-testid="feed-text" className="font-convo text-[15.5px] leading-[1.65] text-text-primary">
          {/* While streaming, a caret trails the last paragraph (inline, not a new line). */}
          <MarkdownContent
            content={seg.text}
            images="link"
            className={`!text-[15.5px] !leading-[1.65] !text-text-primary [&_code]:!bg-[var(--convo-me)] ${seg.streaming ? "[&_p:last-child]:after:ml-0.5 [&_p:last-child]:after:text-accent [&_p:last-child]:after:content-['▍']" : ''}`}
          />
        </div>
      );
    case 'tools':
      return <ToolCallGroup calls={seg.calls} />;
    case 'approval':
      return <ApprovalCard part={seg.part} />;
    case 'objects':
      return <ObjectsSegment refs={seg.refs} />;
    case 'event':
      return (
        <div data-testid="feed-event" data-event={seg.event} className="flex items-center gap-2 font-mono text-[12px] text-text-secondary">
          <span aria-hidden="true" className={`h-2 w-2 shrink-0 ${seg.event === 'mission_failed' ? 'bg-status-error' : seg.event === 'question' ? 'bg-status-warning' : seg.event === 'mission_completed' ? 'bg-status-success' : 'bg-accent'}`} />
          {seg.text}
        </div>
      );
  }
}

const UserMessage = memo(function UserMessage({ m }: { m: ChatMessage }) {
  const meta = messageMeta(m);
  const text = m.parts.filter(isTextPart).map(p => p.text).join('\n');
  return (
    <div data-testid="feed-message" data-role="user" className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2 px-1 font-mono text-[11px] text-text-muted">
        {meta.authorName && <span className="text-text-secondary">{meta.authorName}</span>}
        {meta.createdAt && <ZonedTime value={meta.createdAt} format="time" />}
      </div>
      {/* Conversation is soft: a tinted bubble, no frame. Fleet objects stay hard. */}
      <div className="max-w-[min(100%,560px)] whitespace-pre-wrap rounded-[18px] rounded-br-[6px] bg-[var(--convo-me)] px-4 py-2.5 font-convo text-[15.5px] leading-[1.6] text-text-primary [overflow-wrap:anywhere]">
        {text}
      </div>
    </div>
  );
});

function AssistantMessage({ m, agent }: { m: ChatMessage; agent: ChatAgent }) {
  const meta = messageMeta(m);
  const segs = feedSegments(m.parts);
  if (segs.length === 0) return null;
  return (
    <div data-testid="feed-message" data-role="assistant" className="flex gap-3">
      <AgentAvatar agent={agent} size="sm" />
      <div className="flex min-w-0 flex-1 flex-col gap-3.5">
        <div className="flex min-h-7 items-center gap-2 font-mono text-[11.5px] text-text-muted">
          <span className="font-semibold text-text-secondary">{agent.name}</span>
          {meta.createdAt && <ZonedTime value={meta.createdAt} format="time" />}
          {meta.durationMs != null && <span>{`· ${(meta.durationMs / 1000).toFixed(1)}s`}</span>}
        </div>
        {segs.map(s => <Segment key={s.key} seg={s} />)}
        {m.role === 'assistant' && <TurnFeedback messageId={m.id} />}
      </div>
    </div>
  );
}

export default function ChatFeed({
  messages,
  agent,
  thinking = false,
  error,
}: {
  messages: readonly ChatMessage[];
  agent: ChatAgent;
  /** Submitted, nothing streamed yet. */
  thinking?: boolean;
  error?: string | null;
}) {
  return (
    <div data-testid="chat-feed" className="flex flex-col gap-7">
      {messages.map(m => m.role === 'user'
        ? <UserMessage key={m.id} m={m} />
        : m.role === 'assistant' || m.role === 'event' ? <AssistantMessage key={m.id} m={m} agent={agent} /> : null)}
      {thinking && (
        <div data-testid="feed-thinking" className="flex items-center gap-3 text-text-muted">
          <AgentAvatar agent={agent} size="sm" />
          <span className="inline-flex items-center gap-2 font-convo text-[14.5px]">
            <span aria-hidden="true" className="h-2 w-2 animate-status-pulse bg-accent" />
            {`${agent.name} is reading…`}
          </span>
        </div>
      )}
      {error && (
        <div role="alert" data-testid="feed-error" className="rounded-[12px] bg-[var(--fleet-err-soft)] px-4 py-3 font-convo text-[14px] text-status-error">
          {error}
        </div>
      )}
    </div>
  );
}
