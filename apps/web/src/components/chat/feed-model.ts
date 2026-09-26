/**
 * Pure derivations for the chat feed (docs/design/agent-chat.md, "Tool calls
 * you can see"): message parts → render segments, a tool part → its one-line
 * row, and which object the docked pane follows.
 */
import {
  CHAT_READ_TOOLS, chatToolNeedsApproval, eventObjects, isEventPart, isTextPart, isToolPart, objectsOf, refKey, toolNameOf,
  type BuilddObjectRef, type ChatEventData, type ChatMessage, type ChatPart, type ChatToolPart,
} from './chat-contract';

// ── Tool classes ─────────────────────────────────────────────────────────────

/** The read class (shared contract): runs straight away, shown as rows. */
const READ_TOOLS: ReadonlySet<string> = new Set<string>(CHAT_READ_TOOLS);
const READ_MISSION_ACTIONS: ReadonlySet<string> = new Set(['list', 'get', 'get_criteria_state']);

export function toolAction(part: ChatToolPart): string | null {
  const input = part.input as Record<string, unknown> | undefined;
  const a = input && typeof input === 'object' ? input.action : undefined;
  return typeof a === 'string' && a.trim() ? a.trim() : null;
}

export function isReadTool(part: ChatToolPart): boolean {
  const name = toolNameOf(part);
  if (chatToolNeedsApproval(name, part.input)) return false;
  if (name === 'manage_missions') {
    const a = toolAction(part);
    return a !== null && READ_MISSION_ACTIONS.has(a);
  }
  return READ_TOOLS.has(name);
}

// ── One row per call ─────────────────────────────────────────────────────────

export type ToolRowState = 'running' | 'done' | 'failed' | 'denied' | 'awaiting' | 'approved';

export function toolRowState(part: ChatToolPart): ToolRowState {
  switch (part.state) {
    case 'input-streaming':
    case 'input-available':
      return 'running';
    case 'approval-requested':
      return 'awaiting';
    case 'approval-responded':
      return part.approval?.approved === false ? 'denied' : 'approved';
    case 'output-available':
      return 'done';
    case 'output-error':
      return 'failed';
    case 'output-denied':
      return 'denied';
    default:
      return 'running';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Args that say nothing to a reader, or are the verb already. */
const SKIP_ARGS: ReadonlySet<string> = new Set(['action', 'workspaceId', 'teamId', 'conversationId', 'limit', 'offset', 'cursor']);
/** Args that name the subject, in the order a reader wants them. */
const PREFERRED_ARGS = ['workspace', 'title', 'query', 'status', 'mission', 'task', 'repo', 'prNumber', 'key', 'content'];

function shortValue(v: unknown): string | null {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s+/g, ' ').trim();
  if (!s || UUID_RE.test(s)) return null;
  return s.length > 40 ? `${s.slice(0, 39)}…` : s;
}

/** Up to two short, human-meaningful argument values. UUIDs and paging args are dropped. */
export function keyArgs(input: unknown, max = 2): string[] {
  if (!input || typeof input !== 'object') return [];
  const rec = input as Record<string, unknown>;
  const keys = Object.keys(rec).filter(k => !SKIP_ARGS.has(k));
  keys.sort((a, b) => {
    const ia = PREFERRED_ARGS.indexOf(a);
    const ib = PREFERRED_ARGS.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  const out: string[] = [];
  for (const k of keys) {
    const v = shortValue(rec[k]);
    if (v) out.push(v);
    if (out.length >= max) break;
  }
  return out;
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

export interface ToolRowView {
  id: string;
  name: string;
  action: string | null;
  args: string[];
  state: ToolRowState;
  result: string | null;
  readOnly: boolean;
  input: unknown;
  output: unknown;
  errorText?: string;
}

export function toolRowView(part: ChatToolPart): ToolRowView {
  return {
    id: part.toolCallId,
    name: toolNameOf(part),
    action: toolAction(part),
    args: keyArgs(part.input),
    state: toolRowState(part),
    result: toolResultLine(part),
    readOnly: isReadTool(part),
    input: part.input,
    output: part.output,
    errorText: part.errorText,
  };
}

// ── Segments ─────────────────────────────────────────────────────────────────

export type FeedSegment =
  | { kind: 'text'; key: string; text: string; streaming: boolean }
  | { kind: 'tools'; key: string; calls: ChatToolPart[] }
  | { kind: 'approval'; key: string; part: ChatToolPart }
  | { kind: 'event'; key: string; event: ChatEventData['event']; text: string }
  | { kind: 'objects'; key: string; refs: BuilddObjectRef[] };

/** A part that asks for, or has had, a human decision renders as the approval card itself. */
export function isApprovalPart(part: ChatToolPart): boolean {
  return part.state === 'approval-requested' || part.approval !== undefined;
}

/**
 * Message parts → what the feed draws, in order. Consecutive calls group under
 * one header; `step-start` and other non-visual parts don't break a group. The
 * objects a group returned render as cards right after it, once per object.
 */
export function feedSegments(parts: readonly ChatPart[]): FeedSegment[] {
  const out: FeedSegment[] = [];
  let group: ChatToolPart[] = [];
  const shown = new Set<string>();

  const pushObjects = (calls: ChatToolPart[], key: string) => {
    const refs: BuilddObjectRef[] = [];
    for (const c of calls) {
      for (const r of objectsOf(c)) {
        const k = refKey(r);
        if (shown.has(k)) continue;
        shown.add(k);
        refs.push(r);
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
      out.push({ kind: 'event', key: `event-${i}`, event: p.data.event, text: p.data.text });
      const refs = eventObjects(p.data).filter(r => !shown.has(refKey(r)));
      refs.forEach(r => shown.add(refKey(r)));
      if (refs.length > 0) out.push({ kind: 'objects', key: `obj-event-${i}`, refs });
    }
  });
  flush();
  return out;
}

export interface ToolGroupSummary {
  count: number;
  readOnly: boolean;
  running: number;
  failed: number;
}

export function toolGroupSummary(calls: readonly ChatToolPart[]): ToolGroupSummary {
  const views = calls.map(toolRowView);
  return {
    count: views.length,
    readOnly: views.every(v => v.readOnly),
    running: views.filter(v => v.state === 'running').length,
    failed: views.filter(v => v.state === 'failed').length,
  };
}

// ── What the pane follows ────────────────────────────────────────────────────

/** Kinds that have a full view worth docking. */
const PANE_KINDS: ReadonlySet<string> = new Set(['mission', 'task', 'pr', 'question']);

/** Every object ref in the conversation, oldest first, each once (its latest mention wins the order). */
export function conversationRefs(messages: readonly ChatMessage[]): BuilddObjectRef[] {
  const order = new Map<string, BuilddObjectRef>();
  for (const m of messages) {
    for (const p of m.parts) {
      const refs = isToolPart(p) ? objectsOf(p) : isEventPart(p) ? eventObjects(p.data) : [];
      for (const r of refs) {
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
