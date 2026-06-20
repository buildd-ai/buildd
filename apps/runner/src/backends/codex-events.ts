/**
 * Codex → Claude-SDK event adapter.
 *
 * `CodexBackend` streams `@openai/codex-sdk` `ThreadEvent`s. The buildd worker
 * loop's rich state tracking (`workers.ts:handleMessage`) is keyed entirely on
 * **Claude SDK message shapes** (`system:init`, `assistant`+`tool_use`,
 * `user`+`tool_result`, `result`). Codex emits `item.completed`/`turn.completed`,
 * which match nothing, so without translation channel-2 tracking is dead for
 * Codex.
 *
 * `mapCodexEventToSdkMessages` is a **pure** function that translates one Codex
 * `ThreadEvent` into zero or more Claude-shaped `SDKMessage` objects so the
 * existing `handleMessage` tracks Codex runs with no changes. It is the
 * centerpiece of Phase 1A (see docs/codex-runner-parity-plan.md).
 *
 * Mapping summary:
 *   thread.started               -> { system, subtype:init, session_id: thread_id }
 *   agent_message / reasoning    -> assistant text block
 *   command_execution            -> assistant tool_use { name:'Bash', input:{command}, id }
 *   file_change (per change)      -> tool_use add->Write, update->Edit, delete->Bash(rm)
 *   mcp_tool_call                -> tool_use { name:'mcp__'+server+'__'+tool, input:arguments, id }
 *   web_search                   -> tool_use { name:'WebSearch', input:{query}, id }
 *   todo_list                    -> nothing (R7: would trip loop detection)
 *   failed command/mcp item      -> ALSO a user tool_result block (R2) for error-trace + MCP-failure paths
 *   turn.completed / turn.started / item.started / item.updated / error -> nothing
 *
 * Notes:
 * - `result` is NOT emitted here: channel-1 `turn_complete`/`complete` already
 *   drives the loop, and codex-backend emits the synthetic `result` itself on
 *   final completion (avoids double-counting `worker.resultMeta`).
 * - Every synthetic `tool_use` carries a stable `id` derived from the Codex
 *   `item.id` so `handleMessage`'s error-trace correlation (block.tool_use_id
 *   vs stored toolCall) can match (R2).
 */

export interface CodexEventCtx {
  threadId?: string;
}

// Loose shapes — the adapter is defensive against partial/unknown payloads.
type AnyItem = Record<string, any>;
type SdkMessage = Record<string, any>;

function assistantMessage(content: any[]): SdkMessage {
  return { type: 'assistant', message: { role: 'assistant', content } };
}

function userToolResult(toolUseId: string, text: string, isError: boolean): SdkMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          ...(isError ? { is_error: true } : {}),
          content: text,
        },
      ],
    },
  };
}

/** A command is failed if it explicitly says so OR exits non-zero. */
function commandFailed(item: AnyItem): boolean {
  if (item.status === 'failed') return true;
  return typeof item.exit_code === 'number' && item.exit_code !== 0;
}

/**
 * Translate one Codex ThreadEvent into zero or more Claude-shaped SDKMessages.
 * Pure and defensive: any unrecognized event yields `[]`.
 */
export function mapCodexEventToSdkMessages(event: unknown, _ctx: CodexEventCtx): SdkMessage[] {
  if (!event || typeof event !== 'object') return [];
  const e = event as AnyItem;

  if (e.type === 'thread.started') {
    if (typeof e.thread_id !== 'string' || !e.thread_id) return [];
    return [{ type: 'system', subtype: 'init', session_id: e.thread_id }];
  }

  // Only terminal items are mapped. `item.started`/`item.updated` are in-progress
  // and would double-count if mapped (loop detection / tool-call tracking).
  if (e.type !== 'item.completed') return [];

  const item = (e.item || {}) as AnyItem;
  const id = typeof item.id === 'string' && item.id ? item.id : 'codex-item';

  switch (item.type) {
    case 'agent_message':
    case 'reasoning': {
      const text = String(item.text ?? '');
      return [assistantMessage([{ type: 'text', text }])];
    }

    case 'command_execution': {
      const out: SdkMessage[] = [
        assistantMessage([
          { type: 'tool_use', id, name: 'Bash', input: { command: String(item.command ?? '') } },
        ]),
      ];
      if (commandFailed(item)) {
        const detail =
          String(item.aggregated_output ?? '') ||
          `command failed${typeof item.exit_code === 'number' ? ` (exit ${item.exit_code})` : ''}`;
        out.push(userToolResult(id, detail, true));
      }
      return out;
    }

    case 'file_change': {
      const changes: AnyItem[] = Array.isArray(item.changes) ? item.changes : [];
      const blocks = changes.map((change, index) => {
        const path = String(change.path ?? '');
        const blockId = `${id}:${index}`;
        if (change.kind === 'add') {
          return { type: 'tool_use', id: blockId, name: 'Write', input: { file_path: path } };
        }
        if (change.kind === 'delete') {
          return { type: 'tool_use', id: blockId, name: 'Bash', input: { command: `rm ${path}` } };
        }
        // 'update' (and any unknown kind) -> Edit
        return { type: 'tool_use', id: blockId, name: 'Edit', input: { file_path: path } };
      });
      return blocks.length ? [assistantMessage(blocks)] : [];
    }

    case 'mcp_tool_call': {
      const server = String(item.server ?? 'unknown');
      const tool = String(item.tool ?? 'tool');
      const name = `mcp__${server}__${tool}`;
      // The SDK type doesn't declare an `arguments` field, but the CLI JSONL
      // emits it in practice. Carry it through when present so the PR/artifact
      // gate (which reads input.action) can match.
      const input =
        item.arguments && typeof item.arguments === 'object' ? item.arguments : {};
      const out: SdkMessage[] = [
        assistantMessage([{ type: 'tool_use', id, name, input }]),
      ];
      if (item.status === 'failed') {
        out.push(userToolResult(id, `MCP tool ${name} failed`, true));
      }
      return out;
    }

    case 'web_search': {
      return [
        assistantMessage([
          { type: 'tool_use', id, name: 'WebSearch', input: { query: String(item.query ?? '') } },
        ]),
      ];
    }

    // R7: do NOT map todo_list to a tool_use — repeated todo updates would trip
    // loop detection. Drop it (the live progress message still surfaces it in
    // codex-backend's channel-1 yield).
    case 'todo_list':
      return [];

    // Non-fatal error item: handled as a stream error by codex-backend; nothing
    // useful to map into handleMessage here.
    case 'error':
      return [];

    default:
      return [];
  }
}
