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
        const toolCallId = `tool-${m.timestamp}-${++this.toolSeq}`;
        out.push({
          sessionUpdate: 'tool_call',
          toolCallId,
          title: toolTitle(m.name, m.input),
          kind: toolKind(m.name),
          status: opts.live ? 'in_progress' : 'completed',
          rawInput: m.input ?? {},
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
  if (worker.status === 'done') return worker.prUrl ? `Finished. PR: ${worker.prUrl}` : 'Finished.';
  if (worker.status === 'error') return `Stopped with an error: ${worker.error ?? 'unknown error'}`;
  if (worker.status === 'stale') return 'This run went stale. Reply to continue it.';
  return null;
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
