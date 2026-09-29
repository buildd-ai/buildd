/**
 * Pure view model for the rich tool rows (`ToolCallRow` / `ToolCallGroup`,
 * 0.11.0): a tool part → its one-line row (the tool as the verb, its key
 * arguments, a live state and a one-line result), and a run of calls → the
 * group header ("3 tool calls · read-only"). No React, no DOM.
 *
 * Everything app-specific is a hook in `ToolCallOptions`: what a tool is
 * called, which arguments count as key, which calls are read-only, and the
 * result line. The defaults read only the contract (`ToolResult`).
 */
import { toolNameOf, type ChatToolPart } from '@builddai/ai-kit/chat/contract';

/** The row's state. Finer than `toolRowState`: an approved write still running is `approved`. */
export type ToolCallState = 'running' | 'awaiting' | 'approved' | 'done' | 'failed' | 'denied';

export function toolCallState(part: ChatToolPart): ToolCallState {
  switch (part.state) {
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

export interface KeyArgsOptions {
  /** Argument names never shown. Default `DEFAULT_KEY_ARG_SKIP`. */
  skip?: readonly string[];
  /** Argument names shown first, in this order; the rest follow in input order. */
  prefer?: readonly string[];
  /** At most this many values. Default 2. */
  max?: number;
}

/** Args that say nothing to a reader, or are the verb already. */
export const DEFAULT_KEY_ARG_SKIP: readonly string[] = ['action', 'limit', 'offset', 'cursor'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function shortValue(v: unknown): string | null {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s+/g, ' ').trim();
  if (!s || UUID_RE.test(s)) return null;
  return s.length > 40 ? `${s.slice(0, 39)}…` : s;
}

/** Up to `max` short, human-meaningful argument values. UUIDs, objects and skipped names are dropped. */
export function keyArgs(input: unknown, opts: KeyArgsOptions = {}): string[] {
  if (!input || typeof input !== 'object') return [];
  const skip = new Set(opts.skip ?? DEFAULT_KEY_ARG_SKIP);
  const prefer = opts.prefer ?? [];
  const max = opts.max ?? 2;
  const rec = input as Record<string, unknown>;
  const rank = (k: string) => (prefer.indexOf(k) === -1 ? prefer.length : prefer.indexOf(k));
  const keys = Object.keys(rec).filter(k => !skip.has(k)).sort((a, b) => rank(a) - rank(b));
  const out: string[] = [];
  for (const k of keys) {
    if (out.length >= max) break;
    const v = shortValue(rec[k]);
    if (v) out.push(v);
  }
  return out;
}

function firstLine(s: string): string {
  const t = (s.split('\n').find(l => l.trim()) ?? '').trim();
  return t.length > 90 ? `${t.slice(0, 89)}…` : t;
}

/**
 * The one-line result of a finished call: the `ToolResult` summary, else its
 * one object's fallback text or an object count, else a count of `data`.
 * Null while it runs or waits.
 */
export function toolCallResult(part: ChatToolPart): string | null {
  const state = toolCallState(part);
  if (state === 'failed') return part.errorText ? firstLine(part.errorText) : 'failed';
  if (state === 'denied') return 'nothing changed';
  if (state !== 'done') return null;
  const out = part.output as Record<string, unknown> | string | null | undefined;
  if (typeof out === 'string') return firstLine(out);
  if (!out || typeof out !== 'object') return 'done';
  if (typeof out.summary === 'string' && out.summary.trim()) return firstLine(out.summary);
  const data = out.data as Record<string, unknown> | unknown[] | undefined;
  if (data && !Array.isArray(data) && typeof data === 'object' && typeof data.summary === 'string' && data.summary.trim()) {
    return firstLine(data.summary);
  }
  const objects = Array.isArray(out.objects)
    ? out.objects.filter((o): o is { fallbackText: string } => !!o && typeof (o as { fallbackText?: unknown }).fallbackText === 'string')
    : [];
  if (objects.length === 1) return firstLine(objects[0].fallbackText);
  if (objects.length > 1) return `${objects.length} results`;
  if (Array.isArray(data)) return data.length === 0 ? 'none' : `${data.length} result${data.length === 1 ? '' : 's'}`;
  return 'done';
}

/** The app hooks for the rich rows. All optional. */
export interface ToolCallOptions {
  /** What a tool is called on its row (a label table). Null or omitted: the tool's name as is. */
  toolLabel?(name: string, part: ChatToolPart): string | null | undefined;
  /** Which arguments count as key: names to skip and prefer, or your own list per call. */
  keyArgs?: KeyArgsOptions | ((part: ChatToolPart) => string[]);
  /** A read the group header can call "read-only". Default: none is (the tag never shows). */
  isReadOnly?(part: ChatToolPart): boolean;
  /** The one-line result. Default `toolCallResult`. */
  result?(part: ChatToolPart): string | null;
}

export interface ToolCallView {
  id: string;
  /** The tool's name (`data-tool` on the row). */
  name: string;
  /** What the row calls it: `toolLabel`, else `name`. */
  label: string;
  /** A multi-action tool's `input.action`. */
  action: string | null;
  args: string[];
  state: ToolCallState;
  result: string | null;
  readOnly: boolean;
  /** A write that ran without a card under "Allow" (`ToolResult.allowed`). */
  allowed: boolean;
  input: unknown;
  output: unknown;
  errorText?: string;
}

export function toolCallView(part: ChatToolPart, opts: ToolCallOptions = {}): ToolCallView {
  const name = toolNameOf(part);
  const input = part.input as Record<string, unknown> | undefined;
  const a = input && typeof input === 'object' ? input.action : undefined;
  return {
    id: part.toolCallId,
    name,
    label: opts.toolLabel?.(name, part) || name,
    action: typeof a === 'string' && a.trim() ? a.trim() : null,
    args: typeof opts.keyArgs === 'function' ? opts.keyArgs(part) : keyArgs(part.input, opts.keyArgs),
    state: toolCallState(part),
    result: opts.result ? opts.result(part) : toolCallResult(part),
    readOnly: opts.isReadOnly?.(part) ?? false,
    allowed: (part.output as { allowed?: unknown } | null | undefined)?.allowed === true,
    input: part.input,
    output: part.output,
    errorText: part.errorText,
  };
}

export interface ToolGroupSummary {
  count: number;
  /** Every call is read-only. */
  readOnly: boolean;
  running: number;
  failed: number;
}

export function toolGroupSummary(views: readonly ToolCallView[]): ToolGroupSummary {
  return {
    count: views.length,
    readOnly: views.length > 0 && views.every(v => v.readOnly),
    running: views.filter(v => v.state === 'running').length,
    failed: views.filter(v => v.state === 'failed').length,
  };
}
