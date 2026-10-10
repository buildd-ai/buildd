'use client';

/**
 * The conversation: your messages on the right, the agent's turns on the
 * left. The list is the kit's `ChatThread` (@builddai/ai-kit/chat/react) with
 * `compose="turn"`: every assistant turn has the same fixed regions, so a
 * streamed word, a tool finishing or a card loading never moves what is
 * already on screen (docs/specs/chat-stream-composition.md):
 *
 *   head (avatar, name, time)       drawn while streaming too
 *   work line                       live step → "Writing the answer" → folded line
 *   tool rows                       only when the folded line is opened
 *   phase: answer slot              the phase's latest prose, replaced in place
 *          approval card + receipt  the card that closed the phase, rationale above it
 *          results                  Created / Referenced groups, once settled
 *   next phase (after a decision)   the reply, a new answer slot below the card
 *   footer                          a directive to save, the thumbs
 *
 * What is buildd's, through the thread's slots:
 * - `renderText`: markdown in the voice face (a caret trails the streaming
 *   paragraph); a person's message is their bubble.
 * - `renderTool`: approvals as buildd's card (one card of rows for several),
 *   with the objects they filed under them (feed-model.ts `turnLayout` receipts).
 * - `renderToolGroup`: the phase's calls as the kit's `ToolCallGroup` with
 *   buildd's hooks (`BUILDD_TOOL_CALLS`), under the unfolded line.
 * - `renderPhaseResults`: the phase's `turnLayout` groups: each write's
 *   objects under "Created", what the answer cites under "Referenced" in the
 *   order it names them, the rest of a list as one folded row.
 * - `eventPartType` / `renderEvent`: lifecycle events (`data-buildd-event`)
 *   as their line or a fired watch's notice, with their objects.
 * - `steps` / `thinkingName`: the turn in flight is one live line drawn from
 *   the `data-step` parts the server streams (lib/chat/thinking-steps.ts),
 *   steps in plain words, never a tool's name. A key step pinned under it
 *   stays a row: its object mounts once, in the results.
 * - `turnFold`: once the turn is done its steps and tool rows fold to one line
 *   ("Did 6 steps · filed 2 tasks", feed-model.ts `turnFoldSummary`).
 *
 * Conversation is soft on desktop; on a phone the person's message is a
 * raised square block. Fleet objects stay hard and square
 * (knowledge-base: buildd/design/chat-canvas.md). Styles: globals.css, "Thread on the kit".
 */
import { memo, useMemo, useState } from 'react';
import { ChatThread, ToolCallGroup, thinkingSteps, type ChatStatus, type ThreadMessageContext, type TurnFold, type TurnPhase } from '@builddai/ai-kit/chat/react';
import type { ChatMessage as KitMessage, ChatTextPart, StepData } from '@builddai/ai-kit/chat/contract';
import MarkdownContent from '@/components/MarkdownContent';
import { ZonedTime } from '@/components/DisplayTimezone';
import { CHAT_EVENT_PART_TYPE, isToolPart, messageMeta, type BuilddObjectRef, type ChatMessage, type ChatToolPart } from './chat-contract';
import { legacyStepWeight } from '@/lib/chat/thinking-steps';
import { BUILDD_TOOL_CALLS, eventRefsShownLater, feedSegments, intentTag, isApprovalPart, turnFoldSummary, turnLayout, type FeedSegment, type TurnLayout } from './feed-model';
import ApprovalCard, { ApprovalRows, approvalRows } from './ApprovalCard';
import { ObjectsSegment, ResultGroupView } from './objects/registry';
import WatchNotice from './WatchNotice';
import DirectiveCards from './DirectiveCard';
import TurnFeedback from './TurnFeedback';
import { visualPhaseTone, type VisualReviewTone } from '@/components/visual-review/VisualReviewLine';
import { VISUAL_REVIEW_PHASES, type VisualReviewPhase } from '@buildd/shared';

export interface ChatAgent {
  name: string;
  /** The role's own colour (workspaceSkills.color). */
  color: string | null;
}

export function AgentAvatar({ agent, size = 'md' }: { agent: ChatAgent; size?: 'xs' | 'sm' | 'md' }) {
  const dim = size === 'xs' ? 'h-5 w-5 text-[11px]' : size === 'sm' ? 'h-7 w-7 text-[13px]' : 'h-9 w-9 text-[15px]';
  const isBuildd = agent.name === 'buildd';
  const color = isBuildd ? null : agent.color;
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center font-mono font-bold ${dim} ${color ? 'text-white' : 'bg-text-primary text-surface-1'}`}
      style={color ? { background: color } : undefined}
    >
      {isBuildd ? '✳' : agent.name.charAt(0).toUpperCase()}
    </span>
  );
}

const TONE_DOT: Record<VisualReviewTone, string> = {
  needs: 'bg-accent',
  attention: 'bg-status-error',
  blocked: 'bg-status-error',
  working: 'bg-status-warning',
  done: 'bg-status-success',
  quiet: 'bg-text-muted',
};

/** A visual_review event's tone, from the phase it was posted in (the Screens line's own scale). */
export function eventTone(seg: Extract<FeedSegment, { kind: 'event' }>): VisualReviewTone | null {
  if (seg.event !== 'visual_review' || !seg.visual) return null;
  const phase = seg.visual.phase as VisualReviewPhase;
  return (VISUAL_REVIEW_PHASES as readonly string[]).includes(phase) ? visualPhaseTone(phase) : 'quiet';
}

/** The event row's square. A missing browser runner reads red here, as on the pinned chip. */
export function eventDotClass(seg: Extract<FeedSegment, { kind: 'event' }>): string {
  const tone = eventTone(seg);
  if (tone) return TONE_DOT[tone];
  return seg.event === 'mission_failed' ? 'bg-status-error' : seg.event === 'question' ? 'bg-status-warning' : seg.event === 'mission_completed' ? 'bg-status-success' : 'bg-accent';
}

/** What an event message draws: its line (or a fired watch's notice) and the objects it names. */
function EventSegments({ segs }: { segs: readonly FeedSegment[] }) {
  return (
    <>
      {segs.map(s => {
        if (s.kind === 'watch') return <WatchNotice key={s.key} text={s.text} notice={s.notice} />;
        if (s.kind === 'objects') return <ObjectsSegment key={s.key} refs={s.refs} />;
        if (s.kind !== 'event') return null;
        return (
          <div key={s.key} data-testid="feed-event" data-event={s.event} data-tone={eventTone(s) ?? undefined} className="flex items-start gap-2 font-mono text-[12px] text-text-secondary">
            <span aria-hidden="true" className={`mt-[5px] h-2 w-2 shrink-0 ${eventDotClass(s)}`} />
            <span className="min-w-0 [overflow-wrap:anywhere]">{s.text}</span>
          </div>
        );
      })}
    </>
  );
}

/**
 * The tiny tag under a message: where the reply went. Tapping it opens the
 * composer's scope. It carries its own ground chip: small text straight on the
 * sea's brightest pool would drop below AA.
 */
function IntentTag({ label }: { label: string }) {
  return (
    <button
      type="button"
      data-testid="feed-intent-tag"
      onClick={() => (document.querySelector('[data-testid="composer-scope-chip"]') as HTMLElement | null)?.click()}
      className="min-h-6 bg-[var(--chat-ground)] px-1.5 font-mono text-[11px] lg:text-[10px] tracking-[.08em] text-[var(--chat-muted)] hover:text-[var(--chat-text)]"
    >
      {label}
    </button>
  );
}

/**
 * The person's message: a raised square block with an offset shadow, in the
 * voice face, at every width (desktop only caps it at 590px).
 */
const UserBubble = memo(function UserBubble({ text }: { text: string }) {
  return (
    <div data-testid="feed-user-bubble" className="ml-auto w-fit max-w-[82%] whitespace-pre-wrap border border-[var(--chat-rule-strong)] bg-[var(--chat-raised)] px-4 py-3 font-voice text-[17px] leading-[1.4] text-[var(--chat-text)] shadow-[3px_3px_0_0_var(--chat-rule)] [overflow-wrap:anywhere] lg:max-w-[590px]">
      {text}
    </div>
  );
});

/** Buildd speaks in the voice face, finished or thinking (knowledge-base: buildd/design/chat-v3-desktop.md, thinking frame). */
function AgentText({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <div data-testid="feed-text" className="font-voice text-[17px] leading-[1.45] text-[var(--chat-text)] lg:max-w-[640px]">
      {/* While streaming, a solid block caret trails the last paragraph (inline, not a new line). */}
      <MarkdownContent
        content={text}
        images="link"
        className={`!text-[17px] !leading-[1.45] !text-[var(--chat-text)] [&_code]:!bg-[var(--convo-me)] ${streaming ? 'stream-caret' : ''}`}
      />
    </div>
  );
}

/**
 * The turn's steps: its `data-step` parts, which the server streams (a
 * continuation of an older message gets them backfilled there), so every
 * message that can be streaming carries them. Live while it streams; once it
 * is done they sit under the folded line. A step saved before the server
 * weighed them gets the stored-step rule (failures and waiting changes key).
 */
function turnSteps(m: KitMessage, streaming: boolean): StepData[] {
  return thinkingSteps(m.parts, streaming).map(s => (s.weight ? s : { ...s, weight: legacyStepWeight(s) }));
}

export default function ChatFeed({
  messages,
  agent,
  status = 'ready',
  error,
}: {
  messages: readonly ChatMessage[];
  agent: ChatAgent;
  /**
   * The turn's status (`useChat`). `submitted` with the person's message last
   * shows the Thinking panel on its own; `submitted` / `streaming` draw the
   * latest assistant turn as the panel.
   */
  status?: ChatStatus;
  error?: string | null;
}) {
  const hidden = useMemo(() => eventRefsShownLater(messages), [messages]);
  // Finished turns the person unfolded. Held here, so a re-render never folds one back.
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(() => new Set());
  const turnFold: TurnFold = {
    summary: (m, steps) => turnFoldSummary((m as ChatMessage).parts, steps.length),
    isOpen: m => unfolded.has(m.id),
    onToggle: (m, open) => setUnfolded(prev => {
      const next = new Set(prev);
      if (open) next.add(m.id); else next.delete(m.id);
      return next;
    }),
  };
  // One layout per message and render (feed-model.ts `turnLayout`): which
  // group each object belongs to, and what each approval card filed.
  const layouts = new Map<string, TurnLayout>();
  const layoutOf = (m: ChatMessage) => {
    let l = layouts.get(m.id);
    if (!l) { l = turnLayout(m.parts); layouts.set(m.id, l); }
    return l;
  };
  // A message's writes as one card's rows (two or more), drawn at the first.
  const rowGroups = new Map<string, ReturnType<typeof approvalRows>>();
  const rowsOf = (m: ChatMessage) => {
    if (!rowGroups.has(m.id)) rowGroups.set(m.id, approvalRows(m.parts.filter(isToolPart)));
    return rowGroups.get(m.id)!;
  };
  const receipt = (m: ChatMessage, callIds: readonly string[]) => {
    const refs: BuilddObjectRef[] = callIds.flatMap(id => layoutOf(m).receipts.get(id) ?? []);
    return refs.length > 0 ? <ObjectsSegment refs={refs} /> : null;
  };

  const header = (km: KitMessage, ctx: ThreadMessageContext) => {
    const m = km as ChatMessage;
    const meta = messageMeta(m);
    if (m.role === 'user') {
      return (
        <div data-testid="feed-message-meta" className="ml-auto flex items-center gap-2 px-1 font-mono text-[11px] text-text-muted">
          {meta.authorName && <span className="text-text-secondary">{meta.authorName}</span>}
          {meta.createdAt && <ZonedTime value={meta.createdAt} format="time" />}
        </div>
      );
    }
    // Drawn while the turn streams too: the turn's frame is the same from its first chunk to its last.
    return (
      <>
        <AgentAvatar agent={agent} size="sm" />
        <div className="flex min-h-7 items-center gap-2 font-mono text-[11.5px] text-text-muted">
          <span className="font-semibold text-text-secondary">{agent.name}</span>
          {meta.createdAt && <ZonedTime value={meta.createdAt} format="time" />}
          {meta.durationMs != null && <span>{`· ${(meta.durationMs / 1000).toFixed(1)}s`}</span>}
        </div>
      </>
    );
  };

  const footer = (km: KitMessage, ctx: ThreadMessageContext) => {
    const m = km as ChatMessage;
    if (m.role === 'user') {
      const tag = intentTag(messages, ctx.index);
      return tag ? <IntentTag label={tag.label} /> : null;
    }
    if (m.role !== 'assistant') return null;
    return (
      <>
        {/* A standing rule the person just stated, offered for one-tap saving. */}
        <DirectiveCards parts={m.parts} messageId={m.id} />
        <TurnFeedback messageId={m.id} />
      </>
    );
  };

  return (
    <div data-testid="chat-feed">
      <ChatThread
        className="buildd-thread"
        messages={messages as readonly KitMessage[]}
        status={status}
        error={error || undefined}
        label="Conversation"
        eventPartType={CHAT_EVENT_PART_TYPE}
        renderText={(text: string, km: KitMessage, part: ChatTextPart) => {
          if (!text.trim()) return null;
          if (km.role === 'user') return <UserBubble text={text} />;
          return <AgentText text={text} streaming={part.state === 'streaming'} />;
        }}
        renderTool={(part: ChatToolPart, km: KitMessage) => {
          // Approvals (asked, answered, or decided) are buildd's card, then what the write filed.
          if (!isApprovalPart(part) && !part.approval && part.state !== 'output-denied') return undefined;
          const group = rowsOf(km as ChatMessage);
          const members = new Set(group ? [...group.rows, ...group.held].map(p => p.toolCallId) : []);
          if (group && members.has(part.toolCallId)) {
            // Drawn at the first of them; the others are already on the card.
            const first = km.parts.find(p => isToolPart(p as ChatToolPart) && members.has((p as ChatToolPart).toolCallId)) as ChatToolPart;
            if (first.toolCallId !== part.toolCallId) return null;
            return (
              <>
                <ApprovalRows group={group} />
                {receipt(km as ChatMessage, group.rows.map(p => p.toolCallId))}
              </>
            );
          }
          return (
            <>
              <ApprovalCard part={part} />
              {receipt(km as ChatMessage, [part.toolCallId])}
            </>
          );
        }}
        renderToolGroup={(parts: readonly ChatToolPart[], _km: KitMessage, ctx: ThreadMessageContext) => {
          // While the turn streams, the live line says what the calls are doing.
          if (ctx.streaming) return null;
          return <ToolCallGroup calls={parts.filter(isToolPart)} {...BUILDD_TOOL_CALLS} />;
        }}
        renderPhaseResults={(km: KitMessage, phase: TurnPhase) => {
          const groups = layoutOf(km as ChatMessage).results.get(phase.key) ?? [];
          return groups.length > 0 ? groups.map(g => <ResultGroupView key={g.key} group={g} />) : null;
        }}
        renderEvent={(_data, km: KitMessage) => <EventSegments segs={feedSegments((km as ChatMessage).parts, { hideEventRefs: hidden.get(km.id) })} />}
        renderMessageHeader={header}
        renderMessageFooter={footer}
        steps={turnSteps}
        thinkingName={`${agent.name.charAt(0).toUpperCase()}${agent.name.slice(1)} is working`}
        turnFold={turnFold}
        answer="replace"
        compose="turn"
      />
    </div>
  );
}

