/**
 * Pure derivations for the chat feed (docs/design/agent-chat.md, "Tool calls
 * you can see"): message parts → render segments, a tool part → its one-line
 * row, and which object the docked pane follows.
 */
import {
  chatToolIsRead, chatToolNeedsApproval, eventObjects, isEventPart, isTextPart, isToolPart, messageMeta, objectsOf, refKey, toolNameOf,
  type BuilddObjectRef, type ChatEventData, type ChatMessage, type ChatPart, type ChatToolPart,
} from './chat-contract';
import {
  keyArgs as kitKeyArgs, toolCallState, toolCallView, toolGroupSummary as kitToolGroupSummary,
  type KeyArgsOptions, type ToolCallOptions, type ToolCallState, type ToolCallView, type ToolGroupSummary,
} from '@builddai/ai-kit/chat/react';

// ── Tool classes ─────────────────────────────────────────────────────────────

/** The read class (shared contract): runs straight away, shown as rows. */

export function toolAction(part: ChatToolPart): string | null {
  const input = part.input as Record<string, unknown> | undefined;
  const a = input && typeof input === 'object' ? input.action : undefined;
  return typeof a === 'string' && a.trim() ? a.trim() : null;
}

export function isReadTool(part: ChatToolPart): boolean {
  const name = toolNameOf(part);
  if (chatToolNeedsApproval(name, part.input)) return false;
  return chatToolIsRead(name, part.input);
}

// ── One row per call ─────────────────────────────────────────────────────────
// The row itself is the kit's (`ToolCallRow` / `ToolCallGroup`,
// @builddai/ai-kit/chat/react); buildd supplies which args are key, which
// calls are reads, and the result line (`BUILDD_TOOL_CALLS`).

export type ToolRowState = ToolCallState;
export const toolRowState = toolCallState;

/** Args that say nothing to a reader, or are the verb already; then the args that name the subject, in the order a reader wants them. */
export const BUILDD_KEY_ARGS: KeyArgsOptions = {
  skip: ['action', 'workspaceId', 'teamId', 'conversationId', 'limit', 'offset', 'cursor'],
  prefer: ['workspace', 'title', 'query', 'status', 'mission', 'task', 'repo', 'prNumber', 'key', 'content'],
};

/** Up to two short, human-meaningful argument values. UUIDs and paging args are dropped. */
export function keyArgs(input: unknown, max = 2): string[] {
  return kitKeyArgs(input, { ...BUILDD_KEY_ARGS, max });
}

function firstLine(s: string): string {
  const line = s.split('\n').find(l => l.trim()) ?? '';
  const t = line.trim();
  return t.length > 90 ? `${t.slice(0, 89)}…` : t;
}

/** The one-line result: the tool's own summary, else the objects it returned, else a count. */
export function toolResultLine(part: ChatToolPart): string | null {
  const state = toolRowState(part);
  if (state === 'failed') return part.errorText ? firstLine(part.errorText) : 'failed';
  if (state === 'denied') return 'nothing filed';
  if (state !== 'done') return null;
  const out = part.output as Record<string, unknown> | null | undefined;
  if (typeof out === 'string') return firstLine(out);
  if (!out || typeof out !== 'object') return 'done';
  if (typeof out.summary === 'string' && out.summary.trim()) return firstLine(out.summary);
  const data = out.data as Record<string, unknown> | unknown[] | undefined;
  if (data && !Array.isArray(data) && typeof data === 'object' && typeof (data as Record<string, unknown>).summary === 'string') {
    return firstLine((data as Record<string, unknown>).summary as string);
  }
  const objects = objectsOf(part);
  if (objects.length === 1) return firstLine(objects[0].fallbackText);
  if (objects.length > 1) return `${objects.length} results`;
  if (Array.isArray(data)) return data.length === 0 ? 'none' : `${data.length} result${data.length === 1 ? '' : 's'}`;
  return 'done';
}

export type ToolRowView = ToolCallView;

/** buildd's hooks for the kit's rich tool rows. */
export const BUILDD_TOOL_CALLS: ToolCallOptions = {
  keyArgs: BUILDD_KEY_ARGS,
  isReadOnly: isReadTool,
  result: toolResultLine,
};

export function toolRowView(part: ChatToolPart): ToolRowView {
  return toolCallView(part, BUILDD_TOOL_CALLS);
}

// ── Segments ─────────────────────────────────────────────────────────────────

export type FeedSegment =
  | { kind: 'text'; key: string; text: string; streaming: boolean }
  | { kind: 'tools'; key: string; calls: ChatToolPart[] }
  | { kind: 'approval'; key: string; part: ChatToolPart }
  | { kind: 'event'; key: string; event: ChatEventData['event']; text: string; visual?: ChatEventData['visual'] }
  /** A watch the person set fired: its own notice card, not a status line. */
  | { kind: 'watch'; key: string; text: string; notice: NonNullable<ChatEventData['watch']> }
  | { kind: 'objects'; key: string; refs: BuilddObjectRef[] }
  /** The rest of what the turn's list reads returned: one collapsed row, cards mount on open. */
  | { kind: 'more'; key: string; refs: BuilddObjectRef[] };

/** A part that asks for, or has had, a human decision renders as the approval card itself. */
export function isApprovalPart(part: ChatToolPart): boolean {
  return part.state === 'approval-requested' || part.approval !== undefined;
}

/** Titles shorter than this are too generic to match in prose ("recon", "fix"). */
const MIN_TITLE_MATCH = 12;

/** Does the reply name this object: its id, its 8-character short id, or its title? */
export function textNames(text: string, r: BuilddObjectRef): boolean {
  if (!text) return false;
  if (text.includes(r.id) || (r.id.length > 8 && text.includes(r.id.slice(0, 8)))) return true;
  const title = r.title?.trim();
  return !!title && title.length >= MIN_TITLE_MATCH && text.toLowerCase().includes(title.toLowerCase());
}

/**
 * Message parts → what the feed draws, in order. Consecutive calls group under
 * one header; `step-start` and other non-visual parts don't break a group.
 *
 * Answer first: a read's objects render after the reply, and as cards only the
 * ones the turn is about — an object fetched on its own (a get), one the reply
 * names, or a PR (PRs stack as one compact list). The rest of what a list
 * returned folds into one collapsed row, so "what's running?" isn't sixteen
 * cards ahead of a one-line answer. Objects from writes, approvals and events
 * render where they happen.
 */
export function feedSegments(parts: readonly ChatPart[], opts: { hideEventRefs?: ReadonlySet<string> } = {}): FeedSegment[] {
  const out: FeedSegment[] = [];
  let group: ChatToolPart[] = [];
  const shown = new Set<string>();
  const reply = parts.filter(isTextPart).map(p => p.text).join('\n');
  const featured: BuilddObjectRef[] = [];
  const rest: BuilddObjectRef[] = [];

  const take = (r: BuilddObjectRef, into: BuilddObjectRef[]) => {
    const k = refKey(r);
    if (shown.has(k)) return;
    shown.add(k);
    into.push(r);
  };
  const pushObjects = (calls: ChatToolPart[], key: string) => {
    const refs: BuilddObjectRef[] = [];
    for (const c of calls) {
      const objs = objectsOf(c);
      if (isReadTool(c)) {
        for (const r of objs) {
          if (objs.length === 1 || r.kind === 'pr' || textNames(reply, r)) take(r, featured);
        }
      } else {
        for (const r of objs) take(r, refs);
      }
    }
    if (refs.length > 0) out.push({ kind: 'objects', key: `obj-${key}`, refs });
  };
  const flush = () => {
    if (group.length === 0) return;
    const key = group[0].toolCallId;
    out.push({ kind: 'tools', key: `tools-${key}`, calls: group });
    pushObjects(group, key);
    group = [];
  };

  parts.forEach((p, i) => {
    if (isToolPart(p)) {
      if (isApprovalPart(p)) {
        flush();
        out.push({ kind: 'approval', key: `approval-${p.toolCallId}`, part: p });
        pushObjects([p], p.toolCallId);
      } else {
        group.push(p);
      }
      return;
    }
    if (isTextPart(p)) {
      if (!p.text.trim()) return;
      flush();
      out.push({ kind: 'text', key: `text-${i}`, text: p.text, streaming: p.state === 'streaming' });
      return;
    }
    if (isEventPart(p)) {
      flush();
      if (p.data.event === 'watch' && p.data.watch) {
        out.push({ kind: 'watch', key: `watch-${i}`, text: p.data.text, notice: p.data.watch });
        return;
      }
      out.push({ kind: 'event', key: `event-${i}`, event: p.data.event, text: p.data.text, ...(p.data.visual ? { visual: p.data.visual } : {}) });
      const refs = eventObjects(p.data).filter(r => !shown.has(refKey(r)) && !opts.hideEventRefs?.has(refKey(r)));
      refs.forEach(r => shown.add(refKey(r)));
      if (refs.length > 0) out.push({ kind: 'objects', key: `obj-event-${i}`, refs });
    }
  });
  flush();
  if (featured.length > 0) out.push({ kind: 'objects', key: 'obj-featured', refs: featured });
  // Second pass: list objects not featured, and not shown by a later get or write.
  for (const p of parts) {
    if (!isToolPart(p) || isApprovalPart(p) || !isReadTool(p)) continue;
    for (const r of objectsOf(p)) take(r, rest);
  }
  if (rest.length > 0) out.push({ kind: 'more', key: 'obj-more', refs: rest });
  return out;
}

export type { ToolGroupSummary };

export function toolGroupSummary(calls: readonly ChatToolPart[]): ToolGroupSummary {
  return kitToolGroupSummary(calls.map(toolRowView));
}

// ── What the pane follows ────────────────────────────────────────────────────

/** Kinds that have a full view worth docking. */
const PANE_KINDS: ReadonlySet<string> = new Set(['mission', 'task', 'pr', 'question']);

/**
 * Every object the feed shows as a card, oldest first, each once (its latest
 * mention wins the order). What a list read returned without the answer
 * naming it (the collapsed "Also read" row) is left out, so the tail of a
 * broad list never drives the pin or the pane.
 */
/**
 * Visual review events come in runs (waiting, round done, fixes filed) and all
 * name the same live mission. Each keeps its line, but its card shows only on
 * the newest message that names the mission: per event message, the refs a
 * later message shows.
 */
export function eventRefsShownLater(messages: readonly ChatMessage[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const later = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const isVisualEvent = m.role === 'event' && m.parts.some(p => isEventPart(p) && p.data.event === 'visual_review');
    if (isVisualEvent && later.size > 0) out.set(m.id, new Set(later));
    for (const seg of feedSegments(m.parts)) if (seg.kind === 'objects' || seg.kind === 'more') for (const r of seg.refs) later.add(refKey(r));
  }
  return out;
}

export function conversationRefs(messages: readonly ChatMessage[]): BuilddObjectRef[] {
  const order = new Map<string, BuilddObjectRef>();
  for (const m of messages) {
    for (const seg of feedSegments(m.parts)) {
      if (seg.kind !== 'objects') continue;
      for (const r of seg.refs) {
        const k = refKey(r);
        order.delete(k);
        order.set(k, r);
      }
    }
  }
  return [...order.values()];
}

/**
 * The object the docked pane shows: the pinned one while it's pinned, else the
 * most recently referenced object that has a full view. A question folds into
 * its mission's pane when that mission is in the conversation, so the pane
 * doesn't flip away from the board every time an agent asks something.
 */
export function paneFocus(
  messages: readonly ChatMessage[],
  pinned: BuilddObjectRef | null,
): BuilddObjectRef | null {
  if (pinned) return pinned;
  const refs = conversationRefs(messages).filter(r => PANE_KINDS.has(r.kind));
  if (refs.length === 0) return null;
  const last = refs[refs.length - 1];
  if (last.kind === 'question') {
    const mission = [...refs].reverse().find(r => r.kind === 'mission');
    if (mission) return mission;
  }
  return last;
}

/** A plain-text title for a conversation until the auto-title arrives. */
export function provisionalTitle(messages: readonly ChatMessage[]): string {
  const first = messages.find(m => m.role === 'user');
  const text = first?.parts.find(isTextPart)?.text?.replace(/\s+/g, ' ').trim() ?? '';
  if (!text) return 'New chat';
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

/**
 * The workspace the latest assistant turn was routed to, for the composer's
 * `→ name` chip. Null when it was pinned, unscoped, or the turn predates this
 * page load (the scope is streamed, not stored). Pure.
 */
export function routedScope(messages: readonly ChatMessage[]): { id: string; name: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const scope = messageMeta(m).scope;
    return scope && scope.source === 'routed' ? { id: scope.id, name: scope.name } : null;
  }
  return null;
}

/**
 * The tiny tag under a person's message: where the reply to it was scoped.
 * Read from the assistant message that directly follows; null when there is
 * none yet or it was unscoped. Pure.
 */
export function intentTag(messages: readonly ChatMessage[], index: number): { label: string; workspaceId: string } | null {
  const next = messages[index + 1];
  if (!next || next.role !== 'assistant') return null;
  const scope = messageMeta(next).scope;
  if (!scope) return null;
  return { label: `${scope.source} · ${scope.name}`, workspaceId: scope.id };
}

/**
 * What the canvas pins at its top (objects/PinnedObject.tsx): the object the
 * chat was opened about, else the latest mission the conversation touched,
 * else the latest task. PRs and questions render in the feed only. Pure.
 */
export function canvasPin(messages: readonly ChatMessage[], about: BuilddObjectRef | null): BuilddObjectRef | null {
  if (about) return about;
  const refs = conversationRefs(messages);
  for (const kind of ['mission', 'task'] as const) {
    const hit = [...refs].reverse().find(r => r.kind === kind);
    if (hit) return hit;
  }
  return null;
}
