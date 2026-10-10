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
  answerPartIndex,
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
import { THINKING_TAIL_ID, approvalRowGroup, composeTurn, isApprovalPart, thinkingSteps, toolRowLabel, toolRowState, toolSummary, type TurnPhase } from './model';
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
  /**
   * How an assistant turn's prose lives (0.18.0). `append` (default): every
   * text part is drawn where it arrived, as before. `replace`: the turn draws
   * one answer region, its latest prose (`answerPartIndex`), so text written
   * early in a long turn shows at once and the final answer replaces it in
   * place, the same node, rather than following it. Earlier prose stays in
   * the parts (history, audit), off screen. The region carries
   * `data-testid="kit-answer"` and `data-answer="live" | "settled"`, and is
   * `aria-busy` while live so a screen reader reads the settled answer once.
   */
  answer?: 'append' | 'replace';
  /**
   * How an assistant turn is laid out (0.22.0). `parts` (default): in the
   * order the parts arrived, as before. `turn`: fixed regions that never trade
   * places while the turn streams (`composeTurn`): the work line, the turn's
   * tool rows under it, then each phase: its answer slot (`replace` within the
   * phase), its hand-offs and custom rows, the approval card that closed it,
   * and its results (`renderPhaseResults`, once the phase is settled). The
   * reply to a decision is the next phase's answer, a new node below the card;
   * the rationale above the card stays where it was. Phases carry
   * `class="kit-phase"`, `data-phase` and `data-closed`; results
   * `class="kit-phase-results"`.
   */
  compose?: 'parts' | 'turn';
  /**
   * `compose="turn"`: what a settled phase's calls produced, drawn after its
   * answer and card (0.22.0), e.g. the objects a write created and the ones the
   * answer cites. Called only once the phase is settled, so a result never
   * mounts above prose still streaming. Default with `toolRows="rich"` and
   * `renderObject`: the phase's calls' objects.
   */
  renderPhaseResults?(message: ChatMessage, phase: TurnPhase, ctx: ThreadMessageContext): ReactNode;
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
  renderMessageHeader, renderMessageFooter, steps: stepsOf, thinkingName, renderPinnedStep, turnFold, answer = 'append',
  compose = 'parts', renderPhaseResults: appPhaseResults, viewerName = null, empty, error, label = 'Conversation', className,
}: ChatThreadProps) {
  const handoffs = useMemo(() => latestHandoffs(messages), [messages]);
  const live = status === 'submitted' || status === 'streaming';
  const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
  const waitingForFirstChunk = status === 'submitted' && messages.at(-1)?.role === 'user';
  const lastHasTurnError = !!messages.at(-1)?.parts.some(isTurnErrorPart);
  const turnMode = compose === 'turn';
  const objectsOf = (parts: readonly ChatToolPart[]) => (renderObject ? parts.flatMap(p => {
    const objects = (p.output as { objects?: ObjectRef[] } | undefined)?.objects;
    return Array.isArray(objects) ? objects.map((o, j) => <div key={`${p.toolCallId}:${o.kind}:${o.id}:${j}`}>{renderObject(o, p)}</div>) : [];
  }) : []);
  const renderToolGroup = appToolGroup ?? (toolRows === 'rich'
    ? (parts: readonly ChatToolPart[]) => (
      <>
        <ToolCallGroup calls={parts} {...toolCallOptions} />
        {/* `turn`: what the calls returned is the phase's results, after its answer. */}
        {!turnMode && objectsOf(parts)}
      </>
    )
    : undefined);
  const renderPhaseResults = appPhaseResults ?? (turnMode && toolRows === 'rich' && renderObject
    ? (m: ChatMessage, phase: TurnPhase) => {
      const calls = m.parts.slice(phase.from, phase.to).filter(isToolPart).filter(p => !isApprovalPart(p));
      const nodes = objectsOf(calls);
      return nodes.length > 0 ? nodes : null;
    }
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
    // `replace`: one answer region per assistant turn, keyed by the message so
    // the final prose updates the early prose's node instead of a new one.
    const answerAt = answer === 'replace' && m.role === 'assistant' ? answerPartIndex(m.parts) : null;
    m.parts.forEach((p, i) => {
      const key = `${m.id}:${i}`;
      if (isTextPart(p) && answerAt !== null) {
        // Superseded prose draws nothing, so it doesn't split a run of calls either.
        if (i !== answerAt) return;
        flush();
        out.push(
          <div
            key={`${m.id}:answer`}
            className="kit-answer"
            data-testid="kit-answer"
            data-answer={ctx.streaming ? 'live' : 'settled'}
            aria-busy={ctx.streaming || undefined}
          >
            {renderText(p.text, m, p)}
          </div>,
        );
        return;
      }
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

  // `compose="turn"` (0.22.0): the work's rows under the line, then each phase
  // in its own keyed frame: answer, blocks, the card that closed it, results.
  const turnOf = (m: ChatMessage, ctx: ThreadMessageContext, folded: boolean): ReactNode[] => {
    const { phases } = composeTurn(m.parts, { streaming: ctx.streaming });
    const rows = approvalRowGroup(m.parts);
    const inRows = new Set([...(rows?.rows ?? []), ...(rows?.held ?? [])].map(p => p.toolCallId));
    let rowsDrawn = false;
    const card = (p: ChatToolPart, key: string): ReactNode => {
      if (rows && inRows.has(p.toolCallId)) {
        if (rowsDrawn) return null;
        rowsDrawn = true;
        return <ApprovalRowsCard key={key} parts={rows.rows} held={rows.held} onRespond={onApprovalResponse ?? (() => {})} approverName={viewerName} />;
      }
      return onApprovalResponse
        ? <ApprovalCard key={key} part={p} onRespond={onApprovalResponse} onEdit={onEditApproval} approverName={viewerName} />
        : <ApprovalCard key={key} part={p} onRespond={() => {}} approverName={viewerName} />;
    };
    const work: ReactNode[] = [];
    const errors: ReactNode[] = [];
    const frames = phases.map(ph => {
      const calls: ChatToolPart[] = [];
      let callsAt = -1;
      const blocks: ReactNode[] = [];
      const closing: ReactNode[] = [];
      let opener: ReactNode = null;
      for (let i = ph.from; i < ph.to; i++) {
        const p = m.parts[i];
        const key = `${m.id}:${i}`;
        if (isToolPart(p)) {
          const into = ph.closer?.kind === 'approval' && ph.closer.at.includes(i) ? closing : blocks;
          const custom = renderTool?.(p, m);
          if (custom === null) continue;
          if (custom !== undefined) { into.push(<div key={key}>{custom}</div>); continue; }
          if (isApprovalPart(p)) { const node = card(p, key); if (node) into.push(node); continue; }
          if (callsAt === -1) callsAt = i;
          calls.push(p);
          continue;
        }
        if (isHandoffPart(p)) {
          const data = handoffs.get(p.data.taskId) ?? p.data;
          blocks.push(<div key={key}>{renderHandoff ? renderHandoff(data) : <HandoffCard data={data} />}</div>);
        } else if (isTurnErrorPart(p)) {
          errors.push(<div key={key} className="kit-error" role="alert" data-turn-error={p.data.code}>{p.data.message}</div>);
        } else if (isSteerPart(p)) {
          const note = (
            <p key={key} className="kit-steer-note" data-steer-state={p.data.state}>
              {p.data.state === 'deferred' ? 'Sending next: ' : 'You added: '}{p.data.text}
            </p>
          );
          if (ph.opener?.kind === 'steer' && ph.opener.at === i) opener = note; else blocks.push(note);
        }
      }
      if (calls.length > 0 && !folded) {
        const node = renderToolGroup
          ? renderToolGroup(calls, m, ctx)
          : calls.map(p => (
            <div key={p.toolCallId} className="kit-tool" data-state={toolRowState(p)} data-tool-call-id={p.toolCallId}>
              <span aria-hidden="true">{toolRowState(p) === 'done' ? '✓' : toolRowState(p) === 'failed' ? '!' : '·'}</span>
              <span>{toolRowLabel(p, m.parts)}</span>
              {toolSummary(p) && <span className="kit-tool-summary">· {toolSummary(p)}</span>}
            </div>
          ));
        if (node != null && node !== false) work.push(<div key={`${m.id}:g${callsAt}`}>{node}</div>);
      }
      const text = ph.answerAt >= 0 ? m.parts[ph.answerAt] as ChatTextPart : null;
      const live = ctx.streaming && !ph.settled;
      const results = ph.settled ? renderPhaseResults?.(m, ph, ctx) : null;
      return (
        <div key={`${m.id}:${ph.key}`} className="kit-phase" data-phase={ph.key} data-closed={ph.closer?.kind}>
          {opener}
          {text && (
            <div key="answer" className="kit-answer" data-testid="kit-answer" data-answer={live ? 'live' : 'settled'} aria-busy={live || undefined}>
              {renderText(text.text, m, text)}
            </div>
          )}
          {blocks}
          {closing}
          {results != null && results !== false && <div key="results" className="kit-phase-results">{results}</div>}
        </div>
      );
    });
    return [
      ...(work.length > 0 ? [<div key={`${m.id}:work`} className="kit-turn-work">{work}</div>] : []),
      ...frames,
      ...errors,
    ];
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
        const folded = foldLine != null && !foldOpen;
        return (
          <div key={m.id} className="kit-msg" data-role={m.role} data-message-id={m.id} data-streaming={streaming || undefined} data-folded={folded || undefined} data-compose={turnMode && m.role === 'assistant' ? 'turn' : undefined}>
            {head(m, ctx)}
            {m.role === 'assistant' && (foldLine != null
              ? <ThinkingPanel steps={steps} streaming={false} summary={foldLine} open={foldOpen} onToggle={open => turnFold!.onToggle(m, open)} />
              : !answering && (
                <ThinkingPanel
                  steps={steps}
                  streaming={streaming}
                  name={thinkingName}
                  renderPinned={renderPinnedStep ? s => renderPinnedStep(s, m) : undefined}
                  // `turn`: a turn with steps keeps its line through the answer, so the line it folds to is already there.
                  holdLine={turnMode && steps.some(s => s.id !== THINKING_TAIL_ID)}
                />
              ))}
            {turnMode && m.role === 'assistant' ? turnOf(m, ctx, folded) : partsOf(m, ctx, folded)}
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
