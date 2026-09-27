'use client';

/**
 * The conversation: your messages on the right, the agent's answers on the
 * left as prose, tool rows, approval cards and live objects, in the order the
 * parts arrived. Conversation is soft (Plex Sans, tinted bubbles, no frames)
 * on desktop; on a phone the person's message is a raised square block and the
 * turn in flight is the Thinking panel (thinking-model.ts). Fleet objects stay
 * hard and square (docs/design/chat-canvas.md).
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
import { intentTag, thinkingSteps, type ThinkingStep } from './thinking-model';

export interface ChatAgent {
  name: string;
  /** The role's own colour (workspaceSkills.color). */
  color: string | null;
}

export function AgentAvatar({ agent, size = 'md' }: { agent: ChatAgent; size?: 'xs' | 'sm' | 'md' }) {
  const dim = size === 'xs' ? 'h-5 w-5 text-[11px]' : size === 'sm' ? 'h-7 w-7 text-[13px]' : 'h-9 w-9 text-[15px]';
  const isBuildd = agent.name === 'buildd';
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center font-mono font-bold text-white ${dim} ${agent.color ? '' : 'bg-text-primary'}`}
      style={agent.color ? { background: agent.color } : undefined}
    >
      {isBuildd ? '✳' : agent.name.charAt(0).toUpperCase()}
    </span>
  );
}

function Segment({ seg }: { seg: FeedSegment }) {
  switch (seg.kind) {
    case 'text':
      return (
        <div data-testid="feed-text" className="font-convo text-[15.5px] leading-[1.65] text-text-primary">
          {/* While streaming, a solid block caret trails the last paragraph (inline, not a new line). */}
          <MarkdownContent
            content={seg.text}
            images="link"
            className={`!text-[15.5px] !leading-[1.65] !text-text-primary [&_code]:!bg-[var(--convo-me)] ${seg.streaming ? 'stream-caret' : ''}`}
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

/** The tiny tag under a message: where the reply went. Tapping it opens the composer's scope. */
function IntentTag({ label }: { label: string }) {
  return (
    <button
      type="button"
      data-testid="feed-intent-tag"
      onClick={() => (document.querySelector('[data-testid="composer-scope-chip"]') as HTMLElement | null)?.click()}
      className="min-h-6 px-1 font-mono text-[10px] tracking-[.08em] text-[var(--chat-dim)] hover:text-[var(--chat-text)]"
    >
      {label}
    </button>
  );
}

const UserMessage = memo(function UserMessage({ m, tag }: { m: ChatMessage; tag: string | null }) {
  const meta = messageMeta(m);
  const text = m.parts.filter(isTextPart).map(p => p.text).join('\n');
  return (
    <div data-testid="feed-message" data-role="user" className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2 px-1 font-mono text-[11px] text-text-muted">
        {meta.authorName && <span className="text-text-secondary">{meta.authorName}</span>}
        {meta.createdAt && <ZonedTime value={meta.createdAt} format="time" />}
      </div>
      {/* Phone: a raised square block with an offset shadow, in the voice face.
          Desktop keeps the soft tinted bubble. */}
      <div className="max-w-[82%] whitespace-pre-wrap border border-[var(--chat-rule-strong)] bg-[var(--chat-raised)] px-4 py-3 font-voice text-[17px] leading-[1.4] text-[var(--chat-text)] shadow-[3px_3px_0_0_var(--chat-rule)] [overflow-wrap:anywhere] md:max-w-[min(100%,560px)] md:rounded-[18px] md:rounded-br-[6px] md:border-0 md:bg-[var(--convo-me)] md:py-2.5 md:[font-family:var(--font-plex-sans),ui-sans-serif,system-ui,sans-serif] md:text-[15.5px] md:leading-[1.6] md:text-text-primary md:shadow-none">
        {text}
      </div>
      {tag && <IntentTag label={tag} />}
    </div>
  );
});

function StepMark({ state }: { state: ThinkingStep['state'] }) {
  if (state === 'pending') return <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 border border-[var(--chat-dim)]" />;
  return <span aria-hidden="true" className={`h-2.5 w-2.5 shrink-0 ${state === 'active' ? 'step-active bg-[var(--mood-thinking)]' : 'bg-[var(--mood-thinking-done)]'}`} />;
}

const STEP_TEXT: Record<ThinkingStep['state'], string> = {
  done: 'text-[var(--chat-muted)]',
  active: 'text-[var(--mood-thinking-text)]',
  pending: 'text-[var(--chat-dim)]',
};

/**
 * The turn in flight (docs/design/chat-canvas.md, "Thinking"): a square panel
 * with a plain blue left rule, BUILDD / THINKING and three ticking squares,
 * the steps in plain words, then what the agent is saying. No glow here; the
 * surface's one glow is the composer sweep.
 */
function ThinkingPanel({ m, agent }: { m: ChatMessage | null; agent: ChatAgent }) {
  const parts = m?.parts ?? [];
  const steps = thinkingSteps(parts);
  const segs = feedSegments(parts).filter(s => s.kind !== 'tools');
  return (
    <div data-testid="feed-message" data-role="assistant" data-live="true">
      <section
        data-testid="thinking-panel"
        aria-label={`${agent.name} is thinking`}
        aria-busy="true"
        className="border border-[var(--chat-rule)] border-l-2 border-l-[var(--mood-thinking-rule)] bg-[var(--chat-panel)] px-4 pb-4 pt-3"
      >
        <div className="flex items-center gap-3 font-mono text-[11px] font-semibold uppercase tracking-[.16em]">
          <span className="text-[var(--mood-needs)]">buildd</span>
          <span className="text-[var(--mood-thinking-label)]">thinking</span>
          <span aria-hidden="true" className="flex gap-[3px]">
            <span className="thinking-tick h-1 w-1 bg-[var(--mood-thinking)]" />
            <span className="thinking-tick h-1 w-1 bg-[var(--mood-thinking)]" />
            <span className="thinking-tick h-1 w-1 bg-[var(--mood-thinking)]" />
          </span>
        </div>
        <ol aria-label="Steps" className="mt-3 flex flex-col gap-2">
          {steps.map(st => (
            <li key={st.key} data-testid="thinking-step" data-state={st.state} className={`flex items-center gap-3 font-mono text-[13px] ${STEP_TEXT[st.state]}`}>
              <StepMark state={st.state} />
              <span className="min-w-0">{st.label}</span>
            </li>
          ))}
        </ol>
        {segs.length > 0 && (
          <div className="mt-3 flex flex-col gap-3.5">
            {segs.map(s => s.kind === 'text'
              ? (
                <div key={s.key} data-testid="feed-text" className="font-voice text-[17px] leading-[1.45] text-[var(--chat-text)]">
                  <MarkdownContent
                    content={s.text}
                    images="link"
                    className={`!text-[17px] !leading-[1.45] !text-[var(--chat-text)] [&_code]:!bg-[var(--convo-me)] ${s.streaming ? 'stream-caret' : ''}`}
                  />
                </div>
              )
              : <Segment key={s.key} seg={s} />)}
          </div>
        )}
      </section>
    </div>
  );
}

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
  live = false,
  error,
}: {
  messages: readonly ChatMessage[];
  agent: ChatAgent;
  /** Submitted, nothing streamed yet. */
  thinking?: boolean;
  /** A turn is in flight: the latest assistant turn draws as the Thinking panel. */
  live?: boolean;
  error?: string | null;
}) {
  const last = messages[messages.length - 1];
  const liveId = live && last && last.role === 'assistant' ? last.id : null;
  return (
    <div data-testid="chat-feed" className="flex flex-col gap-7">
      {messages.map((m, i) => m.role === 'user'
        ? <UserMessage key={m.id} m={m} tag={intentTag(messages, i)?.label ?? null} />
        : m.id === liveId ? <ThinkingPanel key={m.id} m={m} agent={agent} />
        : m.role === 'assistant' || m.role === 'event' ? <AssistantMessage key={m.id} m={m} agent={agent} /> : null)}
      {thinking && (
        <div data-testid="feed-thinking">
          <ThinkingPanel m={null} agent={agent} />
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
