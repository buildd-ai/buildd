'use client';

/**
 * The message list. Reads the contract (`ChatMessage` parts), never an app's
 * DB: text, tool rows, approval cards, hand-off cards, steers, events, and the
 * thinking checklist on the streaming assistant message. Every renderer can be
 * replaced per app (`renderText` for markdown, `renderObject` for the app's
 * own object kinds, `renderTool` for a special tool).
 */
import { useMemo, type ReactNode } from 'react';
import {
  isEventPart,
  isHandoffPart,
  isSteerPart,
  isTextPart,
  isToolPart,
  isTurnErrorPart,
  latestHandoffs,
  type ChatMessage,
  type ChatToolPart,
  type EventData,
  type HandoffData,
  type ObjectRef,
} from '@builddai/ai-kit/chat/contract';
import { ApprovalCard, HandoffCard, ThinkingPanel } from './cards';
import { isApprovalPart, thinkingSteps, toolRowLabel, toolRowState, toolSummary } from './model';

export type ChatStatus = 'ready' | 'submitted' | 'streaming' | 'error';

export interface ChatThreadProps {
  messages: readonly ChatMessage[];
  /** `useChat().status`. `submitted` / `streaming` = the last assistant message is live. */
  status?: ChatStatus;
  /** Answer an approval card. Without it, cards render read-only. */
  onApprovalResponse?(approvalId: string, approved: boolean, reason?: string): void;
  onEditApproval?(part: ChatToolPart): void;
  /** Default: plain text with line breaks kept. Pass a markdown renderer here. */
  renderText?(text: string, message: ChatMessage): ReactNode;
  /** Render one object a tool returned (`ToolResult.objects`). Default: nothing. */
  renderObject?(ref: ObjectRef, part: ChatToolPart): ReactNode;
  /** Replace a tool's row entirely; return undefined to keep the default. */
  renderTool?(part: ChatToolPart, message: ChatMessage): ReactNode | undefined;
  /** Replace an event row (`role: 'event'`). */
  renderEvent?(data: EventData, message: ChatMessage): ReactNode;
  renderHandoff?(data: HandoffData): ReactNode;
  /** The person's name, for "Approved by …". */
  viewerName?: string | null;
  /** Shown instead of the list while there are no messages (`<ChatEmpty>`). */
  empty?: ReactNode;
  /**
   * The failure of the last request (`useChat().error`), shown after the list.
   * Not shown when the last message already carries the turn's
   * `data-turn-error` part (rendered in place, same words).
   */
  error?: ReactNode;
  /** Accessible name of the log. */
  label?: string;
  className?: string;
}

function defaultText(text: string) {
  return <p className="kit-text">{text}</p>;
}

export function ChatThread({
  messages, status = 'ready', onApprovalResponse, onEditApproval, renderText = defaultText, renderObject,
  renderTool, renderEvent, renderHandoff, viewerName = null, empty, error, label = 'Conversation', className,
}: ChatThreadProps) {
  const handoffs = useMemo(() => latestHandoffs(messages), [messages]);
  const live = status === 'submitted' || status === 'streaming';
  const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
  const waitingForFirstChunk = status === 'submitted' && messages.at(-1)?.role === 'user';
  const lastHasTurnError = !!messages.at(-1)?.parts.some(isTurnErrorPart);

  if (messages.length === 0 && empty) return <div className={`kit-chat${className ? ` ${className}` : ''}`}>{empty}</div>;

  return (
    <div className={`kit-chat kit-thread${className ? ` ${className}` : ''}`} role="log" aria-label={label} aria-live="polite" aria-busy={live || undefined} data-testid="kit-thread">
      {messages.map(m => {
        if (m.role === 'system') return null;
        if (m.role === 'event') {
          const ev = m.parts.find(isEventPart);
          if (!ev) return null;
          return (
            <div key={m.id} className="kit-msg" data-role="event" data-message-id={m.id}>
              {renderEvent ? renderEvent(ev.data, m) : <p className="kit-event">{ev.data.text}</p>}
            </div>
          );
        }
        const streaming = live && m === lastAssistant && m === messages.at(-1);
        const steps = m.role === 'assistant' ? thinkingSteps(m.parts, streaming) : [];
        return (
          <div key={m.id} className="kit-msg" data-role={m.role} data-message-id={m.id} data-streaming={streaming || undefined}>
            {m.role === 'assistant' && <ThinkingPanel steps={steps} streaming={streaming} />}
            {m.parts.map((p, i) => {
              const key = `${m.id}:${i}`;
              if (isTextPart(p)) return p.text ? <div key={key}>{renderText(p.text, m)}</div> : null;
              if (isToolPart(p)) {
                const custom = renderTool?.(p, m);
                if (custom !== undefined) return <div key={key}>{custom}</div>;
                if (isApprovalPart(p)) {
                  return onApprovalResponse
                    ? <ApprovalCard key={key} part={p} onRespond={onApprovalResponse} onEdit={onEditApproval} approverName={viewerName} />
                    : <ApprovalCard key={key} part={p} onRespond={() => {}} approverName={viewerName} />;
                }
                const state = toolRowState(p);
                const summary = toolSummary(p);
                const objects = (p.output as { objects?: ObjectRef[] } | undefined)?.objects;
                return (
                  <div key={key}>
                    <div className="kit-tool" data-state={state} data-tool-call-id={p.toolCallId}>
                      <span aria-hidden="true">{state === 'done' ? '✓' : state === 'failed' ? '!' : '·'}</span>
                      <span>{toolRowLabel(p, m.parts)}</span>
                      {summary && <span className="kit-tool-summary">· {summary}</span>}
                    </div>
                    {renderObject && Array.isArray(objects) && objects.map((o, j) => <div key={`${o.kind}:${o.id}:${j}`}>{renderObject(o, p)}</div>)}
                  </div>
                );
              }
              if (isHandoffPart(p)) {
                const data = handoffs.get(p.data.taskId) ?? p.data;
                return <div key={key}>{renderHandoff ? renderHandoff(data) : <HandoffCard data={data} />}</div>;
              }
              if (isTurnErrorPart(p)) {
                return <div key={key} className="kit-error" role="alert" data-turn-error={p.data.code}>{p.data.message}</div>;
              }
              if (isSteerPart(p)) {
                return (
                  <p key={key} className="kit-steer-note" data-steer-state={p.data.state}>
                    {p.data.state === 'deferred' ? 'Sending next: ' : 'You added: '}{p.data.text}
                  </p>
                );
              }
              return null;
            })}
          </div>
        );
      })}
      {waitingForFirstChunk && (
        <div className="kit-msg" data-role="assistant" data-streaming>
          <ThinkingPanel steps={thinkingSteps([], true)} streaming />
        </div>
      )}
      {error && !lastHasTurnError && <div className="kit-error" role="alert">{error}</div>}
    </div>
  );
}
