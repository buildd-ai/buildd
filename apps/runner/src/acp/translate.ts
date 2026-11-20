/**
 * Worker state -> ACP session updates, for the `buildd acp` bridge (bridge.ts).
 *
 * The runner keeps a worker's timeline as `messages` (types.ts ChatMessage):
 * a rolling window of the last 200 text / tool_use / user entries. A
 * MessageCursor turns successive snapshots of that window into the ACP
 * `session/update` payloads a client has not seen yet, so a T3 thread shows
 * the run as it happens without re-sending anything when the window shifts.
 */
import type { ChatMessage, WaitingFor } from '../types';
import type { PublicWorker } from '../public-worker';

export type ToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'other';

/** One ACP `SessionUpdate` (the `update` field of a `session/update` notification). */
export type SessionUpdate = { sessionUpdate: string; [key: string]: unknown };

const KIND_BY_TOOL: Record<string, ToolKind> = {
  Read: 'read',
  NotebookRead: 'read',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Grep: 'search',
  Glob: 'search',
  LS: 'search',
  Bash: 'execute',
  BashOutput: 'execute',
  WebFetch: 'fetch',
  WebSearch: 'fetch',
  Task: 'think',
  Agent: 'think',
  TodoWrite: 'think',
};

export function toolKind(name: string): ToolKind {
  return KIND_BY_TOOL[name] ?? 'other';
}

/** `mcp__server__tool` -> `tool`; built-in names unchanged. */
function shortToolName(name: string): string {
  const m = name.match(/^mcp__[^_]+(?:_[^_]+)*?__(.+)$/);
  return m ? m[1] : name;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** A one-line title for a tool call, the way the runner's own UI labels it. */
export function toolTitle(name: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (name === 'Bash') return clip(str(i.description) ?? str(i.command) ?? 'Bash');
  const path = str(i.file_path) ?? str(i.notebook_path) ?? str(i.path);
  if (path && KIND_BY_TOOL[name] && KIND_BY_TOOL[name] !== 'search') return `${name} ${path}`;
  const pattern = str(i.pattern) ?? str(i.query) ?? str(i.url);
  if (pattern) return clip(`${name} ${pattern}`);
  if (path) return `${name} ${path}`;
  return shortToolName(name);
}

function clip(text: string, max = 120): string {
  const line = text.split('\n')[0];
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === 'object' ? (v as Rec) : {});
const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** The file a tool call touched, for the client's "open file" affordance. */
function toolPath(input: Rec): string | null {
  return str(input.file_path) ?? str(input.notebook_path) ?? null;
}

/**
 * ACP `diff` content for an edit. The runner keeps the call's input, not the
 * file, so a diff is the replaced snippet, not the whole file: enough for the
 * client to show what changed.
 */
function toolDiffs(name: string, input: Rec): Array<Record<string, unknown>> {
  const path = toolPath(input);
  if (!path) return [];
  if (name === 'Edit') {
    const oldText = text(input.old_string);
    const newText = text(input.new_string);
    return newText === null ? [] : [{ type: 'diff', path, oldText, newText }];
  }
  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    return input.edits.flatMap((e) => {
      const r = rec(e);
      const newText = text(r.new_string);
      return newText === null ? [] : [{ type: 'diff', path, oldText: text(r.old_string), newText }];
    });
  }
  if (name === 'Write') {
    const newText = text(input.content);
    return newText === null ? [] : [{ type: 'diff', path, oldText: null, newText }];
  }
  return [];
}

const PLAN_STATUS = new Set(['pending', 'in_progress', 'completed']);

/** TodoWrite's list as an ACP plan, or null when the input is not one. */
function planFrom(input: Rec): SessionUpdate | null {
  if (!Array.isArray(input.todos)) return null;
  const entries = input.todos.flatMap((t) => {
    const r = rec(t);
    const content = str(r.content);
    if (!content) return [];
    const status = typeof r.status === 'string' && PLAN_STATUS.has(r.status) ? r.status : 'pending';
    return [{ content, priority: 'medium', status }];
  });
  return { sessionUpdate: 'plan', entries };
}

function messageKey(m: ChatMessage): string {
  const body = m.type === 'tool_use' ? `${m.name}:${safeJson(m.input)}` : m.content;
  return `${m.timestamp}|${m.type}|${body}`;
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value) ?? ''; } catch { return ''; }
}

export function textUpdate(text: string, who: 'agent' | 'user' = 'agent'): SessionUpdate {
  return {
    sessionUpdate: who === 'agent' ? 'agent_message_chunk' : 'user_message_chunk',
    content: { type: 'text', text },
  };
}

/**
 * Emits each timeline entry once. Live, the newest tool call stays
 * `in_progress` until something after it arrives (or `closeOpenTool`); in a
 * replay every tool call is already `completed`.
 */
export class MessageCursor {
  private seen = new Set<string>();
  private openTool: string | null = null;
  private toolSeq = 0;
  /** False until the cursor has taken its first snapshot (replayed or skipped). */
  started = false;

  /** Mark a snapshot as already shown, without emitting it. */
  skip(messages: ChatMessage[] | undefined): void {
    this.started = true;
    for (const m of messages ?? []) this.seen.add(messageKey(m));
  }

  next(messages: ChatMessage[] | undefined, opts: { live: boolean }): SessionUpdate[] {
    this.started = true;
    const out: SessionUpdate[] = [];
    for (const m of messages ?? []) {
      const key = messageKey(m);
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      out.push(...this.closeOpenTool());
      if (m.type === 'tool_use') {
        const input = rec(m.input);
        const plan = m.name === 'TodoWrite' ? planFrom(input) : null;
        if (plan) { out.push(plan); continue; }
        const toolCallId = `tool-${m.timestamp}-${++this.toolSeq}`;
        const path = toolPath(input);
        const diffs = toolDiffs(m.name, input);
        out.push({
          sessionUpdate: 'tool_call',
          toolCallId,
          title: toolTitle(m.name, m.input),
          kind: toolKind(m.name),
          status: opts.live ? 'in_progress' : 'completed',
          rawInput: m.input ?? {},
          ...(path ? { locations: [{ path }] } : {}),
          ...(diffs.length ? { content: diffs } : {}),
        });
        if (opts.live) this.openTool = toolCallId;
      } else if (m.content) {
        out.push(textUpdate(m.content, m.type === 'user' ? 'user' : 'agent'));
      }
    }
    return out;
  }

  closeOpenTool(): SessionUpdate[] {
    if (!this.openTool) return [];
    const toolCallId = this.openTool;
    this.openTool = null;
    return [{ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' }];
  }
}

/** Where a person's reply to this worker goes. */
export type ReplyRoute = 'answer' | 'message' | 'followup';

export function replyRoute(worker: Pick<PublicWorker, 'status'>): ReplyRoute {
  if (worker.status === 'waiting') return 'answer';
  if (worker.status === 'working') return 'message';
  return 'followup';
}

/** Anything but `working` ends a turn: the run finished, failed, or needs you. */
export function isSettled(status: string | undefined): boolean {
  return status !== 'working';
}

export function waitingText(w: WaitingFor): string {
  if (w.type === 'pause') return 'Paused. Reply here to resume it.';
  const head = w.type === 'permission' ? `**Needs permission:** ${w.prompt}` : `**Question:** ${w.prompt}`;
  const options = (w.options ?? []).map((o, i) => {
    const note = o.description ?? o.consequence;
    return `${i + 1}. ${o.label}${note ? ` — ${note}` : ''}${o.recommended ? ' (recommended)' : ''}`;
  });
  return [head, ...(w.context ? [w.context] : []), ...(options.length ? ['', ...options] : []), '', 'Reply here to answer.'].join('\n');
}

/** The line a turn ends on, when the worker's state says something. */
export function settledText(worker: PublicWorker): string | null {
  if (worker.status === 'waiting' && worker.waitingFor) return waitingText(worker.waitingFor);
  const cost = spendText(worker.spend);
  const tail = cost ? ` · ${cost}` : '';
  if (worker.status === 'done') return `${worker.prUrl ? `Finished. PR: ${worker.prUrl}` : 'Finished.'}${tail}`;
  if (worker.status === 'error') return `Stopped with an error: ${worker.error ?? 'unknown error'}${tail}`;
  if (worker.status === 'stale') return 'This run went stale. Reply to continue it.';
  return null;
}

/**
 * What the run cost, saying what kind of dollars they are (run-route.ts
 * DollarKind): a subscription run's figure is list price for its tokens, not
 * a bill, and must never read as one.
 */
export function spendText(spend: PublicWorker['spend']): string | null {
  if (!spend || !Number.isFinite(spend.usd)) return null;
  const amount = `${spend.priceUnknown ? '≈' : ''}$${spend.usd.toFixed(2)}`;
  if (spend.kind === 'plan') return `${amount} at list price (plan usage, not billed)`;
  if (spend.kind === 'billed') return `${amount} billed`;
  return `${amount} estimated`;
}

/**
 * The form a waiting question or permission request is asked as (ACP
 * `elicitation/create`, form mode). One field, `answer`: a choice when the
 * runner offers options, free text otherwise. The chosen label is exactly
 * what the runner's answer route expects (workers.ts sendMessage).
 */
export function waitingForm(w: WaitingFor): { message: string; requestedSchema: Record<string, unknown> } | null {
  if (w.type === 'pause') return null;
  const labels = (w.options ?? []).filter(o => o && typeof o.label === 'string' && o.label.trim());
  const answer: Record<string, unknown> = labels.length
    ? {
        type: 'string',
        title: w.type === 'permission' ? 'Decision' : 'Answer',
        oneOf: labels.map(o => {
          const note = o.description ?? o.consequence;
          return { const: o.label, title: o.recommended ? `${o.label} (recommended)` : o.label, ...(note ? { description: note } : {}) };
        }),
      }
    : { type: 'string', title: w.prompt };
  return {
    message: w.context ? `${w.prompt}\n\n${w.context}` : w.prompt,
    requestedSchema: { type: 'object', properties: { answer }, required: ['answer'] },
  };
}

/** Identifies one wait, so an answer is only relayed while that same wait is open. */
export function waitKey(w: WaitingFor | undefined): string | null {
  return w ? `${w.type}|${w.prompt}|${w.since ?? ''}` : null;
}

export function usageOf(worker: PublicWorker): { inputTokens: number; outputTokens: number; totalTokens: number } | undefined {
  const t = worker.tokenTally;
  if (!t) return undefined;
  return { inputTokens: t.inputTokens, outputTokens: t.outputTokens, totalTokens: t.inputTokens + t.outputTokens };
}

export const BRIDGE_COMMANDS = [
  { name: 'watch', description: 'Follow the run without sending anything' },
  { name: 'pause', description: 'Pause the run at its next safe point' },
  { name: 'stop', description: 'Stop the run' },
] as const;

export type BridgeCommand = (typeof BRIDGE_COMMANDS)[number]['name'];

export function parseCommand(text: string): BridgeCommand | null {
  const m = text.trim().match(/^\/(watch|pause|stop)$/);
  return m ? (m[1] as BridgeCommand) : null;
}
