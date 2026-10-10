/**
 * Pure derivations for the chat feed (knowledge-base: buildd/design/agent-chat.md, "Tool calls
 * you can see"): message parts → render segments, a tool part → its one-line
 * row, and which object the docked pane follows.
 */
import {
  chatToolIsRead, chatToolNeedsApproval, eventObjects, isEventPart, isTextPart, isToolPart, messageMeta, objectsOf, refKey, toolNameOf,
  type BuilddObjectRef, type ChatEventData, type ChatMessage, type ChatPart, type ChatToolPart,
} from './chat-contract';
import type { ChatPart as KitPart } from '@builddai/ai-kit/chat/contract';
import {
  composeTurn, keyArgs as kitKeyArgs, toolCallState, toolCallView, toolGroupSummary as kitToolGroupSummary,
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

/** What an event message draws (`role: 'event'`). */
export type FeedSegment =
  | { kind: 'event'; key: string; event: ChatEventData['event']; text: string; visual?: ChatEventData['visual'] }
  /** A watch the person set fired: its own notice card, not a status line. */
  | { kind: 'watch'; key: string; text: string; notice: NonNullable<ChatEventData['watch']> }
  | { kind: 'objects'; key: string; refs: BuilddObjectRef[] };

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
 * An event message's parts → what the feed draws: its line (or a fired
 * watch's notice) and the objects it names, minus those a later message shows.
 * An assistant turn is laid out by `turnLayout` instead.
 */
export function feedSegments(parts: readonly ChatPart[], opts: { hideEventRefs?: ReadonlySet<string> } = {}): FeedSegment[] {
  const out: FeedSegment[] = [];
  const shown = new Set<string>();
  parts.forEach((p, i) => {
    if (!isEventPart(p)) return;
    if (p.data.event === 'watch' && p.data.watch) {
      out.push({ kind: 'watch', key: `watch-${i}`, text: p.data.text, notice: p.data.watch });
      return;
    }
    out.push({ kind: 'event', key: `event-${i}`, event: p.data.event, text: p.data.text, ...(p.data.visual ? { visual: p.data.visual } : {}) });
    const refs = eventObjects(p.data).filter(r => !shown.has(refKey(r)) && !opts.hideEventRefs?.has(refKey(r)));
    refs.forEach(r => shown.add(refKey(r)));
    if (refs.length > 0) out.push({ kind: 'objects', key: `obj-event-${i}`, refs });
  });
  return out;
}

// ── An assistant turn's results ──────────────────────────────────────────────

/**
 * What one phase of a turn produced (docs/specs/chat-stream-composition.md),
 * drawn after its answer once the phase is settled:
 * - `created`: one write's objects, together under one line ("Created · 2 tasks").
 * - `referenced`: what the phase's reads returned that the answer stands on:
 *   `refs` as cards in the order the answer names them, `more` the rest of a
 *   list, folded into one row.
 */
export type ResultGroup =
  | { kind: 'created'; key: string; callId: string; label: string; refs: BuilddObjectRef[] }
  | { kind: 'referenced'; key: string; refs: BuilddObjectRef[]; more: BuilddObjectRef[] };

export interface TurnLayout {
  /** Per phase (`TurnPhase.key`): its groups, in draw order. Every phase has an entry. */
  results: Map<string, ResultGroup[]>;
  /** Per approval call: the objects its card shows under it, the receipt. */
  receipts: Map<string, BuilddObjectRef[]>;
}

const CREATE_VERB = /create|file|add|new|open|start|schedule|watch|launch|spawn|draft/i;

/** The verb a write's group goes under: what it did, never the tool's name. */
function writeLabel(part: ChatToolPart): string {
  const verb = `${toolAction(part) ?? ''} ${toolNameOf(part)}`;
  return CREATE_VERB.test(verb) ? 'Created' : 'Updated';
}

/** Where in the answer it names this object: its id, short id or title. -1: not named. */
function namedAt(answer: string, r: BuilddObjectRef): number {
  if (!textNames(answer, r)) return -1;
  const lower = answer.toLowerCase();
  const at = [r.id, r.id.length > 8 ? r.id.slice(0, 8) : '', r.title?.trim() ?? '']
    .filter(Boolean).map(s => lower.indexOf(s.toLowerCase())).filter(i => i >= 0);
  return at.length > 0 ? Math.min(...at) : 0;
}

/**
 * A turn's results, per phase (the kit's `composeTurn`, so the phases are the
 * ones the thread draws). Pure and append-stable: each object is drawn once
 * per turn, at its first place in this order: a phase's writes, then its
 * reads, then the card that closed it. A decision never takes back what the
 * phase already cites, so a settled phase's groups never change.
 *
 * A read's objects are cited when the read fetched one thing, when they are
 * PRs (they stack as one list), or when the answer names them; the rest of a
 * list folds into `more`. Writes and approvals show everything they returned.
 */
export function turnLayout(parts: readonly ChatPart[], opts: { streaming?: boolean } = {}): TurnLayout {
  const { phases } = composeTurn(parts as KitPart[], opts);
  const results = new Map<string, ResultGroup[]>();
  const receipts = new Map<string, BuilddObjectRef[]>();
  const shown = new Set<string>();
  const fresh = (refs: readonly BuilddObjectRef[]) => refs.filter(r => {
    const k = refKey(r);
    if (shown.has(k)) return false;
    shown.add(k);
    return true;
  });
  for (const ph of phases) {
    const calls = parts.slice(ph.from, ph.to).filter(isToolPart);
    const answer = ph.answerAt >= 0 ? (parts[ph.answerAt] as { text: string }).text : '';
    const groups: ResultGroup[] = [];
    for (const c of calls) {
      if (isApprovalPart(c) || isReadTool(c)) continue;
      const refs = fresh(objectsOf(c));
      if (refs.length > 0) groups.push({ kind: 'created', key: `made-${c.toolCallId}`, callId: c.toolCallId, label: writeLabel(c), refs });
    }
    const cited: Array<{ r: BuilddObjectRef; at: number; seq: number }> = [];
    const rest: BuilddObjectRef[] = [];
    let seq = 0;
    for (const c of calls) {
      if (isApprovalPart(c) || !isReadTool(c)) continue;
      const objs = objectsOf(c);
      for (const r of objs) {
        const at = namedAt(answer, r);
        if (objs.length === 1 || r.kind === 'pr' || at >= 0) cited.push({ r, at, seq: seq++ });
      }
    }
    // Named in the answer's order first, then the rest as they were read.
    cited.sort((a, b) => (a.at < 0 ? 1 : 0) - (b.at < 0 ? 1 : 0) || (a.at >= 0 && b.at >= 0 ? a.at - b.at : 0) || a.seq - b.seq);
    const refs = fresh(cited.map(c => c.r));
    for (const c of calls) {
      if (isApprovalPart(c) || !isReadTool(c)) continue;
      rest.push(...fresh(objectsOf(c)));
    }
    if (refs.length > 0 || rest.length > 0) groups.push({ kind: 'referenced', key: `ref-${ph.key}`, refs, more: rest });
    for (const c of calls) if (isApprovalPart(c)) receipts.set(c.toolCallId, fresh(objectsOf(c)));
    results.set(ph.key, groups);
  }
  return { results, receipts };
}

/** The cards a message draws (approval receipts, created, cited) and what it only folded, in draw order. */
export function shownRefs(m: ChatMessage): { cards: BuilddObjectRef[]; more: BuilddObjectRef[] } {
  if (m.role !== 'assistant') return { cards: feedSegments(m.parts).flatMap(s => (s.kind === 'objects' ? s.refs : [])), more: [] };
  const { phases } = composeTurn(m.parts as KitPart[]);
  const layout = turnLayout(m.parts);
  const cards: BuilddObjectRef[] = [];
  const more: BuilddObjectRef[] = [];
  for (const ph of phases) {
    for (const p of m.parts.slice(ph.from, ph.to)) if (isToolPart(p)) cards.push(...(layout.receipts.get(p.toolCallId) ?? []));
    for (const g of layout.results.get(ph.key) ?? []) {
      cards.push(...g.refs);
      if (g.kind === 'referenced') more.push(...g.more);
    }
  }
  return { cards, more };
}

// ── A finished turn, folded ──────────────────────────────────────────────────

const FILED_NOUN: Record<string, [string, string]> = {
  task: ['task', 'tasks'], mission: ['mission', 'missions'], pr: ['pull request', 'pull requests'], question: ['question', 'questions'],
};

/**
 * The one line a finished turn folds to: "Did 6 steps · filed 2 tasks".
 * Steps are the server's `data-step` count, else the turn's calls; what it
 * filed is every object a write returned (approvals included), each once.
 * Null when the turn did nothing to fold (a plain answer).
 */
export function turnFoldSummary(parts: readonly ChatPart[], steps: number): string | null {
  const calls = parts.filter(isToolPart).filter(p => !isApprovalPart(p));
  const n = steps > 0 ? steps : calls.length;
  if (n === 0) return null;
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  for (const p of parts) {
    if (!isToolPart(p) || isReadTool(p)) continue;
    for (const r of objectsOf(p)) {
      const k = refKey(r);
      if (seen.has(k)) continue;
      seen.add(k);
      counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
    }
  }
  const filed = [...counts.entries()]
    .map(([kind, c]) => `${c} ${(FILED_NOUN[kind] ?? [kind, `${kind}s`])[c === 1 ? 0 : 1]}`)
    .join(', ');
  return `Did ${n} step${n === 1 ? '' : 's'}${filed ? ` · filed ${filed}` : ''}`;
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
    const { cards, more } = shownRefs(m);
    for (const r of [...cards, ...more]) later.add(refKey(r));
  }
  return out;
}

export function conversationRefs(messages: readonly ChatMessage[]): BuilddObjectRef[] {
  const order = new Map<string, BuilddObjectRef>();
  for (const m of messages) {
    for (const r of shownRefs(m).cards) {
      const k = refKey(r);
      order.delete(k);
      order.set(k, r);
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
