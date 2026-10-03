'use client';

/**
 * The message list. Reads the contract (`ChatMessage` parts), never an app's
 * DB: text, tool rows, approval cards, hand-off cards, steers, events, and the
 * thinking checklist on the streaming assistant message. Every renderer can be
 * replaced per app (`renderText` for markdown, `renderObject` for the app's
 * own object kinds, `renderTool` for a special tool), and since 0.9.0 an app
 * can add a header and footer to each message, draw consecutive tool calls as
 * one group, supply its own checklist and name its own event part. Since
 * 0.11.0 `toolRows="rich"` draws each run of calls as `ToolCallGroup`.
 */
import { useMemo, type ReactNode } from 'react';
import {
  EVENT_PART_TYPE,
  isHandoffPart,
  isSteerPart,
  isTextPart,
  isToolPart,
  isTurnErrorPart,
  latestHandoffs,
  type ChatMessage,
  type ChatPart,
  type ChatTextPart,
  type ChatToolPart,
  type EventData,
  type HandoffData,
  type ObjectRef,
  type StepData,
} from '@builddai/ai-kit/chat/contract';
import { ApprovalCard, ApprovalRowsCard, HandoffCard, ThinkingPanel } from './cards';
import { approvalRowGroup, isApprovalPart, thinkingSteps, toolRowLabel, toolRowState, toolSummary } from './model';
import { ToolCallGroup } from './ToolCalls';
import type { ToolCallOptions } from './tool-calls';

export type ChatStatus = 'ready' | 'submitted' | 'streaming' | 'error';

/** Where a message sits, for the per-message slots (0.9.0). */
export interface ThreadMessageContext {
  /** Its index in `messages`. */
  index: number;
  /** It is the assistant message still streaming. */
  streaming: boolean;
  messages: readonly ChatMessage[];
}

export interface ChatThreadProps {
  messages: readonly ChatMessage[];
  /** `useChat().status`. `submitted` / `streaming` = the last assistant message is live. */
  status?: ChatStatus;
  /** Answer an approval card. Without it, cards render read-only. */
  onApprovalResponse?(approvalId: string, approved: boolean, reason?: string): void;
  onEditApproval?(part: ChatToolPart): void;
  /**
   * Default: plain text with line breaks kept. Pass a markdown renderer here.
   * `part` (0.9.0) carries the text part's `state` (`streaming` while it grows).
   */
  renderText?(text: string, message: ChatMessage, part: ChatTextPart): ReactNode;
  /** Render one object a tool returned (`ToolResult.objects`). Default: nothing. */
  renderObject?(ref: ObjectRef, part: ChatToolPart): ReactNode;
  /**
   * Replace a tool's row entirely; return undefined to keep the default.
   * Since 0.13.0 `null` draws nothing (no empty frame), e.g. for the other
   * rows of an approval card the app drew at its first row.
   */
  renderTool?(part: ChatToolPart, message: ChatMessage): ReactNode | undefined;
  /**
   * Draw a run of consecutive tool calls (not approvals, not ones `renderTool`
   * took) as one node, e.g. "3 tool calls" over their rows (0.9.0). Text,
   * approvals, hand-offs, steers and errors end a run; parts that render
   * nothing don't. Without it, each call is its own row.
   */
  renderToolGroup?(parts: readonly ChatToolPart[], message: ChatMessage, ctx: ThreadMessageContext): ReactNode;
  /**
   * How tool calls look when `renderToolGroup` isn't passed (0.11.0).
   * `line` (default): one line per call, as before. `rich`: each run of
   * consecutive calls is a `ToolCallGroup` (key arguments, live state, a
   * result line, expand to the raw input and output, a count header over
   * two or more), followed by what the calls returned (`renderObject`).
   */
  toolRows?: 'line' | 'rich';
  /** The app's hooks for `toolRows="rich"`: tool labels, key arguments, read-only calls, the result line. */
  toolCallOptions?: ToolCallOptions;
  /** Replace an event row (`role: 'event'`). */
  renderEvent?(data: EventData, message: ChatMessage): ReactNode;
  /**
   * The part type an event message carries (0.9.0). Default `data-event`; an
   * app with its own (e.g. `data-buildd-event`) names it here, and its data
   * reaches `renderEvent` as is.
   */
  eventPartType?: string;
  renderHandoff?(data: HandoffData): ReactNode;
  /** Above a message's parts, e.g. the author, avatar and time (0.9.0). Null: nothing. */
  renderMessageHeader?(message: ChatMessage, ctx: ThreadMessageContext): ReactNode;
  /** After a message's parts, e.g. feedback thumbs (0.9.0). Null: nothing. */
  renderMessageFooter?(message: ChatMessage, ctx: ThreadMessageContext): ReactNode;
  /**
   * The thinking checklist for an assistant message, when the app derives its
   * own (0.9.0). Default: the message's `data-step` parts (`thinkingSteps`).
   * Return an empty list for no panel. While the first chunk is awaited it is
   * called with an empty assistant message.
   */
  steps?(message: ChatMessage, streaming: boolean): readonly StepData[];
  /** @deprecated 0.17.0: the live line has no header, so this is not drawn. */
  thinkingTitle?: ReactNode;
  /** The live line's accessible name before its label (0.17.0), e.g. "Buildd is working". Default "Working". */
  thinkingName?: string;
  /**
   * Draw the step pinned under the live line (0.17.0), e.g. a write as the
   * object it returned. Undefined keeps the default row.
   */
  renderPinnedStep?(step: StepData, message: ChatMessage): ReactNode | undefined;
  /**
   * Fold a finished turn (0.13.0): its steps and its tool-call runs collapse
   * under one line, e.g. "Did 6 steps · filed 2 tasks", that unfolds on tap.
   * Approvals, text, hand-offs and events stay where they are. `summary`
   * returning null leaves that turn unfolded (nothing to fold). The app holds
   * which turns are open, so a re-render never springs one shut.
   */
  turnFold?: TurnFold;
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

/** How a finished turn folds (`ChatThread turnFold`, 0.13.0). */
export interface TurnFold {
  /** The folded line for a settled assistant message, from its steps. Null: nothing to fold. */
  summary(message: ChatMessage, steps: readonly StepData[]): ReactNode | null;
  /** Whether the person unfolded it. */
  isOpen(message: ChatMessage): boolean;
  onToggle(message: ChatMessage, open: boolean): void;
}

function defaultText(text: string) {
  return <p className="kit-text">{text}</p>;
}

const PENDING: ChatMessage = { id: 'kit-pending', role: 'assistant', parts: [] };

function eventOf(m: ChatMessage, type: string): EventData | null {
  const p = m.parts.find(x => x.type === type) as (ChatPart & { data?: Partial<EventData> }) | undefined;
  const d = p?.data;
  if (!d || typeof d.event !== 'string' || typeof d.text !== 'string') return null;
  // The kit's own part must carry its objects; an app's own type is the app's to shape.
  if (type === EVENT_PART_TYPE && !Array.isArray(d.objects)) return null;
  return d as EventData;
}

export function ChatThread({
  messages, status = 'ready', onApprovalResponse, onEditApproval, renderText = defaultText, renderObject,
  renderTool, renderToolGroup: appToolGroup, toolRows = 'line', toolCallOptions, renderEvent, eventPartType = EVENT_PART_TYPE, renderHandoff,
  renderMessageHeader, renderMessageFooter, steps: stepsOf, thinkingName, renderPinnedStep, turnFold,
  viewerName = null, empty, error, label = 'Conversation', className,
}: ChatThreadProps) {
  const handoffs = useMemo(() => latestHandoffs(messages), [messages]);
  const live = status === 'submitted' || status === 'streaming';
  const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
  const waitingForFirstChunk = status === 'submitted' && messages.at(-1)?.role === 'user';
  const lastHasTurnError = !!messages.at(-1)?.parts.some(isTurnErrorPart);
  const renderToolGroup = appToolGroup ?? (toolRows === 'rich'
    ? (parts: readonly ChatToolPart[]) => (
      <>
        <ToolCallGroup calls={parts} {...toolCallOptions} />
        {renderObject && parts.flatMap(p => {
          const objects = (p.output as { objects?: ObjectRef[] } | undefined)?.objects;
          return Array.isArray(objects) ? objects.map((o, j) => <div key={`${p.toolCallId}:${o.kind}:${o.id}:${j}`}>{renderObject(o, p)}</div>) : [];
        })}
      </>
    )
    : undefined);

  if (messages.length === 0 && empty) return <div className={`kit-chat${className ? ` ${className}` : ''}`}>{empty}</div>;

  const head = (m: ChatMessage, ctx: ThreadMessageContext) => {
    const node = renderMessageHeader?.(m, ctx);
    return node != null && node !== false ? <div className="kit-msg-head">{node}</div> : null;
  };
  const foot = (m: ChatMessage, ctx: ThreadMessageContext) => {
    const node = renderMessageFooter?.(m, ctx);
    return node != null && node !== false ? <div className="kit-msg-foot">{node}</div> : null;
  };

  // `folded`: the turn's calls sit under its folded line, so none of them draw.
  const partsOf = (m: ChatMessage, ctx: ThreadMessageContext, folded = false): ReactNode[] => {
    const out: ReactNode[] = [];
    // Two or more writes in one message are the rows of one card (0.13.0),
    // drawn where the first of them is.
    const rows = approvalRowGroup(m.parts);
    const inRows = new Set([...(rows?.rows ?? []), ...(rows?.held ?? [])].map(p => p.toolCallId));
    let rowsDrawn = false;
    let group: ChatToolPart[] = [];
    let groupAt = 0;
    const flush = () => {
      if (group.length === 0 || !renderToolGroup) return;
      if (folded) { group = []; return; }
      const node = renderToolGroup(group, m, ctx);
      // A group the app draws as nothing (e.g. while a panel says it) leaves no frame.
      if (node != null && node !== false) out.push(<div key={`${m.id}:g${groupAt}`}>{node}</div>);
      group = [];
    };
    m.parts.forEach((p, i) => {
      const key = `${m.id}:${i}`;
      if (isTextPart(p)) {
        if (p.text.trim()) flush();
        if (p.text) out.push(<div key={key}>{renderText(p.text, m, p)}</div>);
        return;
      }
      if (isToolPart(p)) {
        const custom = renderTool?.(p, m);
        if (custom === null) return;
        if (custom !== undefined) { flush(); out.push(<div key={key}>{custom}</div>); return; }
        if (rows && inRows.has(p.toolCallId)) {
          if (rowsDrawn) return;
          rowsDrawn = true;
          flush();
          out.push(
            <ApprovalRowsCard key={key} parts={rows.rows} held={rows.held} onRespond={onApprovalResponse ?? (() => {})} approverName={viewerName} />,
          );
          return;
        }
        if (isApprovalPart(p)) {
          flush();
          out.push(onApprovalResponse
            ? <ApprovalCard key={key} part={p} onRespond={onApprovalResponse} onEdit={onEditApproval} approverName={viewerName} />
            : <ApprovalCard key={key} part={p} onRespond={() => {}} approverName={viewerName} />);
          return;
        }
        if (renderToolGroup) {
          if (group.length === 0) groupAt = i;
          group.push(p);
          return;
        }
        if (folded) return;
        const state = toolRowState(p);
        const summary = toolSummary(p);
        const objects = (p.output as { objects?: ObjectRef[] } | undefined)?.objects;
        out.push(
          <div key={key}>
            <div className="kit-tool" data-state={state} data-tool-call-id={p.toolCallId}>
              <span aria-hidden="true">{state === 'done' ? '✓' : state === 'failed' ? '!' : '·'}</span>
              <span>{toolRowLabel(p, m.parts)}</span>
              {summary && <span className="kit-tool-summary">· {summary}</span>}
            </div>
            {renderObject && Array.isArray(objects) && objects.map((o, j) => <div key={`${o.kind}:${o.id}:${j}`}>{renderObject(o, p)}</div>)}
          </div>,
        );
        return;
      }
      if (isHandoffPart(p)) {
        flush();
        const data = handoffs.get(p.data.taskId) ?? p.data;
        out.push(<div key={key}>{renderHandoff ? renderHandoff(data) : <HandoffCard data={data} />}</div>);
        return;
      }
      if (isTurnErrorPart(p)) {
        flush();
        out.push(<div key={key} className="kit-error" role="alert" data-turn-error={p.data.code}>{p.data.message}</div>);
        return;
      }
      if (isSteerPart(p)) {
        flush();
        out.push(
          <p key={key} className="kit-steer-note" data-steer-state={p.data.state}>
            {p.data.state === 'deferred' ? 'Sending next: ' : 'You added: '}{p.data.text}
          </p>,
        );
      }
    });
    flush();
    return out;
  };

  return (
    <div className={`kit-chat kit-thread${className ? ` ${className}` : ''}`} role="log" aria-label={label} aria-live="polite" aria-busy={live || undefined} data-testid="kit-thread">
      {messages.map((m, index) => {
        if (m.role === 'system') return null;
        if (m.role === 'event') {
          const ev = eventOf(m, eventPartType);
          if (!ev) return null;
          const ctx: ThreadMessageContext = { index, streaming: false, messages };
          return (
            <div key={m.id} className="kit-msg" data-role="event" data-message-id={m.id}>
              {head(m, ctx)}
              {renderEvent ? renderEvent(ev, m) : <p className="kit-event">{ev.text}</p>}
              {foot(m, ctx)}
            </div>
          );
        }
        const streaming = live && m === lastAssistant && m === messages.at(-1);
        const ctx: ThreadMessageContext = { index, streaming, messages };
        const steps = m.role === 'assistant' ? (stepsOf ? stepsOf(m, streaming) : thinkingSteps(m.parts, streaming)) : [];
        const foldLine = m.role === 'assistant' && !streaming && turnFold ? turnFold.summary(m, steps) : null;
        const foldOpen = foldLine != null && turnFold!.isOpen(m);
        // An app checklist with no steps while the answer streams: nothing left to show working.
        const answering = streaming && steps.length === 0 && m.parts.some(p => isTextPart(p) && !!p.text.trim());
        return (
          <div key={m.id} className="kit-msg" data-role={m.role} data-message-id={m.id} data-streaming={streaming || undefined} data-folded={(foldLine != null && !foldOpen) || undefined}>
            {head(m, ctx)}
            {m.role === 'assistant' && (foldLine != null
              ? <ThinkingPanel steps={steps} streaming={false} summary={foldLine} open={foldOpen} onToggle={open => turnFold!.onToggle(m, open)} />
              : !answering && (
                <ThinkingPanel
                  steps={steps}
                  streaming={streaming}
                  name={thinkingName}
                  renderPinned={renderPinnedStep ? s => renderPinnedStep(s, m) : undefined}
                />
              ))}
            {partsOf(m, ctx, foldLine != null && !foldOpen)}
            {foot(m, ctx)}
          </div>
        );
      })}
      {waitingForFirstChunk && (
        <div className="kit-msg" data-role="assistant" data-streaming>
          <ThinkingPanel steps={stepsOf ? stepsOf(PENDING, true) : thinkingSteps([], true)} streaming name={thinkingName} />
        </div>
      )}
      {error && !lastHasTurnError && <div className="kit-error" role="alert">{error}</div>}
    </div>
  );
}
